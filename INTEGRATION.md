# JSM Extend — going live: what memoli needs to provide

The app is fully built and tested in demo mode. To switch on real AI + real
payments, three sets of credentials are needed. Nothing here can be created
without memoli — all three require his own accounts.

## 1. Replicate API token (the AI)
- Go to https://replicate.com → sign in → Account → API tokens → create one.
- Model used: `fermatresearch/sdxl-outpainting-lora` (pinned version in
  `worker.js` as `REPLICATE_VERSION` — verify it's still current on the
  model's Replicate page before launch).
- Cost: ~$0.01–0.05 per extended image, billed to his Replicate account.
- Give the token to Muse via the secure credential flow; it becomes the
  worker secret `REPLICATE_API_TOKEN`. Never paste it in chat.

## 2. PayPal developer credentials (the money)
- Go to https://developer.paypal.com → log in with memoliro@gmail.com →
  Apps & Credentials → create an app (name it "JSM Extend") → copy the
  **Client ID** and **Secret** (live mode, not sandbox).
- These become worker secrets `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
- Pricing is fixed in `worker.js`: `PACKS.coffee = $5.00 → 50 credits`.
  (PayPal takes ~$0.30 + 2.9% ≈ $0.45, leaving ~$4.55 per coffee.)
- No webhook configuration needed: the app uses return-URL + capture
  (user approves on PayPal → returns to the app → worker captures the
  order and mints the single-use code).

## 3. Cloudflare deploy (the server)
- `npx wrangler login` (his Cloudflare account), then in this folder:
  - `npx wrangler d1 create jsm-extend-db` → put the database_id in
    `wrangler.toml`, then `npx wrangler d1 execute jsm-extend-db --file schema.sql`
  - `npx wrangler secret put REPLICATE_API_TOKEN`
  - `npx wrangler secret put PAYPAL_CLIENT_ID`
  - `npx wrangler secret put PAYPAL_CLIENT_SECRET`
  - Set vars in `wrangler.toml`: `APP_URL` (the live site URL),
    `PAYPAL_BASE = https://api-m.paypal.com`
  - `npx wrangler deploy`
- Then set `CONFIG.API_BASE` in `app.js` to the worker URL and redeploy
  the static site. Demo mode turns off automatically.

## Switching demo → live
In `app.js`, `CONFIG.API_BASE = ''` means demo mode. Setting it to the
worker URL enables: real Replicate outpainting, real PayPal checkout,
real single-use codes in D1. Everything else (credits UI, redeem,
paywall, theme) works identically.

## Files
- `index.html`, `style.css`, `app.js` — the static site (deploy anywhere:
  GitHub Pages, Cloudflare Pages, or his usual static host)
- `worker.js` — Cloudflare Worker (API + payments + AI)
- `schema.sql` — D1 tables (codes, orders, usage_log)
- `wrangler.toml` — still to create at deploy time (needs his D1 id)
