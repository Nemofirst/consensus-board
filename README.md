# Consensus — the crypto community board on XRPL

One global feed. Likes and XRP tips decide what rises. Built on the XRP Ledger.

## Stack

Static frontend (`index.html`) + one Netlify Function (`netlify/functions/api.mjs`) + Netlify Blobs for storage. Xaman (Xumm) handles wallet sign-in and XRP payments; tips are non-custodial (paid straight from tipper to author — the platform never holds funds).

## Deploy

1. Connect this repo to Netlify (Import from Git).
2. In Netlify → Site configuration → Environment variables, add:
   - `XUMM_API_KEY` — from your app at https://apps.xumm.dev
   - `XUMM_API_SECRET` — same page
   - `SESSION_SECRET` — any long random string
3. In your Xaman app settings (apps.xumm.dev), set the origin/redirect URL to your site URL.
4. Deploy. Without the Xaman keys the site runs in demo mode (random demo addresses, instant simulated tips) — it flips to real wallet auth automatically once the keys exist.

## API

`GET /api/feed` · `POST /api/signin` + `GET /api/signin?uuid=` · `POST /api/logout` · `POST /api/post` · `POST /api/like` · `POST /api/subscribe` · `POST /api/privacy` · `POST /api/tip` + `GET /api/tip?uuid=`

## Scaling note

Storage is single-blob JSON — perfect for validating the idea, not for heavy traffic (concurrent writes can race). When the board gets busy, swap the data layer in `api.mjs` for Postgres (e.g. Neon); the endpoints won't change.
