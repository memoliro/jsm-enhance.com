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
- Pricing is fixed in `worker.js` `PACKS`: $5.00 → 50 credits, $10.00 → 100,
  $15.00 → 150. The worker derives credits from the amount the payment
  provider reports (PayPal capture / Stripe `amount_total`), never from the
  client, so a tampered pack id can't mint wrong credits.
  (PayPal takes ~$0.30 + 2.9% per transaction.)
- No webhook configuration needed: the app uses return-URL + capture
  (user approves on PayPal → returns to the app → worker captures the
  order and mints the single-use code).

## 2b. Stripe credentials (card payments — optional but recommended)
- Go to https://dashboard.stripe.com → Developers → API keys → create a
  **restricted secret key** (live mode) with only `checkout.sessions`
  read/write permission, or use the full secret key.
- It becomes the worker secret `STRIPE_SECRET_KEY`. Never paste it in chat —
  give it to Muse via the secure credential flow.
- No webhook needed: the app uses Stripe's hosted Checkout page + return-URL
  verification (worker checks `payment_status === 'paid'` via Stripe's API
  before minting the code). `APP_URL` must be the live site URL for the
  return redirect to work.
- Stripe fee on $5: ~$0.30 + 2.9% ≈ $0.45, same as PayPal.

## 3. Cloudflare deploy (the server)
- `npx wrangler login` (his Cloudflare account), then in this folder:
  - `npx wrangler d1 create jsm-extend-db` → copy the database_id into
    `wrangler.toml` (replacing the PASTE-YOUR-D1-DATABASE-ID-HERE placeholder),
    then `npx wrangler d1 execute jsm-extend-db --file schema.sql`
  - `npx wrangler secret put REPLICATE_API_TOKEN` → paste the Replicate token
  - `npx wrangler secret put PAYPAL_CLIENT_ID` → paste the PayPal Client ID
  - `npx wrangler secret put PAYPAL_CLIENT_SECRET` → paste the PayPal Secret
  - `npx wrangler secret put STRIPE_SECRET_KEY` (only if taking card payments)
  - Check `wrangler.toml`: `APP_URL` is the live site URL
    (default: the GitHub Pages URL — change it if you use a custom domain)
  - `npx wrangler deploy` → note the worker URL it prints
    (e.g. `https://jsm-extend-api.<your-name>.workers.dev`)
- Then set `CONFIG.API_BASE` in `app.js` to that worker URL and redeploy
  the static site (push the repo). Demo mode turns off automatically.
- Then set `CONFIG.API_BASE` in `app.js` to the worker URL and redeploy
  the static site. Demo mode turns off automatically.

## Switching demo → live
In `app.js`, `CONFIG.API_BASE = ''` means demo mode. Setting it to the
worker URL enables: real Replicate outpainting, real PayPal checkout,
real single-use codes in D1. Everything else (credits UI, redeem,
paywall, theme) works identically.

## Security model (hardened 2026-10-03)

The worker owns the credit ledger — the browser never decides whether a
generation may run:

- Every `/api/extend` call must present a **wallet token**. The worker
  atomically decrements (`UPDATE wallets SET credits = credits - 1 WHERE
  token = ? AND credits > 0`) **before** calling Replicate. No valid token
  with credits → `402`, $0 GPU spent. Calling the endpoint directly with
  curl is useless.
- The browser stores only the token; the displayed balance is a copy of
  the server ledger, refreshed from `/api/balance` and after each action.
  Editing localStorage cannot create credits.
- Free trial: `/api/trial` issues 1 credit per **IP** (`CF-Connecting-IP`),
  tracked in D1 — clearing browser data does not grant another trial.
- Codes: 12-char random (`32^12` space, unguessable), single-use, burned
  atomically on redeem. Redemption tops up the caller's wallet.
- PayPal: codes are minted only after the worker verifies `COMPLETED`
  status via PayPal's API server-side. Skipping payment and calling
  `/capture` directly fails closed.
- Stripe: same — codes are minted only after the worker verifies
  `payment_status === 'paid'` via Stripe's API server-side.
- Replicate key lives only in worker secrets, never in frontend JS.
- AI failures refund the credit (`+1`) — users never pay for errors.

Remaining accepted risks: per-IP trials can be rotated with VPNs (bounded
to 1 free image each — negligible cost); digital-goods chargebacks on $5.

## Files
- `index.html`, `style.css`, `app.js` — the static site (deploy anywhere:
  GitHub Pages, Cloudflare Pages, or his usual static host)
- `worker.js` — Cloudflare Worker (API + payments + AI)
- `schema.sql` — D1 tables (codes, orders, usage_log, wallets, trials)
- `wrangler.toml` — Worker config template (fill in your D1 database_id)
