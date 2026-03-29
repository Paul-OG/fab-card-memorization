# FaB Card Recall Trainer

A flashcard-style study tool for the [Flesh and Blood](https://fabtcg.com) trading card game. Draw cards from a filtered pool or a Fabrary deck, recall their stats, then reveal and grade yourself.

## Features

- Filter by type, class, talent, subtype, pitch, rarity, set, and keywords
- Import any public [Fabrary](https://fabrary.net) deck by URL
- Progressive reveal — uncover card stats one at a time
- Session stats: total, correct, missed, streak
- Keyboard shortcuts: `Space` reveal, `→` next, `1` knew it, `2` missed

## Usage

Live site: **https://&lt;your-username&gt;.github.io/fab-flashcards**

### Run locally

```bash
cd static && python3 -m http.server 8000
```

Then open http://localhost:8000. No install or build step required.

## Deployment

Pushes to `main` automatically deploy to GitHub Pages via the included Actions workflow. To enable it:

1. Go to **Settings → Pages**
2. Set Source to **GitHub Actions**

## Data

Card data is fetched at runtime from the [flesh-and-blood-cards](https://github.com/the-fab-cube/flesh-and-blood-cards) dataset (~15 MB). Nothing is stored server-side.
