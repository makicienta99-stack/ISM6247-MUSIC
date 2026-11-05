# SongForge — AI Music Generator (ISM6247)

A web app where anyone can type an idea and get a full song back, powered by [SunoAPI.org](https://docs.sunoapi.org/). Built for Netlify: a static front end plus one serverless function that keeps the API key secret.

## Features
- **Simple mode**: describe a song ("upbeat cumbia about Cusco markets") and Suno writes the lyrics and music.
- **Custom mode**: your own title, style tags, and lyrics, with an **✨ Write with AI** lyrics helper, excluded styles, vocal gender, style adherence, and weirdness.
- Instrumental toggle and model picker (V6, V6 Mini, V6 Wild, V5.5, V5, V4.5+).
- Two versions per request, live status, a streaming preview while the song finishes, a sticky player, MP3 download, and a lyrics view.
- Song history saved in the browser, plus the remaining credit balance in the header.
- Optional password gate so strangers can't spend your credits.

## Project layout
```
public/                 static site (index.html, styles.css, app.js)
netlify/functions/api.mjs   serverless proxy → api.sunoapi.org (routes /api/*)
netlify.toml            Netlify build config (no build step needed)
```

## Deploy on Netlify
1. In Netlify, choose **Add new site → Import an existing project**, then pick this GitHub repo and the `main` branch.
2. Build settings are read from `netlify.toml`: publish `public`, functions `netlify/functions`. Leave the build command empty.
3. Go to **Site configuration → Environment variables** and add:
   - `SUNO_API_KEY` = your SunoAPI.org key (**required**)
   - `APP_PASSWORD` = any password (*optional*, recommended for a public URL)
4. Redeploy. Open the site and make a song.

> 🔒 The API key is **not** in this repository and must never be committed. It lives only in Netlify's environment variables, and the browser only ever talks to `/api/*`.

## How it works
| App route | SunoAPI endpoint |
|---|---|
| `POST /api/generate` | `POST /api/v1/generate` |
| `GET /api/status?taskId=` | `GET /api/v1/generate/record-info` |
| `POST /api/lyrics` | `POST /api/v1/lyrics` |
| `GET /api/lyrics-status?taskId=` | `GET /api/v1/lyrics/record-info` |
| `GET /api/credits` | `GET /api/v1/generate/credit` |
| `POST /api/callback` | Receives SunoAPI's required callback (acknowledged only, since the app polls) |

Status flow: `PENDING → TEXT_SUCCESS → FIRST_SUCCESS (stream preview) → SUCCESS (MP3 ready)`. A song usually takes 1–3 minutes.

## Run locally (optional)
```bash
npm i -g netlify-cli
cp .env.example .env   # then put your key in .env
netlify dev
```
