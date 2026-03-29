from contextlib import asynccontextmanager
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import httpx
import random
import json
import re
import hmac
import hashlib
import datetime
from pathlib import Path
from typing import Optional

# card-flattened.json has image_url already merged onto each card — one file is all we need.
CARDS_URL = "https://raw.githubusercontent.com/the-fab-cube/flesh-and-blood-cards/main/json/english/card-flattened.json"
DATA_DIR = Path("data")

_cards: list = []
_filter_options: dict = {}
_loading_error: str = ""
_is_ready: bool = False

# ── Fabrary / AppSync constants ───────────────────────────────────────────────
COGNITO_IDENTITY_POOL = "us-east-2:e50f3ed7-32ed-4b22-a05e-10b3e7e03fe0"
APPSYNC_ENDPOINT = "https://42xrd23ihbd47fjvsrt27ufpfe.appsync-api.us-east-2.amazonaws.com/graphql"
AWS_REGION = "us-east-2"
FABRARY_DECK_RE = re.compile(r"/decks/([0-9A-Z]{26})", re.IGNORECASE)

# Cognito guest credential cache
_cog_creds: Optional[dict] = None
_cog_expiry: Optional[datetime.datetime] = None


# ── AWS SigV4 signing (stdlib only — no boto3 needed) ────────────────────────

def _sigv4_headers(payload: str, access_key: str, secret_key: str,
                   session_token: str) -> dict:
    service = "appsync"
    host = "42xrd23ihbd47fjvsrt27ufpfe.appsync-api.us-east-2.amazonaws.com"
    t = datetime.datetime.utcnow()
    amz_date  = t.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = t.strftime("%Y%m%d")

    payload_hash = hashlib.sha256(payload.encode()).hexdigest()
    canonical_headers = (
        f"content-type:application/json\n"
        f"host:{host}\n"
        f"x-amz-date:{amz_date}\n"
        f"x-amz-security-token:{session_token}\n"
    )
    signed_headers = "content-type;host;x-amz-date;x-amz-security-token"
    canonical_request = "\n".join([
        "POST", "/graphql", "",
        canonical_headers, signed_headers, payload_hash,
    ])

    credential_scope = f"{date_stamp}/{AWS_REGION}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, credential_scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])

    def _sign(key, msg):
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    signing_key = _sign(
        _sign(_sign(_sign(("AWS4" + secret_key).encode(), date_stamp), AWS_REGION), service),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    auth = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {
        "Content-Type": "application/json",
        "X-Amz-Date": amz_date,
        "X-Amz-Security-Token": session_token,
        "Authorization": auth,
    }


async def _get_cognito_creds() -> dict:
    """Return cached (or fresh) Cognito guest credentials."""
    global _cog_creds, _cog_expiry
    now = datetime.datetime.utcnow()
    if _cog_creds and _cog_expiry and now < _cog_expiry:
        return _cog_creds

    cog_url = f"https://cognito-identity.{AWS_REGION}.amazonaws.com/"
    async with httpx.AsyncClient(timeout=15.0) as client:
        r1 = await client.post(cog_url,
            json={"IdentityPoolId": COGNITO_IDENTITY_POOL},
            headers={"X-Amz-Target": "AWSCognitoIdentityService.GetId",
                     "Content-Type": "application/x-amz-json-1.1"})
        r1.raise_for_status()
        identity_id = r1.json()["IdentityId"]

        r2 = await client.post(cog_url,
            json={"IdentityId": identity_id},
            headers={"X-Amz-Target": "AWSCognitoIdentityService.GetCredentialsForIdentity",
                     "Content-Type": "application/x-amz-json-1.1"})
        r2.raise_for_status()
        c = r2.json()["Credentials"]

    _cog_creds = {
        "access_key": c["AccessKeyId"],
        "secret_key": c["SecretKey"],
        "session_token": c["SessionToken"],
    }
    # Expire 5 min early to be safe
    exp = c.get("Expiration")
    _cog_expiry = (
        datetime.datetime.utcfromtimestamp(exp) - datetime.timedelta(minutes=5)
        if exp else now + datetime.timedelta(minutes=55)
    )
    return _cog_creds


_DECK_QUERY = """
query getDeck($deckId: ID!) {
  getDeck(deckId: $deckId) {
    deckId name format heroIdentifier
    deckCards {
      cardIdentifier
      quantity
      card {
        name
        pitch
        cost
        power
        defense
        life
        intellect
        typeText
        types
        subtypes
        keywords
        functionalText
        defaultImage
        sets
        rarities
      }
    }
  }
}
"""

FABRARY_CDN = "https://content.fabrary.net"

def _fabrary_image_url(image: str | None) -> str | None:
    if not image:
        return None
    if image.startswith("https://"):
        return image
    return f"{FABRARY_CDN}/cards/{image}.webp"


def _normalize_fabrary_card(fc: dict, quantity: int) -> dict:
    """Normalize a card object from Fabrary's GraphQL response into our frontend format."""
    pitch_raw = fc.get("pitch")
    try:
        pitch = int(pitch_raw) if pitch_raw is not None else None
    except (ValueError, TypeError):
        pitch = None

    def _stat(v):
        v = str(v).strip() if v is not None else ""
        return v if v else None

    sets = fc.get("sets") or []
    rarities = fc.get("rarities") or []

    return {
        "name":            fc.get("name"),
        "pitch":           pitch,
        "cost":            _stat(fc.get("cost")),
        "power":           _stat(fc.get("power")),
        "defense":         _stat(fc.get("defense")),
        "health":          fc.get("life"),
        "intelligence":    fc.get("intellect"),
        "types":           (fc.get("types") or []) + (fc.get("subtypes") or []),
        "type_text":       fc.get("typeText") or "",
        "keywords":        fc.get("keywords") or [],
        "functional_text": fc.get("functionalText") or "",
        "sets":            sets,
        "set_id":          sets[0] if sets else "",
        "rarities":        rarities,
        "rarity":          rarities[0] if rarities else "",
        "image_url":       _fabrary_image_url(fc.get("defaultImage")),
        "quantity":        quantity,
    }


async def _fetch_fabrary_deck(deck_id: str) -> dict:
    creds = await _get_cognito_creds()
    payload = json.dumps({"query": _DECK_QUERY, "variables": {"deckId": deck_id}})
    headers = _sigv4_headers(payload, creds["access_key"], creds["secret_key"],
                             creds["session_token"])
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(APPSYNC_ENDPOINT, content=payload, headers=headers)
        resp.raise_for_status()
    data = resp.json()
    if "errors" in data:
        raise ValueError(data["errors"][0].get("message", "GraphQL error"))
    return data["data"]["getDeck"]

# Legality format code -> boolean field name in the JSON
async def _download_json(url: str, cache_path: Path) -> list:
    if cache_path.exists():
        print(f"[cache] {cache_path.name}")
        return json.loads(cache_path.read_text("utf-8"))
    print(f"[fetch] {url}")
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(data), encoding="utf-8")
    return data


def _normalize(card: dict) -> dict:
    """Return a normalized card dict with consistent field names and types for the frontend."""
    # pitch: "1"/"2"/"3"/"" -> int or None
    raw_pitch = card.get("pitch") or ""
    try:
        pitch = int(raw_pitch) if raw_pitch else None
    except (ValueError, TypeError):
        pitch = None

    # cost/power/defense: string or "" -> string or None
    def _stat(v):
        v = str(v).strip() if v is not None else ""
        return v if v else None

    # health/intelligence: string or "" -> int or None
    def _int_stat(v):
        try:
            return int(v)
        except (ValueError, TypeError):
            return None

    # sets: wrap single set_id in a list for frontend consistency
    set_id = card.get("set_id") or ""
    sets = [set_id] if set_id else []

    # rarity: wrap in list for frontend consistency
    rarity = card.get("rarity") or ""
    rarities = [rarity] if rarity else []

    return {
        "unique_id":       card.get("unique_id"),
        "name":            card.get("name"),
        "pitch":           pitch,
        "cost":            _stat(card.get("cost")),
        "power":           _stat(card.get("power")),
        "defense":         _stat(card.get("defense")),
        "health":          _int_stat(card.get("health")),
        "intelligence":    _int_stat(card.get("intelligence")),
        "types":           card.get("types") or [],
        "type_text":       card.get("type_text") or "",
        "keywords":        card.get("card_keywords") or [],
        "functional_text": card.get("functional_text") or "",
        "sets":            sets,
        "set_id":          set_id,
        "rarities":        rarities,
        "rarity":          rarity,
        "image_url":       card.get("image_url"),
    }


async def _load_cards():
    global _cards, _filter_options, _loading_error, _is_ready
    try:
        raw = await _download_json(CARDS_URL, DATA_DIR / "cards-flattened.json")

        # Keep only cards that have an image URL
        _cards = [_normalize(c) for c in raw if c.get("image_url")]

        _filter_options = _build_options(raw)  # build from raw for complete set/keyword coverage
        _is_ready = True
        print(f"[ready] {len(_cards)} cards with images loaded")
    except Exception as exc:
        _loading_error = str(exc)
        print(f"[error] Failed to load card data: {exc}")


def _build_options(raw_cards: list) -> dict:
    sets_cnt: dict = {}
    kws: set = set()
    rarities: set = set()
    for c in raw_cards:
        s = c.get("set_id")
        if s:
            sets_cnt[s] = sets_cnt.get(s, 0) + 1
        kws.update(k for k in (c.get("card_keywords") or []) if k)
        r = c.get("rarity")
        if r:
            rarities.add(r)
    return {
        "sets":     [{"code": k, "count": v} for k, v in sorted(sets_cnt.items())],
        "keywords": sorted(kws),
        "rarities": sorted(rarities),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _load_cards()
    yield


app = FastAPI(title="FaB Card Recall Trainer", lifespan=lifespan)


def _to_float(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _apply_filters(
    primaryType=None, classType=None, talentType=None, subtype=None,
    pitch=None, sets=None, rarity=None, keywords=None,
    costMin=None, costMax=None, powerMin=None, powerMax=None,
    defenseMin=None, defenseMax=None,
) -> list:
    pool = _cards  # already normalized

    def has_any(card_types, selected: set) -> bool:
        return bool(selected.intersection(set(card_types or [])))

    # Type filters: AND across groups, OR within each group
    if primaryType:
        s = {t.strip() for t in primaryType.split(",") if t.strip()}
        pool = [c for c in pool if has_any(c.get("types"), s)]
    if classType:
        s = {t.strip() for t in classType.split(",") if t.strip()}
        pool = [c for c in pool if has_any(c.get("types"), s)]
    if talentType:
        s = {t.strip() for t in talentType.split(",") if t.strip()}
        pool = [c for c in pool if has_any(c.get("types"), s)]
    if subtype:
        s = {t.strip() for t in subtype.split(",") if t.strip()}
        pool = [c for c in pool if has_any(c.get("types"), s)]

    # Pitch: normalized cards have pitch as int or None
    if pitch:
        ps: set = set()
        for p in pitch.split(","):
            p = p.strip()
            if p in ("null", "none", ""):
                ps.add(None)
            else:
                try:
                    ps.add(int(p))
                except ValueError:
                    pass
        pool = [c for c in pool if c.get("pitch") in ps]

    # Sets: normalized cards have sets as list with one entry
    if sets:
        sc = {s.strip() for s in sets.split(",") if s.strip()}
        pool = [c for c in pool if c.get("set_id") in sc]

    # Rarity
    if rarity:
        rc = {r.strip() for r in rarity.split(",") if r.strip()}
        pool = [c for c in pool if c.get("rarity") in rc]

    # Keywords
    if keywords:
        kc = {k.strip() for k in keywords.split(",") if k.strip()}
        pool = [c for c in pool if kc.intersection(set(c.get("keywords") or []))]

    # Numeric range filters (cost/power/defense stored as string or None in normalized cards)
    for field_name, vmin, vmax in [
        ("cost",    costMin,    costMax),
        ("power",   powerMin,   powerMax),
        ("defense", defenseMin, defenseMax),
    ]:
        mn, mx = _to_float(vmin), _to_float(vmax)
        if mn is not None or mx is not None:
            res = []
            for c in pool:
                v = _to_float(c.get(field_name))
                if v is None:
                    continue
                if mn is not None and v < mn:
                    continue
                if mx is not None and v > mx:
                    continue
                res.append(c)
            pool = res

    return pool


@app.get("/api/status")
async def api_status():
    return {
        "ready":      _is_ready,
        "card_count": len(_cards),
        "error":      _loading_error or None,
    }


@app.get("/api/filter-options")
async def api_filter_options():
    return _filter_options


@app.get("/api/card-count")
async def api_card_count(
    primaryType: Optional[str] = Query(None),
    classType:   Optional[str] = Query(None),
    talentType:  Optional[str] = Query(None),
    subtype:     Optional[str] = Query(None),
    pitch:       Optional[str] = Query(None),
    sets:        Optional[str] = Query(None),
    rarity:      Optional[str] = Query(None),
    keywords:    Optional[str] = Query(None),
    costMin:     Optional[str] = Query(None),
    costMax:     Optional[str] = Query(None),
    powerMin:    Optional[str] = Query(None),
    powerMax:    Optional[str] = Query(None),
    defenseMin:  Optional[str] = Query(None),
    defenseMax:  Optional[str] = Query(None),
):
    pool = _apply_filters(
        primaryType, classType, talentType, subtype,
        pitch, sets, rarity, keywords,
        costMin, costMax, powerMin, powerMax, defenseMin, defenseMax,
    )
    return {"count": len(pool)}


@app.get("/api/random-card")
async def api_random_card(
    primaryType: Optional[str] = Query(None),
    classType:   Optional[str] = Query(None),
    talentType:  Optional[str] = Query(None),
    subtype:     Optional[str] = Query(None),
    pitch:       Optional[str] = Query(None),
    sets:        Optional[str] = Query(None),
    rarity:      Optional[str] = Query(None),
    keywords:    Optional[str] = Query(None),
    costMin:     Optional[str] = Query(None),
    costMax:     Optional[str] = Query(None),
    powerMin:    Optional[str] = Query(None),
    powerMax:    Optional[str] = Query(None),
    defenseMin:  Optional[str] = Query(None),
    defenseMax:  Optional[str] = Query(None),
):
    if not _is_ready:
        return JSONResponse(
            status_code=503,
            content={"error": "Card data is still loading, please wait..."},
        )

    pool = _apply_filters(
        primaryType, classType, talentType, subtype,
        pitch, sets, rarity, keywords,
        costMin, costMax, powerMin, powerMax, defenseMin, defenseMax,
    )

    if not pool:
        return JSONResponse(
            status_code=404,
            content={"error": "No cards match the current filters. Try broadening your selection."},
        )

    return random.choice(pool)


@app.get("/api/deck")
async def api_deck(url: str = Query(..., description="Fabrary deck URL")):
    """Fetch a public Fabrary deck and return its cards matched against our dataset."""
    m = FABRARY_DECK_RE.search(url)
    if not m:
        return JSONResponse(status_code=400,
                            content={"error": "Not a valid Fabrary deck URL. "
                                              "Expected https://fabrary.net/decks/<ID>"})
    deck_id = m.group(1)
    try:
        deck = await _fetch_fabrary_deck(deck_id)
    except Exception as exc:
        return JSONResponse(status_code=502,
                            content={"error": f"Could not fetch deck from Fabrary: {exc}"})

    cards, missing = [], []
    for dc in deck.get("deckCards") or []:
        fc = dc.get("card")
        if fc and fc.get("defaultImage"):
            cards.append(_normalize_fabrary_card(fc, dc["quantity"]))
        else:
            missing.append(dc["cardIdentifier"])

    total_qty = sum(c["quantity"] for c in cards)
    return {
        "deckId":        deck["deckId"],
        "name":          deck.get("name", ""),
        "format":        deck.get("format", ""),
        "heroIdentifier": deck.get("heroIdentifier", ""),
        "cards":         cards,
        "missingCards":  missing,
        "cardCount":     total_qty,
    }


# Static files mounted last so API routes take precedence
app.mount("/", StaticFiles(directory="docs", html=True), name="docs")
