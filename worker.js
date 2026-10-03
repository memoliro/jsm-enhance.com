/* JSM Extend — Cloudflare Worker backend.
 *
 * Endpoints:
 *   POST /api/redeem               {code} -> {credits}            (burns single-use code)
 *   POST /api/paypal/create-order  {pack} -> {approval_url}
 *   POST /api/paypal/capture       {orderId} -> {code}
 *   POST /api/extend               {image, outpaint:{left,right,up,down}, prompt} -> {image_url}
 *
 * Bindings: DB (D1). Secrets: REPLICATE_API_TOKEN, PAYPAL_CLIENT_ID,
 * PAYPAL_CLIENT_SECRET. Vars: PAYPAL_BASE, APP_URL, REPLICATE_MODEL_VERSION.
 */

const REPLICATE_VERSION = 'a542ccf352995f3c41f0bcfaef641daa3058bf2b00e08e04feb0295334ab9804'; // fermatresearch/sdxl-outpainting-lora — verify current before prod
const PACKS = { coffee: { usd: '5.00', credits: 50, label: 'JSM Extend — 50 credits' } };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

function makeCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) s += a[buf[i] % a.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
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
  const p = PACKS[pack || 'coffee'];
  if (!p) return json({ error: 'Unknown pack' }, 400);
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
  // Idempotency: already captured -> return existing code
  const existing = await env.DB.prepare('SELECT code FROM orders WHERE order_id = ? AND status = ?')
    .bind(orderId, 'captured').first();
  if (existing?.code) return json({ code: existing.code, credits: PACKS.coffee.credits });

  const { token, base } = await paypalToken(env);
  const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const cap = await res.json();
  if (!res.ok || cap.status !== 'COMPLETED') return json({ error: 'Payment not completed' }, 402);

  const code = makeCode();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO codes (code, credits, redeemed, created_at) VALUES (?, ?, 0, ?)')
      .bind(code, PACKS.coffee.credits, now),
    env.DB.prepare('UPDATE orders SET status = ?, code = ? WHERE order_id = ?')
      .bind('captured', code, orderId),
  ]);
  return json({ code, credits: PACKS.coffee.credits });
}

/* ---------- redeem ---------- */
async function handleRedeem(req, env) {
  const { code } = await req.json().catch(() => ({}));
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return json({ error: 'Missing code' }, 400);
  const row = await env.DB.prepare('SELECT code, credits, redeemed FROM codes WHERE code = ?').bind(clean).first();
  if (!row) return json({ error: 'Unknown code.' }, 404);
  if (row.redeemed) return json({ error: 'This code was already redeemed.' }, 410);
  await env.DB.prepare('UPDATE codes SET redeemed = 1, redeemed_at = ? WHERE code = ?')
    .bind(Date.now(), clean).run();
  return json({ credits: row.credits });
}

/* ---------- extend via Replicate ---------- */
async function replicatePrediction(env, input) {
  const create = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: env.REPLICATE_MODEL_VERSION || REPLICATE_VERSION, input }),
  });
  if (!create.ok) throw new Error('Replicate rejected the request');
  let pred = await create.json();
  const deadline = Date.now() + 120000;
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    if (Date.now() > deadline) throw new Error('AI timed out — no credit was used');
    await new Promise(r => setTimeout(r, 2500));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { 'Authorization': `Token ${env.REPLICATE_API_TOKEN}` },
    });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') throw new Error('AI generation failed — no credit was used. ' + (pred.error || ''));
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  return typeof out === 'string' ? out : out.url();
}

async function handleExtend(req, env) {
  if (!env.REPLICATE_API_TOKEN) return json({ error: 'AI backend not configured yet.' }, 503);
  const { image, outpaint, prompt } = await req.json().catch(() => ({}));
  if (!image || !outpaint) return json({ error: 'Missing image or outpaint params' }, 400);
  const input = {
    image,
    prompt: (prompt || '').slice(0, 200) || 'seamless photographic extension of the image, matching lighting, style and perspective',
    negative_prompt: 'visible seam, watermark, text, distorted, blurry border',
    outpaint_left: Math.min(512, outpaint.left | 0),
    outpaint_right: Math.min(512, outpaint.right | 0),
    outpaint_up: Math.min(512, outpaint.up | 0),
    outpaint_down: Math.min(512, outpaint.down | 0),
    apply_watermark: false,
    num_outputs: 1,
  };
  try {
    const url = await replicatePrediction(env, input);
    await env.DB.prepare('INSERT INTO usage_log (created_at, credits_spent) VALUES (?, 1)').bind(Date.now()).run().catch(() => {});
    return json({ image_url: url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/redeem' && req.method === 'POST') return handleRedeem(req, env);
      if (url.pathname === '/api/paypal/create-order' && req.method === 'POST') return handleCreateOrder(req, env);
      if (url.pathname === '/api/paypal/capture' && req.method === 'POST') return handleCapture(req, env);
      if (url.pathname === '/api/extend' && req.method === 'POST') return handleExtend(req, env);
      if (url.pathname === '/api/health') return json({ ok: true, live: !!env.REPLICATE_API_TOKEN });
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error' }, 500);
    }
  },
};
