/* JSM Extend — Cloudflare Worker backend (hardened).
 *
 * SECURITY MODEL: the worker owns the credit ledger. The browser NEVER decides
 * whether a generation may run — every /api/extend and /api/sharpen call
 * must present a wallet
 * token, and credits are decremented ATOMICALLY in D1 before the GPU is touched.
 * Calling the endpoint directly with curl and no valid token = 402, $0 spent.
 *
 * Endpoints:
 *   POST /api/trial                 -> {token, credits}   (1 free credit per IP)
 *   POST /api/redeem      {code, token?} -> {token, credits} (burns single-use code, tops up wallet)
 *   GET  /api/balance?token=...    -> {credits}
 *   POST /api/paypal/create-order   {pack} -> {approval_url}
 *   POST /api/paypal/capture        {orderId} -> {code}
 *   POST /api/extend      {token, image, canvas, orig_size, orig_loc, prompt} -> {image_url, credits}
 *                         (Bria Expand: canvas_size + original placement; $0.04/run)
 *   POST /api/sharpen     {token, image, scale, face_enhance} -> {image_url, credits}
 *   POST /api/unblur      {token, image} -> {image_url, credits}
 *
 * Bindings: DB (D1). Secrets: REPLICATE_API_TOKEN, PAYPAL_CLIENT_ID,
 * PAYPAL_CLIENT_SECRET. Vars: PAYPAL_BASE, APP_URL.
 */

// (legacy) fermatresearch/sdxl-outpainting-lora — replaced by bria/expand-image, Oct 2026
const REPLICATE_VERSION = 'a542ccf352995f3c41f0bcfaef641daa3058bf2b00e08e04feb0295334ab9804';
const SHARPEN_VERSION = 'b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8'; // nightmareai/real-esrgan — restoration + upscale
const UNBLUR_VERSION = 'e116b6df8437d9c562f9de2a86cea6fd76a96705e502f091457926bbe989436c'; // megvii-research/nafnet — deblurring (pinned; the /v1/models/.../predictions shortcut only serves official models)
/* Tiered pricing. Credits are ALWAYS derived from the amount the payment
   provider reports (PayPal capture amount / Stripe amount_total) — never from
   the client — so a tampered pack id can't mint wrong credits. */
const PACKS = {
  coffee5:  { usd: '5.00',  cents: 500,  credits: 50,  label: 'JSM Extend — 50 credits' },
  coffee10: { usd: '10.00', cents: 1000, credits: 100, label: 'JSM Extend — 100 credits' },
  coffee15: { usd: '15.00', cents: 1500, credits: 150, label: 'JSM Extend — 150 credits' },
};
const packByUsd = usd => Object.values(PACKS).find(p => p.usd === usd);
const packByCents = c => Object.values(PACKS).find(p => p.cents === c);
const TRIAL_CREDITS = 1;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

function randStr(len, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}
/* base64 without blowing the call stack on large buffers */
function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
const makeCode = () => { const s = randStr(12); return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`; };
const makeToken = () => randStr(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
const clientIp = req => req.headers.get('CF-Connecting-IP') || 'unknown';

/* ---------- wallets ---------- */
async function getOrCreateWallet(env, token) {
  token = String(token || '');
  if (token) {
    const w = await env.DB.prepare('SELECT token FROM wallets WHERE token = ?').bind(token).first();
    if (w) return token;
  }
  const t = makeToken();
  await env.DB.prepare('INSERT INTO wallets (token, credits, created_at) VALUES (?, 0, ?)')
    .bind(t, Date.now()).run();
  return t;
}

/* ---------- trial: 1 free credit per IP, enforced server-side ---------- */
async function handleTrial(req, env) {
  const ip = clientIp(req);
  const seen = await env.DB.prepare('SELECT used FROM trials WHERE ip = ?').bind(ip).first();
  if (seen?.used) return json({ error: 'Trial already used' }, 403);
  const token = makeToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO trials (ip, used, created_at) VALUES (?, 1, ?)').bind(ip, now),
    env.DB.prepare('INSERT INTO wallets (token, credits, created_at) VALUES (?, ?, ?)').bind(token, TRIAL_CREDITS, now),
  ]);
  return json({ token, credits: TRIAL_CREDITS });
}

/* ---------- redeem: burn single-use code, top up wallet ---------- */
async function handleRedeem(req, env) {
  const { code, token } = await req.json().catch(() => ({}));
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return json({ error: 'Missing code' }, 400);
  const row = await env.DB.prepare('SELECT code, credits, redeemed FROM codes WHERE code = ?').bind(clean).first();
  if (!row) return json({ error: 'Unknown code.' }, 404);
  if (row.redeemed) return json({ error: 'This code was already redeemed.' }, 410);
  const wallet = await getOrCreateWallet(env, token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE codes SET redeemed = 1, redeemed_at = ? WHERE code = ? AND redeemed = 0').bind(now, clean),
    env.DB.prepare('UPDATE wallets SET credits = credits + ? WHERE token = ?').bind(row.credits, wallet),
  ]);
  const w = await env.DB.prepare('SELECT credits FROM wallets WHERE token = ?').bind(wallet).first();
  return json({ token: wallet, credits: w.credits });
}

async function handleBalance(req, env) {
  const token = new URL(req.url).searchParams.get('token') || '';
  const w = await env.DB.prepare('SELECT credits FROM wallets WHERE token = ?').bind(token).first();
  return json({ credits: w ? w.credits : 0 });
}

/* ---------- PayPal ---------- */
async function paypalToken(env) {
  const base = env.PAYPAL_BASE || 'https://api-m.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed');
  return { token: (await res.json()).access_token, base };
}

async function handleCreateOrder(req, env) {
  const { pack } = await req.json().catch(() => ({}));
  const p = PACKS[pack] || PACKS.coffee5;
  const { token, base } = await paypalToken(env);
  const res = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: p.usd }, description: p.label }],
      application_context: {
        return_url: env.APP_URL || 'https://jsm-extend.example.com/',
        cancel_url: env.APP_URL || 'https://jsm-extend.example.com/',
        user_action: 'PAY_NOW',
      },
    }),
  });
  const order = await res.json();
  if (!res.ok) return json({ error: 'PayPal order failed' }, 502);
  const approval = (order.links || []).find(l => l.rel === 'approve');
  if (!approval) return json({ error: 'No approval link' }, 502);
  await env.DB.prepare('INSERT OR IGNORE INTO orders (order_id, status, created_at) VALUES (?, ?, ?)')
    .bind(order.id, 'created', Date.now()).run();
  return json({ approval_url: approval.href, orderId: order.id });
}

async function handleCapture(req, env) {
  const { orderId } = await req.json().catch(() => ({}));
  if (!orderId) return json({ error: 'Missing orderId' }, 400);
  const existing = await env.DB.prepare(
    'SELECT o.code, c.credits FROM orders o JOIN codes c ON c.code = o.code WHERE o.order_id = ? AND o.status = ?'
  ).bind(orderId, 'captured').first();
  if (existing?.code) return json({ code: existing.code, credits: existing.credits });

  const { token, base } = await paypalToken(env);
  const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const cap = await res.json();
  // Verified server-side with PayPal: only COMPLETED payments mint codes, and
  // the credit amount comes from PayPal's reported capture amount, not the client.
  const amt = cap.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
  const p = packByUsd(amt);
  if (!res.ok || cap.status !== 'COMPLETED' || !p) return json({ error: 'Payment not completed' }, 402);

  const code = makeCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO codes (code, credits, redeemed, created_at) VALUES (?, ?, 0, ?)').bind(code, p.credits, now),
    env.DB.prepare('UPDATE orders SET status = ?, code = ? WHERE order_id = ?').bind('captured', code, orderId),
  ]);
  return json({ code, credits: p.credits });
}

/* ---------- Stripe (card payments) ----------
   Same gift-card model as PayPal: hosted Checkout -> return with session id ->
   worker verifies PAID status with Stripe's API server-side, then mints a
   single-use code. No webhooks needed. Secret key stays in worker secrets. */
async function handleStripeCreate(req, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Card payments not configured yet.' }, 503);
  const { pack } = await req.json().catch(() => ({}));
  const p = PACKS[pack] || PACKS.coffee5;
  const appUrl = env.APP_URL || 'https://jsm-extend.example.com/';
  const params = new URLSearchParams({
    // New Stripe accounts have Managed Payments on by default: it rejects
    // payment_method_types and demands product tax codes. We sell flat-price
    // credit packs, so opt this session out -> classic Checkout behavior.
    'managed_payments[enabled]': 'false',
    'payment_method_types[]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(p.cents),
    'line_items[0][price_data][product_data][name]': p.label,
    'line_items[0][quantity]': '1',
    mode: 'payment',
    success_url: appUrl + '?stripe_session={CHECKOUT_SESSION_ID}',
    cancel_url: appUrl,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok || !session.url) {
    const detail = session && session.error && session.error.message ? ' — ' + session.error.message : '';
    return json({ error: 'Stripe checkout failed' + detail }, 502);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO orders (order_id, status, created_at) VALUES (?, ?, ?)')
    .bind('stripe:' + session.id, 'created', Date.now()).run();
  return json({ checkout_url: session.url });
}

async function handleStripeVerify(req, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Card payments not configured yet.' }, 503);
  const { sessionId } = await req.json().catch(() => ({}));
  if (!sessionId) return json({ error: 'Missing sessionId' }, 400);
  const key = 'stripe:' + sessionId;
  const existing = await env.DB.prepare(
    'SELECT o.code, c.credits FROM orders o JOIN codes c ON c.code = o.code WHERE o.order_id = ? AND o.status = ?'
  ).bind(key, 'captured').first();
  if (existing?.code) return json({ code: existing.code, credits: existing.credits });

  // Verified server-side with Stripe: only PAID sessions mint codes, and the
  // credit amount comes from Stripe's reported amount_total, not the client.
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const s = await res.json();
  const p = packByCents(s.amount_total);
  if (!res.ok || s.payment_status !== 'paid' || !p) return json({ error: 'Payment not completed' }, 402);

  const code = makeCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO codes (code, credits, redeemed, created_at) VALUES (?, ?, 0, ?)').bind(code, p.credits, now),
    env.DB.prepare('UPDATE orders SET status = ?, code = ? WHERE order_id = ?').bind('captured', code, key),
  ]);
  return json({ code, credits: p.credits });
}

/* ---------- extend via Replicate (credit-gated) ---------- */
// target: { version } for a pinned model version, or { model } for an official
// model endpoint (always the latest official release, no hash to pin).
async function replicateRun(env, target, input, timeoutMs, pollMs) {
  const endpoint = target.model
    ? `https://api.replicate.com/v1/models/${target.model}/predictions`
    : 'https://api.replicate.com/v1/predictions';
  const body = target.model ? { input } : { version: target.version, input };
  const create = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!create.ok) {
    // Surface Replicate's real reason (e.g. bad field names) — invaluable when
    // wiring a new model. The body carries no secrets.
    const detail = await create.text().catch(() => '');
    throw new Error('Replicate rejected the request' + (detail ? ': ' + detail.slice(0, 300) : ''));
  }
  let pred = await create.json();
  const deadline = Date.now() + (timeoutMs || 120000);
  const interval = pollMs || 2500;
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    if (Date.now() > deadline) throw new Error('AI timed out');
    await new Promise(r => setTimeout(r, interval));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}` },
    });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') throw new Error('AI generation failed. ' + (pred.error || ''));
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  return typeof out === 'string' ? out : out.url();
}

/* ---------- shared credit-gated GPU plumbing ---------- */
// THE GATE: atomic debit. No valid token with credits -> false, $0 spent.
async function debitWallet(env, token) {
  const r = await env.DB.prepare(
    'UPDATE wallets SET credits = credits - 1 WHERE token = ? AND credits > 0'
  ).bind(String(token || '')).run();
  return r.meta.changes > 0;
}
async function refundWallet(env, token) {
  await env.DB.prepare('UPDATE wallets SET credits = credits + 1 WHERE token = ?')
    .bind(String(token)).run().catch(() => {});
}
async function walletCredits(env, token) {
  const w = await env.DB.prepare('SELECT credits FROM wallets WHERE token = ?').bind(String(token)).first();
  return w ? w.credits : 0;
}
async function logUsage(env) {
  await env.DB.prepare('INSERT INTO usage_log (created_at, credits_spent) VALUES (?, 1)').bind(Date.now()).run().catch(() => {});
}
/* Fetch a result URL through the worker and return a data: URL, so the
   browser never draws a cross-origin image to canvas (tainted canvas). */
async function fetchImageAsDataUrl(url) {
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error('Could not download the AI result');
  const buf = await imgRes.arrayBuffer();
  const ct = imgRes.headers.get('content-type') || 'image/png';
  return `data:${ct};base64,${b64encode(buf)}`;
}

/* ---------- extend via Replicate (credit-gated) ---------- */
async function handleExtend(req, env) {
  if (!env.REPLICATE_API_TOKEN) return json({ error: 'AI backend not configured yet.' }, 503);
  const { token, image, canvas, orig_size, orig_loc, prompt } = await req.json().catch(() => ({}));
  if (!image || !canvas) return json({ error: 'Missing image or canvas params' }, 400);
  const cw = canvas[0] | 0, ch = canvas[1] | 0;
  if (cw < 16 || ch < 16 || cw > 5000 || ch > 5000) return json({ error: 'Bad canvas size' }, 400);

  // curl without a token, or with an empty wallet, cannot reach the GPU.
  if (!await debitWallet(env, token)) return json({ error: 'No credits — buy more to continue.' }, 402);

  // Bria Expand: purpose-built expander. Canvas mode places our image on the
  // target canvas and generates the surroundings; $0.04/run, ~7s.
  const input = {
    image,
    canvas_size: [cw, ch],
    original_image_size: [orig_size[0] | 0, orig_size[1] | 0],
    original_image_location: [orig_loc[0] | 0, orig_loc[1] | 0],
    aspect_ratio: 'none',
    prompt: (prompt || '').slice(0, 500) || 'seamless photographic extension, continue the scene naturally in every direction, matching lighting, color grading, style and perspective',
    negative_prompt: 'visible seam, distorted, watermark, text, low quality',
  };
  try {
    const url = await replicateRun(env, { model: 'bria/expand-image' }, input);
    const image_b64 = await fetchImageAsDataUrl(url);
    await logUsage(env);
    return json({ image_b64, image_url: url, credits: await walletCredits(env, token) });
  } catch (e) {
    // Refund: the GPU never delivered, so the credit goes back.
    await refundWallet(env, token);
    return json({ error: friendlyAiError(e.message) + ' — no credit was used.' }, 502);
  }
}

/* ---------- sharpen via Replicate (credit-gated) ---------- */
async function handleSharpen(req, env) {
  if (!env.REPLICATE_API_TOKEN) return json({ error: 'AI backend not configured yet.' }, 503);
  const { token, image, scale, face_enhance } = await req.json().catch(() => ({}));
  if (!image) return json({ error: 'Missing image' }, 400);
  const sc = scale === 2 ? 2 : 4;

  if (!await debitWallet(env, token)) return json({ error: 'No credits — buy more to continue.' }, 402);

  try {
    const url = await replicateRun(
      env,
      { version: env.REPLICATE_SHARPEN_VERSION || SHARPEN_VERSION },
      { image, scale: sc, face_enhance: !!face_enhance }
    );
    const image_b64 = await fetchImageAsDataUrl(url);
    await logUsage(env);
    return json({ image_b64, image_url: url, scale: sc, credits: await walletCredits(env, token) });
  } catch (e) {
    await refundWallet(env, token);
    return json({ error: friendlyAiError(e.message) + ' — no credit was used.' }, 502);
  }
}

/* Raw infra errors (CUDA OOM etc.) are technical dumps — translate to actionable text. */
function friendlyAiError(msg) {
  msg = String(msg || '');
    if (/out of memory/i.test(msg))
    return 'The AI\u2019s GPU ran out of memory \u2014 it was already nearly full, so this is usually temporary. Wait a minute and try again; if it keeps failing, use a smaller image.';
  if (/NSFW|flagged/i.test(msg))
    return 'The AI declined this image (content filter). Try a different photo.';
  return msg;
}

/* ---------- unblur via Replicate (credit-gated) ----------
   NAFNet (megvii-research/nafnet, pinned version): faithful deblurring for
   motion/defocus blur. NAFNet cold starts can approach ~2 min, so this gets a
   longer poll deadline (wall-clock wait on fetch, not CPU — the refund path
   still protects credits).
   NOTE: the model's own field is "task_type" and its deblur value is spelled
   "Image Debluring" — the missing "r" is the model's typo, keep it. This
   pinned version offers a single general deblur task (no GoPro/REDS variants). */
async function handleUnblur(req, env) {
  if (!env.REPLICATE_API_TOKEN) return json({ error: 'AI backend not configured yet.' }, 503);
  const { token, image } = await req.json().catch(() => ({}));
  if (!image) return json({ error: 'Missing image' }, 400);

  if (!await debitWallet(env, token)) return json({ error: 'No credits — buy more to continue.' }, 402);

  try {
    const url = await replicateRun(
      env,
      { version: env.REPLICATE_UNBLUR_VERSION || UNBLUR_VERSION },
      { image, task_type: 'Image Debluring' },
      300000, // 5-min deadline for NAFNet cold starts
      10000 // poll every 10s: Cloudflare free plan allows 50 subrequests per
            // invocation, and a 2.5s poll would burn ~44 on a cold start alone
    );
    const image_b64 = await fetchImageAsDataUrl(url);
    await logUsage(env);
    return json({ image_b64, image_url: url, credits: await walletCredits(env, token) });
  } catch (e) {
    await refundWallet(env, token);
    return json({ error: friendlyAiError(e.message) + ' — no credit was used.' }, 502);
  }
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/trial' && req.method === 'POST') return handleTrial(req, env);
      if (url.pathname === '/api/redeem' && req.method === 'POST') return handleRedeem(req, env);
      if (url.pathname === '/api/balance' && req.method === 'GET') return handleBalance(req, env);
      if (url.pathname === '/api/paypal/create-order' && req.method === 'POST') return handleCreateOrder(req, env);
      if (url.pathname === '/api/paypal/capture' && req.method === 'POST') return handleCapture(req, env);
      if (url.pathname === '/api/stripe/create-checkout' && req.method === 'POST') return handleStripeCreate(req, env);
      if (url.pathname === '/api/stripe/verify' && req.method === 'POST') return handleStripeVerify(req, env);
      if (url.pathname === '/api/extend' && req.method === 'POST') return handleExtend(req, env);
      if (url.pathname === '/api/sharpen' && req.method === 'POST') return handleSharpen(req, env);
      if (url.pathname === '/api/unblur' && req.method === 'POST') return handleUnblur(req, env);
      if (url.pathname === '/api/health') return json({ ok: true, live: !!env.REPLICATE_API_TOKEN });
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      // Surface the real exception message (our own errors carry no secrets).
      // This is what diagnosed the Stripe and Replicate wiring issues.
      return json({ error: 'Server error: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
