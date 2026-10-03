/* JSM Extend — frontend. Set API_BASE to the Cloudflare Worker URL for live mode;
   empty string = demo mode (simulated results, simulated payments). */
const CONFIG = {
  API_BASE: '',               // e.g. 'https://jsm-extend-worker.memoli.workers.dev'
  FREE_TRIAL_CREDITS: 1,
  CREDITS_PER_COFFEE: 50,
  COFFEE_PRICE_USD: 5,
  MODEL_MAX_SIDE: 1024,       // working resolution cap (long side)
  MODEL_MAX_EXT: 512,         // max outpaint px per side per call
};
const DEMO = !CONFIG.API_BASE;

const $ = id => document.getElementById(id);
/* Credits are enforced SERVER-SIDE. The browser only holds a wallet token;
   the displayed balance is a copy of the server's ledger, refreshed after
   every action. Editing localStorage cannot create credits. */
const store = {
  get token() { try { return localStorage.getItem('jsm-extend-token') || ''; } catch { return ''; } },
  set token(v) { try { localStorage.setItem('jsm-extend-token', v || ''); } catch {} },
};
let balance = 0;
function setBalance(v) { balance = Math.max(0, parseInt(v, 10) || 0); renderCredits(); }

/* ---------- theme ---------- */
(function initTheme() {
  const btn = $('themeToggle');
  const apply = t => { document.documentElement.setAttribute('data-theme', t); btn.innerHTML = t === 'dark' ? '☀️ <span>Light</span>' : '🌙 <span>Dark</span>'; };
  apply(document.documentElement.getAttribute('data-theme') || 'light');
  btn.onclick = () => { const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('jsm-extend-theme', t); } catch {} apply(t); };
})();

/* ---------- credits ---------- */
function renderCredits() {
  $('creditsCount').textContent = balance;
  $('modalBalance').textContent = balance;
}
/* Wallet bootstrap: server-issued trial (1 per IP in live mode). */
async function ensureWallet() {
  if (store.token) { await refreshBalance(); return; }
  try {
    const r = await backend.trial();
    store.token = r.token;
    setBalance(r.credits);
  } catch (e) { setBalance(0); }
}
async function refreshBalance() {
  try { const r = await backend.balance(store.token); setBalance(r.credits); }
  catch (e) { /* keep last known balance */ }
}

/* ---------- modal ---------- */
const modal = $('creditsModal');
function openModal() { renderCredits(); modal.hidden = false; }
function closeModal() { modal.hidden = true; }
$('creditsPill').onclick = openModal;
$('modalClose').onclick = closeModal;
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

/* ---------- state ---------- */
let imgEl = null, imgW = 0, imgH = 0;   // original
let ratio = null;                        // {rw, rh, label}
let layout = null;                       // computed canvas layout (orig px)

const RATIOS = [
  { label: 'Original', rw: 0, rh: 0 },
  { label: '1:1', rw: 1, rh: 1 },
  { label: '4:5', rw: 4, rh: 5 },
  { label: '3:4', rw: 3, rh: 4 },
  { label: '4:3', rw: 4, rh: 3 },
  { label: '3:2', rw: 3, rh: 2 },
  { label: '16:9', rw: 16, rh: 9 },
  { label: '9:16', rw: 9, rh: 16 },
  { label: '2:3', rw: 2, rh: 3 },
];

function computeLayout(w, h, rw, rh) {
  if (!rw) return { tw: w, th: h, left: 0, right: 0, up: 0, down: 0, none: true };
  let tw = Math.max(w, h * rw / rh), th = Math.max(h, w * rh / rw);
  tw = Math.round(tw); th = Math.round(th);
  const left = Math.round((tw - w) / 2), up = Math.round((th - h) / 2);
  return { tw, th, left, up, right: tw - w - left, down: th - h - up, none: false };
}

/* Fit everything into model limits; returns working-size layout */
function workingLayout() {
  const L = layout;
  let s = Math.min(1, CONFIG.MODEL_MAX_SIDE / Math.max(imgW, imgH));
  const maxExt = Math.max(L.left, L.right, L.up, L.down) * s;
  if (maxExt > CONFIG.MODEL_MAX_EXT && maxExt > 0) s *= CONFIG.MODEL_MAX_EXT / maxExt;
  const r = v => Math.max(0, Math.round(v * s));
  return {
    scale: s,
    w: r(imgW), h: r(imgH),
    tw: r(L.tw), th: r(L.th),
    left: r(L.left), right: r(L.right), up: r(L.up), down: r(L.down),
  };
}

/* ---------- upload ---------- */
const dz = $('dropzone'), fi = $('fileInput');
dz.onclick = () => fi.click();
dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fi.click(); };
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
fi.onchange = () => { if (fi.files[0]) loadFile(fi.files[0]); };

function loadFile(f) {
  if (!f.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => {
    imgEl = im; imgW = im.naturalWidth; imgH = im.naturalHeight;
    URL.revokeObjectURL(url);
    $('stepRatio').hidden = false;
    $('stepExtend').hidden = false;
    buildRatioGrid();
    selectRatio(RATIOS[0]);
    $('stepRatio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  im.onerror = () => alert('Could not read that image.');
  im.src = url;
}

/* ---------- ratios + preview ---------- */
function buildRatioGrid() {
  const g = $('ratioGrid'); g.innerHTML = '';
  RATIOS.forEach(r => {
    const b = document.createElement('button');
    b.className = 'ratio-btn';
    b.dataset.label = r.label;
    const bw = 34, bh = r.rw ? Math.max(10, Math.round(34 * r.rh / r.rw)) : 24;
    b.innerHTML = `<span class="box" style="width:${bw}px;height:${r.rw ? bh : 24}px"></span><span>${r.label}</span>`;
    b.onclick = () => selectRatio(r);
    g.appendChild(b);
  });
}
function selectRatio(r) {
  ratio = r;
  document.querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b.dataset.label === r.label));
  layout = computeLayout(imgW, imgH, r.rw, r.rh);
  drawPreview();
  updateExtendUI();
}
$('customApply').onclick = () => {
  const w = parseInt($('customW').value, 10), h = parseInt($('customH').value, 10);
  if (!w || !h || w < 1 || h < 1) { alert('Enter a valid width and height.'); return; }
  document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
  ratio = { label: `${w}:${h}`, rw: w, rh: h };
  layout = computeLayout(imgW, imgH, w, h);
  drawPreview(); updateExtendUI();
};

function drawPreview() {
  const c = $('previewCanvas'), L = layout;
  const maxW = 720, s = Math.min(1, maxW / L.tw);
  c.width = Math.round(L.tw * s); c.height = Math.round(L.th * s);
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  // extension area tint
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2563eb';
  x.globalAlpha = 0.12; x.fillRect(0, 0, c.width, c.height); x.globalAlpha = 1;
  // original image centered
  const dw = imgW * s, dh = imgH * s, dx = (c.width - dw) / 2, dy = (c.height - dh) / 2;
  x.drawImage(imgEl, dx, dy, dw, dh);
  x.strokeStyle = '#2563eb'; x.setLineDash([6, 4]); x.lineWidth = 2;
  x.strokeRect(dx, dy, dw, dh); x.setLineDash([]);
  const ext = L.left + L.right + L.up + L.down;
  $('previewInfo').textContent = L.none
    ? `${imgW}×${imgH} — no expansion needed. Pick a different ratio to extend.`
    : `${imgW}×${imgH} → ${L.tw}×${L.th} — AI will paint ${ext.toLocaleString()} px² of new background (blue tint).`;
}

function updateExtendUI() {
  const btn = $('extendBtn');
  const needsExt = layout && !layout.none;
  btn.disabled = !needsExt;
  $('costLine').textContent = needsExt
    ? `This will use 1 credit. You have ${balance}.`
    : 'This ratio matches your image — no extension needed.';
}

/* ---------- backends ---------- */
/* Demo backend mirrors the server's security model client-side:
   token wallets, atomic debit, single-use codes, one trial. */
const mockBackend = {
  _wallets() { try { return JSON.parse(localStorage.getItem('jsm-extend-mock-w') || '{}'); } catch { return {}; } },
  _saveW(w) { try { localStorage.setItem('jsm-extend-mock-w', JSON.stringify(w)); } catch {} },
  _tok() { return 'mock-' + Math.random().toString(36).slice(2, 14); },
  async trial() {
    await new Promise(r => setTimeout(r, 300));
    if (localStorage.getItem('jsm-extend-mock-trial')) throw new Error('Trial already used');
    localStorage.setItem('jsm-extend-mock-trial', '1');
    const t = this._tok(), w = this._wallets();
    w[t] = CONFIG.FREE_TRIAL_CREDITS; this._saveW(w);
    return { token: t, credits: CONFIG.FREE_TRIAL_CREDITS };
  },
  async balance(token) { return { credits: this._wallets()[token] || 0 }; },
  async extend(imageDataUrl, out, prompt, token) {
    const w = this._wallets();
    if (!w[token] || w[token] < 1) { const e = new Error('No credits — buy more to continue.'); e.code = 402; throw e; }
    w[token]--; this._saveW(w); // atomic debit before work
    await new Promise(r => setTimeout(r, 2200)); // simulate AI latency
    // Simulated result: blurred-fill background (like JSM Image's blurred fit)
    const src = await loadImage(imageDataUrl);
    const c = document.createElement('canvas');
    c.width = out.tw; c.height = out.th;
    const x = c.getContext('2d');
    const blur = Math.max(8, Math.round(Math.min(out.tw, out.th) / 28));
    x.filter = `blur(${blur}px)`;
    const sc = Math.max(out.tw / out.w, out.th / out.h);
    const bw = out.w * sc, bh = out.h * sc;
    x.drawImage(src, (out.tw - bw) / 2, (out.th - bh) / 2, bw, bh);
    x.filter = 'none';
    x.drawImage(src, out.left, out.up, out.w, out.h);
    return { image_b64: c.toDataURL('image/png'), mock: true, credits: w[token] };
  },
  async redeem(code, token) {
    await new Promise(r => setTimeout(r, 400));
    code = code.trim().toUpperCase();
    if (!/^MOCK-[A-Z0-9]{4}(-[A-Z0-9]{4})?$/.test(code)) throw new Error('Invalid code format.');
    let used = [];
    try { used = JSON.parse(localStorage.getItem('jsm-extend-mock-used') || '[]'); } catch {}
    if (used.includes(code)) throw new Error('This code was already redeemed.');
    used.push(code);
    try { localStorage.setItem('jsm-extend-mock-used', JSON.stringify(used)); } catch {}
    const w = this._wallets();
    const t = (token && w[token] !== undefined) ? token : this._tok();
    w[t] = (w[t] || 0) + CONFIG.CREDITS_PER_COFFEE;
    this._saveW(w);
    return { token: t, credits: w[t] };
  },
  async buyCoffee() {
    await new Promise(r => setTimeout(r, 1200)); // simulate PayPal
    const rnd = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    return { code: `MOCK-${rnd()}-${rnd()}`, credits: CONFIG.CREDITS_PER_COFFEE };
  },
  async buyStripe() {
    await new Promise(r => setTimeout(r, 1200)); // simulate Stripe Checkout
    const rnd = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    return { code: `MOCK-${rnd()}-${rnd()}`, credits: CONFIG.CREDITS_PER_COFFEE };
  },
};

const workerBackend = {
  async trial() {
    const res = await fetch(CONFIG.API_BASE + '/api/trial', { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Trial failed');
    return j;
  },
  async balance(token) {
    const res = await fetch(CONFIG.API_BASE + '/api/balance?token=' + encodeURIComponent(token || ''));
    return res.json();
  },
  async extend(imageDataUrl, out, prompt, token) {
    const res = await fetch(CONFIG.API_BASE + '/api/extend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, image: imageDataUrl, outpaint: { left: out.left, right: out.right, up: out.up, down: out.down }, prompt }),
    });
    const j = await res.json();
    if (!res.ok) { const e = new Error(j.error || 'Extend failed'); e.code = res.status; throw e; }
    return j;
  },
  async redeem(code, token) {
    const res = await fetch(CONFIG.API_BASE + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), token: token || '' }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Redeem failed');
    return j;
  },
  async buyCoffee() {
    const res = await fetch(CONFIG.API_BASE + '/api/paypal/create-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: 'coffee' }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Could not start PayPal checkout');
    location.href = j.approval_url; // returns after approval; we capture on load
    return new Promise(() => {});
  },
  async buyStripe() {
    const res = await fetch(CONFIG.API_BASE + '/api/stripe/create-checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: 'coffee' }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Could not start card checkout');
    location.href = j.checkout_url; // Stripe hosted page; returns with ?stripe_session=
    return new Promise(() => {});
  },
};
const backend = DEMO ? mockBackend : workerBackend;

function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
function workingImageDataUrl(out) {
  const c = document.createElement('canvas');
  c.width = out.w; c.height = out.h;
  c.getContext('2d').drawImage(imgEl, 0, 0, out.w, out.h);
  return c.toDataURL('image/jpeg', 0.92);
}

/* ---------- extend flow ---------- */
$('extendBtn').onclick = async () => {
  if (!layout || layout.none) return;
  if (balance < 1) { openModal(); return; }
  const out = workingLayout();
  const prompt = $('promptInput').value.trim();
  $('progress').hidden = false;
  $('resultWrap').hidden = true;
  $('extendBtn').disabled = true;
  try {
    // The server atomically deducts 1 credit; the returned balance is authoritative.
    const r = await backend.extend(workingImageDataUrl(out), out, prompt, store.token);
    setBalance(r.credits);
    $('resultImg').src = r.image_b64 || r.image_url;
    $('downloadBtn').href = r.image_b64 || r.image_url;
    $('resultWrap').hidden = false;
    $('demoBanner').hidden = !r.mock;
    $('resultWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    if (e.code === 402) { setBalance(0); openModal(); return; } // server says empty
    alert('Extension failed: ' + (e.message || e) + '\nNo credit was used.');
  } finally {
    $('progress').hidden = true;
    updateExtendUI();
  }
};
$('againBtn').onclick = () => { $('resultWrap').hidden = true; updateExtendUI(); };

/* ---------- buy + redeem ---------- */
$('payHint').textContent = DEMO
  ? 'Demo mode: the PayPal and card buttons simulate a payment and issue a test code.'
  : `Secure checkout via PayPal or card. ${CONFIG.CREDITS_PER_COFFEE} credits per coffee.`;

async function startPurchase(kind) {
  const btn = $(kind === 'stripe' ? 'stripeBuyBtn' : 'paypalBuyBtn');
  btn.disabled = true;
  $('payHint').textContent = kind === 'stripe' ? 'Opening secure card checkout…' : 'Opening PayPal…';
  try {
    const r = await (kind === 'stripe' ? backend.buyStripe() : backend.buyCoffee());
    if (r && r.code) {
      // Hand the code to the user (no auto-redeem): they may screenshot it
      // and redeem later — it stays valid even if the browser is cleared.
      showPurchasedCode(r.code);
    }
  } catch (e) {
    $('payHint').textContent = 'Payment failed: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
}
$('paypalBuyBtn').onclick = () => startPurchase('paypal');
$('stripeBuyBtn').onclick = () => startPurchase('stripe');

$('redeemBtn').onclick = () => doRedeem($('codeInput').value, false);

/* Show a purchased code gift-card style: user keeps it, screenshots it,
   and redeems when ready — it stays valid even if the browser is cleared. */
function showPurchasedCode(code) {
  $('payHint').innerHTML =
    '<div class="code-box"><div class="muted small">Payment received! Your code:</div>' +
    '<div class="code-value"></div>' +
    '<p class="muted small">📸 Take a screenshot of this code and keep it safe — it works even if you clear your browser. ' +
    'Single-use: once redeemed, your remaining credits live in this browser\'s wallet.</p></div>';
  $('payHint').querySelector('.code-value').textContent = code;
  $('codeInput').value = code;
  $('redeemMsg').className = 'muted'; $('redeemMsg').textContent = '';
}

async function doRedeem(code, auto) {
  const msg = $('redeemMsg');
  msg.className = 'muted'; msg.textContent = 'Checking…';
  try {
    const before = balance;
    const r = await backend.redeem(code, store.token);
    if (r.token) store.token = r.token; // server may issue a fresh wallet
    setBalance(r.credits); // server total is authoritative
    msg.className = 'ok'; msg.textContent = `+${r.credits - before} credits added!`;
    if (!auto) $('codeInput').value = '';
    updateExtendUI();
  } catch (e) {
    msg.className = 'err'; msg.textContent = e.message || 'Redeem failed.';
  }
}

/* PayPal return: ?token=ORDERID → capture → code → auto-redeem */
(async function handlePaypalReturn() {
  const q = new URLSearchParams(location.search);
  const token = q.get('token');
  if (!token || DEMO) return;
  history.replaceState(null, '', location.pathname);
  openModal();
  $('payHint').textContent = 'Confirming your PayPal payment…';
  try {
    const res = await fetch(CONFIG.API_BASE + '/api/paypal/capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: token }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Capture failed');
    showPurchasedCode(j.code);
  } catch (e) {
    $('payHint').textContent = 'Could not confirm payment: ' + (e.message || e);
  }
})();

/* Stripe return: ?stripe_session=ID → verify → show code */
(async function handleStripeReturn() {
  const q = new URLSearchParams(location.search);
  const sid = q.get('stripe_session');
  if (!sid || DEMO) return;
  history.replaceState(null, '', location.pathname);
  openModal();
  $('payHint').textContent = 'Confirming your card payment…';
  try {
    const res = await fetch(CONFIG.API_BASE + '/api/stripe/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Verification failed');
    showPurchasedCode(j.code);
  } catch (e) {
    $('payHint').textContent = 'Could not confirm payment: ' + (e.message || e);
  }
})();

/* ---------- init ---------- */
ensureWallet();
$('demoBanner').hidden = !DEMO;
