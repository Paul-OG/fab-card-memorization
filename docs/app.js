'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const CARDS_URL = 'https://raw.githubusercontent.com/the-fab-cube/flesh-and-blood-cards/main/json/english/card-flattened.json';

const COGNITO_IDENTITY_POOL = 'us-east-2:e50f3ed7-32ed-4b22-a05e-10b3e7e03fe0';
const APPSYNC_ENDPOINT = 'https://42xrd23ihbd47fjvsrt27ufpfe.appsync-api.us-east-2.amazonaws.com/graphql';
const AWS_REGION = 'us-east-2';
const FABRARY_CDN = 'https://content.fabrary.net';
const FABRARY_DECK_RE = /\/decks\/([0-9A-Z]{26})/i;

const PRIMARY_TYPES = [
  'Hero', 'Attack Action', 'Non-Attack Action', 'Attack Reaction',
  'Defense Reaction', 'Instant', 'Equipment', 'Weapon',
  'Resource', 'Token', 'Mentor', 'Block', 'Action',
];

const CLASS_TYPES = [
  'Generic', 'Brute', 'Guardian', 'Ninja', 'Warrior', 'Mechanologist',
  'Ranger', 'Runeblade', 'Wizard', 'Illusionist', 'Assassin', 'Bard',
  'Adjudicator', 'Merchant', 'Shapeshifter',
];

const TALENT_TYPES = [
  'Light', 'Shadow', 'Elemental', 'Earth', 'Ice', 'Lightning',
  'Royal', 'Draconic', 'Mystic',
];

const SUBTYPE_TYPES = [
  'Aura', 'Item', 'Ally', 'Landmark', 'Affliction',
  'Construct', 'Figment', 'Invocation', 'Ash',
];

const RARITY_LABELS = {
  C: 'Common', R: 'Rare', S: 'Super Rare', M: 'Majestic',
  L: 'Legendary', F: 'Fabled', T: 'Token', P: 'Promo',
};

// ── Card data ─────────────────────────────────────────────────────────────────

let _cards = [];
let _filterOptions = {};

function _normalizeStat(v) {
  v = (v != null) ? String(v).trim() : '';
  return v || null;
}

function _normalizeIntStat(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function _normalizeCard(card) {
  const rawPitch = card.pitch || '';
  const pitch = rawPitch ? (parseInt(rawPitch, 10) || null) : null;
  const setId = card.set_id || '';
  const rarity = card.rarity || '';
  return {
    unique_id:       card.unique_id,
    name:            card.name,
    pitch,
    cost:            _normalizeStat(card.cost),
    power:           _normalizeStat(card.power),
    defense:         _normalizeStat(card.defense),
    health:          _normalizeIntStat(card.health),
    intelligence:    _normalizeIntStat(card.intelligence),
    types:           card.types || [],
    type_text:       card.type_text || '',
    keywords:        card.card_keywords || [],
    functional_text: card.functional_text || '',
    sets:            setId ? [setId] : [],
    set_id:          setId,
    rarities:        rarity ? [rarity] : [],
    rarity,
    image_url:       card.image_url,
  };
}

function _buildFilterOptions(rawCards) {
  const setsCount = {};
  const kws = new Set();
  const rarities = new Set();
  for (const c of rawCards) {
    const s = c.set_id;
    if (s) setsCount[s] = (setsCount[s] || 0) + 1;
    for (const k of (c.card_keywords || [])) { if (k) kws.add(k); }
    if (c.rarity) rarities.add(c.rarity);
  }
  return {
    sets:     Object.entries(setsCount).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    keywords: [...kws].sort(),
    rarities: [...rarities].sort(),
  };
}

async function loadCards() {
  els.loadingMsg.textContent = 'Downloading card data (~15 MB)…';
  const resp = await fetch(CARDS_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  els.loadingMsg.textContent = 'Processing cards…';
  const raw = await resp.json();
  _cards = raw.filter(c => c.image_url).map(_normalizeCard);
  _filterOptions = _buildFilterOptions(raw);
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function applyFilters() {
  let pool = _cards;

  if (filters.primaryType.size) pool = pool.filter(c => [...filters.primaryType].some(t => c.types.includes(t)));
  if (filters.classType.size)   pool = pool.filter(c => [...filters.classType].some(t => c.types.includes(t)));
  if (filters.talentType.size)  pool = pool.filter(c => [...filters.talentType].some(t => c.types.includes(t)));
  if (filters.subtype.size)     pool = pool.filter(c => [...filters.subtype].some(t => c.types.includes(t)));

  if (filters.pitch.size) {
    const pitchVals = new Set();
    for (const p of filters.pitch) {
      if (p === 'null') pitchVals.add(null);
      else { const n = parseInt(p, 10); if (!isNaN(n)) pitchVals.add(n); }
    }
    pool = pool.filter(c => pitchVals.has(c.pitch));
  }

  if (filters.sets.size)     pool = pool.filter(c => filters.sets.has(c.set_id));
  if (filters.rarity.size)   pool = pool.filter(c => filters.rarity.has(c.rarity));
  if (filters.keywords.size) pool = pool.filter(c => c.keywords.some(k => filters.keywords.has(k)));

  return pool;
}

// ── AWS / Fabrary ─────────────────────────────────────────────────────────────

let _cogCreds = null;
let _cogExpiry = 0;

async function _getCognitoCreds() {
  if (_cogCreds && Date.now() < _cogExpiry) return _cogCreds;

  const cogUrl = `https://cognito-identity.${AWS_REGION}.amazonaws.com/`;

  const r1 = await fetch(cogUrl, {
    method: 'POST',
    headers: { 'X-Amz-Target': 'AWSCognitoIdentityService.GetId', 'Content-Type': 'application/x-amz-json-1.1' },
    body: JSON.stringify({ IdentityPoolId: COGNITO_IDENTITY_POOL }),
  });
  if (!r1.ok) throw new Error(`Cognito GetId failed: ${r1.status}`);
  const { IdentityId } = await r1.json();

  const r2 = await fetch(cogUrl, {
    method: 'POST',
    headers: { 'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity', 'Content-Type': 'application/x-amz-json-1.1' },
    body: JSON.stringify({ IdentityId }),
  });
  if (!r2.ok) throw new Error(`Cognito GetCredentials failed: ${r2.status}`);
  const { Credentials: c } = await r2.json();

  _cogCreds = { accessKey: c.AccessKeyId, secretKey: c.SecretKey, sessionToken: c.SessionToken };
  _cogExpiry = c.Expiration ? (c.Expiration * 1000 - 5 * 60 * 1000) : (Date.now() + 55 * 60 * 1000);
  return _cogCreds;
}

async function _sha256Hex(message) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
}

async function _sigv4Headers(payload, accessKey, secretKey, sessionToken) {
  const service = 'appsync';
  const host = '42xrd23ihbd47fjvsrt27ufpfe.appsync-api.us-east-2.amazonaws.com';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await _sha256Hex(payload);
  const canonicalHeaders =
    `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${sessionToken}\n`;
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-security-token';
  const canonicalRequest = ['POST', '/graphql', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${AWS_REGION}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await _sha256Hex(canonicalRequest)].join('\n');

  let signingKey = new TextEncoder().encode('AWS4' + secretKey);
  for (const msg of [dateStamp, AWS_REGION, service, 'aws4_request']) {
    signingKey = await _hmac(signingKey, msg);
  }
  const sigBytes = await _hmac(signingKey, stringToSign);
  const signature = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    'X-Amz-Security-Token': sessionToken,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const _DECK_QUERY = `
query getDeck($deckId: ID!) {
  getDeck(deckId: $deckId) {
    deckId name format heroIdentifier
    deckCards {
      cardIdentifier
      quantity
      card {
        name pitch cost power defense life intellect
        typeText types subtypes keywords functionalText
        defaultImage sets rarities
      }
    }
  }
}`;

function _fabraryImageUrl(image) {
  if (!image) return null;
  if (image.startsWith('https://')) return image;
  return `${FABRARY_CDN}/cards/${image}.webp`;
}

function _normalizeFabraryCard(fc, quantity) {
  const pitch = fc.pitch != null ? (parseInt(fc.pitch, 10) || null) : null;
  const sets = fc.sets || [];
  const rarities = fc.rarities || [];
  return {
    name:            fc.name,
    pitch,
    cost:            _normalizeStat(fc.cost),
    power:           _normalizeStat(fc.power),
    defense:         _normalizeStat(fc.defense),
    health:          fc.life,
    intelligence:    fc.intellect,
    types:           [...(fc.types || []), ...(fc.subtypes || [])],
    type_text:       fc.typeText || '',
    keywords:        fc.keywords || [],
    functional_text: fc.functionalText || '',
    sets,
    set_id:          sets[0] || '',
    rarities,
    rarity:          rarities[0] || '',
    image_url:       _fabraryImageUrl(fc.defaultImage),
    quantity,
  };
}

async function _fetchFabraryDeck(deckId) {
  const creds = await _getCognitoCreds();
  const payload = JSON.stringify({ query: _DECK_QUERY, variables: { deckId } });
  const headers = await _sigv4Headers(payload, creds.accessKey, creds.secretKey, creds.sessionToken);
  const resp = await fetch(APPSYNC_ENDPOINT, { method: 'POST', headers, body: payload });
  if (!resp.ok) throw new Error(`AppSync HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
  return data.data.getDeck;
}

// ── State ─────────────────────────────────────────────────────────────────────

const filters = {
  primaryType: new Set(),
  classType:   new Set(),
  talentType:  new Set(),
  subtype:     new Set(),
  pitch:       new Set(),
  sets:        new Set(),
  rarity:      new Set(),
  keywords:    new Set(),
};

const session = { total: 0, correct: 0, missed: 0, streak: 0, bestStreak: 0 };

let currentCard = null;
let phase = 'idle';           // idle | loading | hidden | revealed
let revealedCount = 0;
let poolCountTimer = null;

// Deck mode
let deckMode = false;
let deckCards = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  loadingScreen:   $('loading-screen'),
  loadingMsg:      $('loading-msg'),
  app:             $('app'),

  sidebarBackdrop: $('sidebar-backdrop'),
  sidebar:         $('sidebar'),
  openSidebar:     $('open-sidebar'),
  closeSidebar:    $('close-sidebar'),

  poolCount:       $('pool-count'),
  emptyPoolCount:  $('empty-pool-count'),
  clearFilters:    $('clear-filters'),

  emptyState:      $('empty-state'),
  cardView:        $('card-view'),
  cardFrame:       $('card-frame'),
  cardLoading:     $('card-loading'),

  cardImg:         $('card-img'),
  cardOverlay:     $('card-overlay'),

  ctrlPre:         $('ctrl-pre'),
  ctrlPost:        $('ctrl-post'),
  btnReveal:       $('btn-reveal'),
  btnSkip:         $('btn-skip'),
  btnKnew:         $('btn-knew'),
  btnMiss:         $('btn-miss'),
  btnNext:         $('btn-next'),

  statsPanel:      $('stats-panel'),

  stTotal:         $('st-total'),
  stCorrect:       $('st-correct'),
  stMissed:        $('st-missed'),
  stStreak:        $('st-streak'),

  drawFirstBtn:    $('draw-first-btn'),

  deckUrlInput:    $('deck-url-input'),
  deckLoadBtn:     $('deck-load-btn'),
  deckClearBtn:    $('deck-clear-btn'),
  deckError:       $('deck-error'),
  deckInfo:        $('deck-info'),
  deckInfoName:    $('deck-info-name'),
  deckInfoMeta:    $('deck-info-meta'),
  poolLabel:       document.querySelector('.pool-label'),
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function showToast(msg, duration = 4000) {
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'error-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function simpleMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

// ── Pool count ────────────────────────────────────────────────────────────────

function updatePoolCount() {
  if (!_cards.length) return;
  const count = deckMode ? deckCards.length : applyFilters().length;
  els.poolCount.textContent = count.toLocaleString();
  els.emptyPoolCount.textContent = count.toLocaleString();
}

function schedulePoolUpdate() {
  clearTimeout(poolCountTimer);
  poolCountTimer = setTimeout(updatePoolCount, 300);
}

// ── Filter UI ─────────────────────────────────────────────────────────────────

function makeCheckboxItem(value, label, filterKey) {
  const item = document.createElement('label');
  item.className = 'cb-item';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = value;
  cb.addEventListener('change', () => {
    if (cb.checked) {
      filters[filterKey].add(value);
      item.classList.add('checked');
    } else {
      filters[filterKey].delete(value);
      item.classList.remove('checked');
    }
    updateBadge(filterKey);
    schedulePoolUpdate();
  });
  item.appendChild(cb);
  item.appendChild(document.createTextNode(label));
  return item;
}

function populateCheckboxGroup(containerId, items, filterKey) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (const { value, label } of items) {
    container.appendChild(makeCheckboxItem(value, label, filterKey));
  }
}

function updateBadge(filterKey) {
  const badge = $('badge-' + filterKey);
  if (!badge) return;
  const count = filters[filterKey]?.size ?? 0;
  badge.textContent = count;
  badge.classList.toggle('visible', count > 0);
}

function populateFilterGroups(opts) {
  populateCheckboxGroup('fg-primaryType', PRIMARY_TYPES.map(t => ({ value: t, label: t })), 'primaryType');
  populateCheckboxGroup('fg-classType', CLASS_TYPES.map(t => ({ value: t, label: t })), 'classType');
  populateCheckboxGroup('fg-talentType', TALENT_TYPES.map(t => ({ value: t, label: t })), 'talentType');
  populateCheckboxGroup('fg-subtype', SUBTYPE_TYPES.map(t => ({ value: t, label: t })), 'subtype');

  const rarities = opts.rarities || ['C', 'R', 'S', 'M', 'L', 'F', 'T', 'P'];
  populateCheckboxGroup(
    'fg-rarity',
    rarities.map(r => ({ value: r, label: RARITY_LABELS[r] || r })),
    'rarity',
  );

  populateDynamicList('fg-sets', 'set-search', opts.sets || [], 'sets',
    s => `${s.code} (${s.count})`, s => s.code);
  populateDynamicList('fg-keywords', 'kw-search', opts.keywords || [], 'keywords',
    k => k, k => k);
}

function populateDynamicList(containerId, searchId, items, filterKey, labelFn, valueFn) {
  const container = $(containerId);
  const search = $(searchId);
  if (!container) return;

  function render(query) {
    const q = query.toLowerCase().trim();
    container.innerHTML = '';
    const filtered = q ? items.filter(i => labelFn(i).toLowerCase().includes(q)) : items;
    for (const item of filtered) {
      const value = valueFn(item);
      const label = labelFn(item);
      const el = makeCheckboxItem(value, label, filterKey);
      const cb = el.querySelector('input');
      if (filters[filterKey].has(value)) {
        cb.checked = true;
        el.classList.add('checked');
      }
      container.appendChild(el);
    }
  }

  render('');
  if (search) search.addEventListener('input', e => render(e.target.value));
}

// ── Filter group collapse/expand ──────────────────────────────────────────────

function setupFilterGroups() {
  document.querySelectorAll('.filter-group .fg-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.filter-group').classList.toggle('collapsed');
    });
  });
}

// ── Pitch filter buttons ───────────────────────────────────────────────────────

function setupPitchButtons() {
  document.querySelectorAll('.pitch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.pitch;
      if (filters.pitch.has(val)) {
        filters.pitch.delete(val);
        btn.classList.remove('active');
      } else {
        filters.pitch.add(val);
        btn.classList.add('active');
      }
      updateBadge('pitch');
      schedulePoolUpdate();
    });
  });
}

// ── Clear filters ─────────────────────────────────────────────────────────────

function clearAllFilters() {
  for (const key of Object.keys(filters)) filters[key].clear();

  document.querySelectorAll('.cb-item input[type=checkbox]').forEach(cb => {
    cb.checked = false;
    cb.closest('.cb-item')?.classList.remove('checked');
  });
  document.querySelectorAll('.pitch-btn').forEach(btn => btn.classList.remove('active'));
  Object.keys(filters).forEach(updateBadge);
  schedulePoolUpdate();
}

// ── Card lifecycle ────────────────────────────────────────────────────────────

async function drawCard() {
  if (phase === 'loading') return;
  phase = 'loading';

  els.emptyState.hidden  = true;
  els.cardView.hidden    = false;
  els.cardFrame.hidden   = true;
  els.cardLoading.hidden = false;
  els.ctrlPre.hidden     = true;
  els.ctrlPost.hidden    = true;
  els.statsPanel.hidden  = true;

  let data;
  if (deckMode && deckCards.length > 0) {
    data = deckCards[Math.floor(Math.random() * deckCards.length)];
  } else {
    const pool = applyFilters();
    if (!pool.length) {
      showToast('No cards match the current filters. Try broadening your selection.');
      phase = 'idle';
      els.cardLoading.hidden = true;
      return;
    }
    data = pool[Math.floor(Math.random() * pool.length)];
  }
  currentCard = data;
  showCard(data);
}

// ── Deck import ───────────────────────────────────────────────────────────────

async function loadDeck() {
  const url = els.deckUrlInput.value.trim();
  if (!url) return;

  els.deckError.hidden     = true;
  els.deckLoadBtn.disabled = true;
  els.deckLoadBtn.textContent = 'Loading…';

  try {
    const m = url.match(FABRARY_DECK_RE);
    if (!m) {
      els.deckError.textContent = 'Not a valid Fabrary deck URL. Expected https://fabrary.net/decks/<ID>';
      els.deckError.hidden = false;
      return;
    }

    const deck = await _fetchFabraryDeck(m[1]);
    const cards = [];
    const missing = [];
    for (const dc of (deck.deckCards || [])) {
      const fc = dc.card;
      if (fc && fc.defaultImage) {
        cards.push(_normalizeFabraryCard(fc, dc.quantity));
      } else {
        missing.push(dc.cardIdentifier);
      }
    }

    deckCards = [];
    for (const card of cards) {
      for (let i = 0; i < (card.quantity || 1); i++) deckCards.push(card);
    }

    deckMode = true;
    const totalCards = deckCards.length;
    els.deckInfo.hidden          = false;
    els.deckInfoName.textContent = deck.name || 'Unnamed Deck';
    els.deckInfoMeta.textContent =
      `${deck.format || '?'} · ${totalCards} cards` +
      (missing.length ? ` · ${missing.length} not found` : '');
    els.deckClearBtn.hidden = false;
    els.poolLabel.classList.add('deck-mode');
    els.poolCount.textContent = totalCards;
    els.emptyPoolCount.textContent = totalCards;

    if (missing.length) showToast(`${missing.length} card(s) not matched in local dataset`, 6000);
  } catch (err) {
    els.deckError.textContent = `Could not fetch deck from Fabrary: ${err.message}`;
    els.deckError.hidden = false;
  } finally {
    els.deckLoadBtn.disabled = false;
    els.deckLoadBtn.textContent = 'Load Deck';
  }
}

function clearDeck() {
  deckMode  = false;
  deckCards = [];
  els.deckInfo.hidden     = true;
  els.deckClearBtn.hidden = true;
  els.deckUrlInput.value  = '';
  els.deckError.hidden    = true;
  els.poolLabel.classList.remove('deck-mode');
  updatePoolCount();
}

function showCard(card) {
  els.cardOverlay.classList.remove('revealed');
  els.cardImg.onload  = null;
  els.cardImg.onerror = null;
  els.cardImg.src     = '';

  els.cardImg.onload = () => {
    phase = 'hidden';
    revealedCount = 0;
    els.cardLoading.hidden = true;
    els.cardFrame.hidden   = false;
    els.ctrlPre.hidden     = false;
    els.ctrlPost.hidden    = true;
    resetOverlay();
    renderStatsPanel(currentCard, 0);
    els.statsPanel.hidden  = false;
  };

  els.cardImg.onerror = () => { drawCard(); };
  els.cardImg.src = card.image_url;
}

function revealCard() {
  if (phase !== 'hidden') return;

  const rows = buildRows(currentCard);
  revealedCount++;
  renderStatsPanel(currentCard, revealedCount);

  if (revealedCount <= rows.length) {
    hideOverlayForKey(rows[revealedCount - 1].key);
  }

  if (revealedCount >= rows.length) {
    hideAllOverlay();
    phase = 'revealed';
    els.ctrlPre.hidden  = true;
    els.ctrlPost.hidden = false;
  }
}

function gradeCard(knew) {
  session.total++;
  if (knew) {
    session.correct++;
    session.streak++;
    if (session.streak > session.bestStreak) session.bestStreak = session.streak;
  } else {
    session.missed++;
    session.streak = 0;
  }
  updateSessionStats();
  drawCard();
}

function skipCard() { drawCard(); }

// ── Overlay ───────────────────────────────────────────────────────────────────

const OVERLAY_IDS = [
  'ovl-pitch', 'ovl-name-bar', 'ovl-cost',
  'ovl-bottom-type', 'ovl-bottom-atk', 'ovl-bottom-def', 'ovl-bottom-text',
];

const OVERLAY_MAP = {
  'Name':         'ovl-name-bar',
  'Type':         'ovl-bottom-type',
  'Power':        'ovl-bottom-atk',
  'Health':       'ovl-bottom-atk',
  'Defense':      'ovl-bottom-def',
  'Intelligence': 'ovl-bottom-def',
  'Cost':         'ovl-cost',
  'Pitch':        'ovl-pitch',
  'Text':         'ovl-bottom-text',
};

function resetOverlay() {
  for (const id of OVERLAY_IDS) document.getElementById(id)?.classList.remove('hidden');
}

function hideOverlayForKey(key) {
  const id = OVERLAY_MAP[key];
  if (id) document.getElementById(id)?.classList.add('hidden');
}

function hideAllOverlay() {
  for (const id of OVERLAY_IDS) document.getElementById(id)?.classList.add('hidden');
}

// ── Stats panel ───────────────────────────────────────────────────────────────

const PITCH_LABELS = { 1: 'Red · 1', 2: 'Yellow · 2', 3: 'Blue · 3' };

function buildRows(card) {
  const rows = [];
  if (card.name)                 rows.push({ key: 'Name',         val: card.name });
  if (card.type_text)            rows.push({ key: 'Type',         val: card.type_text });
  if (card.power != null)        rows.push({ key: 'Power',        val: card.power });
  if (card.defense != null)      rows.push({ key: 'Defense',      val: card.defense });
  if (card.cost != null)         rows.push({ key: 'Cost',         val: card.cost });
  if (card.pitch != null)        rows.push({ key: 'Pitch',        val: PITCH_LABELS[card.pitch] || 'No Pitch' });
  if (card.health != null)       rows.push({ key: 'Health',       val: card.health });
  if (card.intelligence != null) rows.push({ key: 'Intelligence', val: card.intelligence });
  if (card.functional_text)      rows.push({ key: 'Text',         val: card.functional_text, markdown: true });
  return rows;
}

function renderStatsPanel(card, revealed) {
  const rows = buildRows(card);
  els.statsPanel.innerHTML = '';
  rows.forEach((row, i) => {
    const { key, val, markdown } = row;
    const div = document.createElement('div');
    div.className = 'kv-row';
    const k = document.createElement('span');
    k.className = 'kv-key';
    k.textContent = key;
    const v = document.createElement('span');
    if (i < revealed) {
      v.className = 'kv-val';
      if (markdown) v.innerHTML = simpleMarkdown(String(val));
      else          v.textContent = String(val);
    } else {
      v.className = 'kv-val kv-hidden';
      v.textContent = '?';
    }
    div.appendChild(k);
    div.appendChild(v);
    els.statsPanel.appendChild(div);
  });
}

// ── Session stats ─────────────────────────────────────────────────────────────

function updateSessionStats() {
  els.stTotal.textContent   = session.total;
  els.stCorrect.textContent = session.correct;
  els.stMissed.textContent  = session.missed;
  els.stStreak.textContent  = session.streak;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function openSidebar() {
  els.sidebar.classList.add('open');
  els.sidebarBackdrop.classList.add('visible');
}

function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.sidebarBackdrop.classList.remove('visible');
}

// ── Event listeners ───────────────────────────────────────────────────────────

function setupEvents() {
  els.openSidebar.addEventListener('click', openSidebar);
  els.closeSidebar.addEventListener('click', closeSidebar);
  els.sidebarBackdrop.addEventListener('click', closeSidebar);

  els.clearFilters.addEventListener('click', clearAllFilters);

  els.deckLoadBtn.addEventListener('click', loadDeck);
  els.deckClearBtn.addEventListener('click', clearDeck);
  els.deckUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadDeck(); });

  els.drawFirstBtn.addEventListener('click', drawCard);
  els.btnReveal.addEventListener('click', revealCard);
  els.btnSkip.addEventListener('click', skipCard);
  els.btnKnew.addEventListener('click', () => gradeCard(true));
  els.btnMiss.addEventListener('click', () => gradeCard(false));
  els.btnNext.addEventListener('click', drawCard);

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (phase === 'hidden') revealCard();
      else if (phase === 'idle') drawCard();
    }
    if (e.code === 'ArrowRight' && phase === 'revealed') {
      e.preventDefault();
      drawCard();
    }
    if (e.key === '1' && phase === 'revealed') gradeCard(true);
    if (e.key === '2' && phase === 'revealed') gradeCard(false);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    await loadCards();
  } catch (err) {
    els.loadingMsg.textContent = `Error loading cards: ${err.message}`;
    els.loadingMsg.style.color = 'var(--red)';
    return;
  }

  els.loadingScreen.style.display = 'none';
  els.app.hidden = false;

  populateFilterGroups(_filterOptions);
  setupFilterGroups();
  setupPitchButtons();
  setupEvents();
  updatePoolCount();
}

init();
