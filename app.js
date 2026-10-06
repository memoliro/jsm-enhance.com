/* JSM Enhance — frontend. Set API_BASE to the Cloudflare Worker URL for live mode;
   empty string = demo mode (simulated results, simulated payments). */
const CONFIG = {
  API_BASE: 'https://jsm-extend-api.memoliro.workers.dev', // live Cloudflare Worker
  FREE_TRIAL_CREDITS: 1,
  PACKS: [ // $5 default; user can pick $10 / $15 (10 credits per $1)
    { id: 'coffee5',  usd: 5,  credits: 50 },
    { id: 'coffee10', usd: 10, credits: 100 },
    { id: 'coffee15', usd: 15, credits: 150 },
  ],
  MODEL_MAX_SIDE: 1024,       // (legacy, pre-Bria) working resolution cap
  BRIA_MAX_SIDE: 2048,        // Bria working canvas cap (long side); Bria natively handles up to 5000
  MAX_OUT_SIDE: 4096,         // final output cap: longest side (px)
  MAX_OUT_PX: 12000000,       // final output cap: total pixels (~12MP, mobile-safe)
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
let sizeMode = 'ratio';                  // 'ratio' (minimal expansion) or 'exact' (preset/custom px)
let exactW = 0, exactH = 0;              // requested exact canvas (px, pre-clamp)

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
/* Exact-pixel presets (social sizes, like JSM Image). Selecting one delivers
   exactly these pixels: the AI paints at working size, then the result is
   finished crisply at the preset size in the browser. */
const PRESETS = [
  { label: 'YouTube', sub: '1920×1080', w: 1920, h: 1080 },
  { label: 'Shorts / Reels / TikTok', sub: '1080×1920', w: 1080, h: 1920 },
  { label: 'Instagram', sub: '1080×1080', w: 1080, h: 1080 },
  { label: 'Profile Photo', sub: '400×400', w: 400, h: 400 },
  { label: 'FB / LinkedIn', sub: '1200×628', w: 1200, h: 628 },
  { label: 'Twitter / X', sub: '1200×675', w: 1200, h: 675 },
  { label: '4K UHD', sub: '3840×2160', w: 3840, h: 2160 },
  { label: '4K Vertical', sub: '2160×3840', w: 2160, h: 3840 },
];

function computeLayout(w, h, rw, rh) {
  if (!rw) return { tw: w, th: h, left: 0, right: 0, up: 0, down: 0, none: true };
  let tw = Math.max(w, h * rw / rh), th = Math.max(h, w * rh / rw);
  tw = Math.round(tw); th = Math.round(th);
  const left = Math.round((tw - w) / 2), up = Math.round((th - h) / 2);
  return { tw, th, left, up, right: tw - w - left, down: th - h - up, none: false };
}

/* The deliverable canvas in output pixels: ratio mode = minimal expansion of
   the original; exact mode = preset/custom pixels. Clamped to MAX_OUT_SIDE /
   MAX_OUT_PX so extreme requests can't blow up the browser tab (or imply a
   bigger AI job than our fixed working size). The original is fit-inside and
   centered; margins are what the AI paints. */
function currentCanvas() {
  let tw, th;
  if (sizeMode === 'exact') { tw = exactW; th = exactH; }
  else { tw = layout.tw; th = layout.th; }
  let s = Math.min(1, CONFIG.MAX_OUT_SIDE / Math.max(tw, th));
  if (tw * th * s * s > CONFIG.MAX_OUT_PX) s = Math.sqrt(CONFIG.MAX_OUT_PX / (tw * th));
  const capped = s < 1;
  tw = Math.max(1, Math.round(tw * s)); th = Math.max(1, Math.round(th * s));
  const os = Math.min(tw / imgW, th / imgH);
  const ow = Math.max(1, Math.round(imgW * os)), oh = Math.max(1, Math.round(imgH * os));
  const ox = Math.round((tw - ow) / 2), oy = Math.round((th - oh) / 2);
  const none = ox <= 0 && oy <= 0 && tw - ox - ow <= 0 && th - oy - oh <= 0;
  return { tw, th, ow, oh, ox, oy, capped, none };
}

/* Working-size layout for Bria Expand: canvas + original placement at working scale.
   Bria takes the target canvas directly (no per-side outpaint limit), so unlike the
   old model there is no 512px/side squeeze — just cap the canvas long side. */
function briaLayout() {
  const C = currentCanvas();
  const s = Math.min(1, CONFIG.BRIA_MAX_SIDE / Math.max(C.tw, C.th));
  const rd = v => Math.max(1, Math.round(v * s)); // dims: never 0
  const rp = v => Math.max(0, Math.round(v * s)); // placement: 0 is valid
  return {
    scale: s,
    imgW: rd(C.ow), imgH: rd(C.oh), // original at working scale
    cw: rd(C.tw), ch: rd(C.th),     // target canvas at working scale
    ox: rp(C.ox), oy: rp(C.oy),     // original top-left on the canvas, working px
  };
}

/* ---------- upload ---------- */
const dz = $('dropzone'), fi = $('fileInput');
dz.onclick = () => fi.click();
dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fi.click(); };
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
fi.onchange = () => { const f = fi.files[0]; fi.value = ''; /* reset so picking the
  same file again still fires change */ if (f) loadFile(f); };

function setUploadedImage(im) {
  imgEl = im; imgW = im.naturalWidth; imgH = im.naturalHeight;
  lastAi = null; lastFinal = null; lastClean = null; // never carry an old AI result into a new upload
  sharpenSrc = null; // back to the upload as the sharpen source
  $('sharpenResultBtn').hidden = true;
  $('workspace').hidden = false;
  buildRatioMenu();
  buildPresetGrid();
  selectRatio(RATIOS[0]);
  drawTextPreview();
  drawSharpenPreview();
  selectTool(activeTool);
  $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function loadFile(f) {
  if (!f.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => { URL.revokeObjectURL(url); setUploadedImage(im); };
  im.onerror = () => alert('Could not read that image.');
  im.src = url;
}
async function loadSample() {
  try {
    setUploadedImage(await loadImage('samples/sharpen-sample.png'));
  } catch (e) {
    alert('Could not load the sample image.');
  }
}
$('sampleBtn').onclick = loadSample;

/* ---------- ratios + preview ---------- */
/* Aspect-ratio dropdown: proportional mini box per option, enlarged preview on hover. */
function ratioBoxStyle(rw, rh, max) {
  const w = rw || imgW || 1, h = rh || imgH || 1;
  const bw = max, bh = Math.max(8, Math.round(max * h / w));
  return `style="width:${bw}px;height:${bh}px"`;
}
function buildRatioMenu() {
  const m = $('ratioDDMenu'); m.innerHTML = '';
  RATIOS.forEach(r => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dd-opt'; b.dataset.label = r.label;
    b.setAttribute('role', 'option');
    b.innerHTML = `<span class="dd-box"><i ${ratioBoxStyle(r.rw, r.rh, 30)}></i></span><span>${r.label}</span>`;
    b.onclick = () => { selectRatio(r); closeRatioMenu(); };
    b.onmouseenter = () => showRatioHover(r, b);
    b.onmouseleave = hideRatioHover;
    m.appendChild(b);
  });
}
function toggleRatioMenu(force) {
  const m = $('ratioDDMenu'), btn = $('ratioDDBtn');
  const open = force !== undefined ? force : m.hidden;
  m.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) hideRatioHover();
}
function closeRatioMenu() { toggleRatioMenu(false); }
function showRatioHover(r, el) {
  const hov = $('ratioHover');
  $('ratioHoverBox').innerHTML = `<i ${ratioBoxStyle(r.rw, r.rh, 110)}></i>`;
  $('ratioHoverLabel').textContent = r.label;
  hov.hidden = false;
  const rc = el.getBoundingClientRect();
  const hw = hov.offsetWidth, hh = hov.offsetHeight;
  let x = rc.right + 12, y = rc.top + rc.height / 2 - hh / 2;
  if (x + hw > innerWidth - 12) x = Math.max(12, rc.left - hw - 12);
  y = Math.max(12, Math.min(y, innerHeight - hh - 12));
  hov.style.left = x + 'px'; hov.style.top = y + 'px';
}
function hideRatioHover() { $('ratioHover').hidden = true; }
function selectRatio(r) {
  ratio = r; sizeMode = 'ratio';
  document.querySelectorAll('#ratioDDMenu .dd-opt').forEach(b => b.classList.toggle('hot', b.dataset.label === r.label));
  $('ratioDDLabel').textContent = r.label;
  $('ratioDDBox').innerHTML = `<i ${ratioBoxStyle(r.rw, r.rh, 26)}></i>`;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  layout = computeLayout(imgW, imgH, r.rw, r.rh);
  drawPreview();
  drawTextPreview();
  updateExtendUI();
}
function buildPresetGrid() {
  const g = $('presetGrid'); g.innerHTML = '';
  PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset-btn';
    b.dataset.w = p.w; b.dataset.h = p.h;
    b.innerHTML = `<b></b><span>${p.sub}</span>`;
    b.querySelector('b').textContent = p.label;
    b.title = `${p.label} — ${p.sub} px`;
    b.onclick = () => selectPreset(p);
    g.appendChild(b);
  });
}
function selectPreset(p) {
  sizeMode = 'exact'; exactW = p.w; exactH = p.h;
  markRatioCustom(`${p.w.toLocaleString()} × ${p.h.toLocaleString()}`);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', +b.dataset.w === p.w && +b.dataset.h === p.h));
  drawPreview();
  drawTextPreview();
  updateExtendUI();
}
/* Dropdown reflects an exact (preset/custom) size instead of a ratio. */
function markRatioCustom(label) {
  document.querySelectorAll('#ratioDDMenu .dd-opt').forEach(b => b.classList.remove('hot'));
  $('ratioDDLabel').textContent = label;
  $('ratioDDBox').innerHTML = `<i ${ratioBoxStyle(exactW, exactH, 26)}></i>`;
}
/* Custom dimensions apply live as you type (debounced) — no Apply button. */
let customTimer = null;
function applyCustomLive() {
  const msg = $('customMsg'), wEl = $('customW'), hEl = $('customH');
  const w = parseInt(wEl.value, 10), h = parseInt(hEl.value, 10);
  if (!wEl.value || !hEl.value) {
    // still typing — clear quietly and keep the last valid preview
    wEl.classList.remove('input-err'); hEl.classList.remove('input-err');
    msg.textContent = ''; msg.classList.remove('err');
    return;
  }
  const wBad = !w || w < 16, hBad = !h || h < 16;
  wEl.classList.toggle('input-err', wBad);
  hEl.classList.toggle('input-err', hBad);
  if (wBad || hBad) {
    msg.textContent = 'Minimum 16 px per side.';
    msg.classList.add('err');
    return;
  }
  msg.textContent = ''; msg.classList.remove('err');
  sizeMode = 'exact';
  exactW = Math.min(w, CONFIG.MAX_OUT_SIDE); exactH = Math.min(h, CONFIG.MAX_OUT_SIDE);
  markRatioCustom(`${exactW.toLocaleString()} × ${exactH.toLocaleString()}`);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  drawPreview(); drawTextPreview(); updateExtendUI();
}
['customW', 'customH'].forEach(id => $(id).addEventListener('input', () => {
  clearTimeout(customTimer);
  customTimer = setTimeout(applyCustomLive, 500);
}));

/* Preview mode: 'planned' (default) shows the tool's output preview,
   'original' shows just the uploaded photo — jsm-image style toggle. */
let previewMode = 'planned';
function drawOriginalPreview(c, maxW, srcImg, srcW, srcH) {
  const im = srcImg || imgEl, iw = srcW || imgW, ih = srcH || imgH;
  const s = Math.min(1, maxW / Math.max(iw, ih));
  c.width = Math.max(1, Math.round(iw * s));
  c.height = Math.max(1, Math.round(ih * s));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
}
function refreshPreview() {
  if (activeTool === 'extend') drawPreview();
  else if (activeTool === 'sharpen') drawSharpenPreview();
  else if (activeTool === 'unblur') drawUnblurPreview();
  else drawTextPreview();
}
function setPreviewMode(m) {
  previewMode = m;
  const orig = m === 'original';
  $('showOrigBtn').classList.toggle('btn-primary', orig);
  $('showOrigBtn').classList.toggle('btn-secondary', !orig);
  $('showPlanBtn').classList.toggle('btn-primary', !orig);
  $('showPlanBtn').classList.toggle('btn-secondary', orig);
  refreshPreview();
}
function drawPreview() {
  if (previewMode === 'original') { drawOriginalPreview($('previewCanvas'), 1200); return; }
  const C = currentCanvas();
  const c = $('previewCanvas');
  const maxW = 1200, s = Math.min(1, maxW / C.tw);
  c.width = Math.round(C.tw * s); c.height = Math.round(C.th * s);
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  // extension area tint
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2563eb';
  x.globalAlpha = 0.12; x.fillRect(0, 0, c.width, c.height); x.globalAlpha = 1;
  // original image, fit-inside and centered (matches the final result)
  const dw = C.ow * s, dh = C.oh * s, dx = C.ox * s, dy = C.oy * s;
  x.drawImage(imgEl, dx, dy, dw, dh);
  x.strokeStyle = '#2563eb'; x.setLineDash([6, 4]); x.lineWidth = 2;
  x.strokeRect(dx, dy, dw, dh); x.setLineDash([]);
  updateSizeInfo(C);
}

function updateSizeInfo(C) {
  C = C || currentCanvas();
  $('wsOrig').textContent = `${imgW.toLocaleString()} × ${imgH.toLocaleString()} px`;
  $('wsNew').textContent = `${C.tw.toLocaleString()} × ${C.th.toLocaleString()} px`;
  /* Custom fields mirror the current target, jsm-image style (never clobber typing). */
  if (document.activeElement !== $('customW')) $('customW').value = C.tw;
  if (document.activeElement !== $('customH')) $('customH').value = C.th;
  const extPx = C.tw * C.th - C.ow * C.oh;
  $('previewInfo').innerHTML = C.none
    ? 'No expansion needed — pick a different size to extend, or you may want to <a href="#" data-goto-tool="sharpen">Sharpen</a>.'
    : `AI will paint ${extPx.toLocaleString()} px² of new background (blue tint).`;
  $('sizeNote').textContent = C.capped
    ? '⚠️ Capped at a safe maximum (4096 px side / 12 MP) to protect quality and processing.'
    : 'AI paints at up to 2048 px, then the result is finished crisply at your chosen size.';
}

function updateExtendUI() {
  const btn = $('extendBtn'), note = $('freeResizeNote');
  if (!imgEl) { btn.disabled = true; return; }
  const C = currentCanvas();
  const needsExt = !C.none;
  const chained = $('chainSharpen').checked;
  const total = needsExt ? (chained ? 2 : 1) : 0;
  btn.disabled = !needsExt;
  btn.style.display = needsExt ? '' : 'none';
  $('extendBtnLabel').textContent = chained && needsExt ? '✨ Extend & Sharpen image' : '✨ Extend image';
  btn.querySelector('.cost').textContent = `${total} 🪙`;
  note.hidden = needsExt;
  /* Pay only when the AI invents new pixels. Pure resizes go free to JSM Image. */
  $('costLine').innerHTML = needsExt
    ? `This will use ${total} credit${total > 1 ? 's' : ''}${chained ? ' (extend + enhance)' : ''} and deliver ${C.tw.toLocaleString()} × ${C.th.toLocaleString()} px. You have ${balance}. <span class="muted free-alt">Just need a crop instead of AI painting? <a href="https://jsm-image.com" target="_blank" rel="noopener">Free at JSM Image</a></span>`
    : '';
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
  async unblur(imageDataUrl, token) {
    const w = this._wallets();
    if (!w[token] || w[token] < 1) { const e = new Error('No credits — buy more to continue.'); e.code = 402; throw e; }
    w[token]--; this._saveW(w); // atomic debit before work
    await new Promise(r => setTimeout(r, 2200)); // simulate AI latency
    // Simulated result: mild contrast lift — clearly a mock
    const src = await loadImage(imageDataUrl);
    const c = document.createElement('canvas');
    c.width = src.naturalWidth; c.height = src.naturalHeight;
    const x = c.getContext('2d');
    x.filter = 'contrast(1.06) saturate(1.06)';
    x.drawImage(src, 0, 0);
    return { image_b64: c.toDataURL('image/png'), mock: true, credits: w[token] };
  },
  async sharpen(imageDataUrl, scale, token) {
    const w = this._wallets();
    if (!w[token] || w[token] < 1) { const e = new Error('No credits — buy more to continue.'); e.code = 402; throw e; }
    w[token]--; this._saveW(w); // atomic debit before work
    await new Promise(r => setTimeout(r, 2200)); // simulate AI latency
    // Simulated result: plain canvas upscale (soft) — clearly a mock
    const src = await loadImage(imageDataUrl);
    const c = document.createElement('canvas');
    c.width = src.naturalWidth * scale; c.height = src.naturalHeight * scale;
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return { image_b64: c.toDataURL('image/png'), mock: true, credits: w[token] };
  },
  _issued() { try { return JSON.parse(localStorage.getItem('jsm-extend-mock-issued') || '{}'); } catch { return {}; } },
  _saveIssued(m) { try { localStorage.setItem('jsm-extend-mock-issued', JSON.stringify(m)); } catch {} },
  async redeem(code, token) {
    await new Promise(r => setTimeout(r, 400));
    code = code.trim().toUpperCase();
    if (!/^MOCK-[A-Z0-9]{4}(-[A-Z0-9]{4})?$/.test(code)) throw new Error('Invalid code format.');
    let used = [];
    try { used = JSON.parse(localStorage.getItem('jsm-extend-mock-used') || '[]'); } catch {}
    if (used.includes(code)) throw new Error('This code was already redeemed.');
    // Demo mirrors the server's codes table: each issued code carries its pack's credits.
    const issued = this._issued();
    const packCredits = issued[code];
    if (!packCredits) throw new Error('Unknown code.');
    used.push(code);
    try { localStorage.setItem('jsm-extend-mock-used', JSON.stringify(used)); } catch {}
    const w = this._wallets();
    const t = (token && w[token] !== undefined) ? token : this._tok();
    w[t] = (w[t] || 0) + packCredits;
    this._saveW(w);
    return { token: t, credits: w[t], added: packCredits };
  },
  _mockBuy(packId) {
    const p = CONFIG.PACKS.find(x => x.id === packId) || CONFIG.PACKS[0];
    const rnd = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    const code = `MOCK-${rnd()}-${rnd()}`;
    const issued = this._issued(); issued[code] = p.credits; this._saveIssued(issued);
    return { code, credits: p.credits };
  },
  async buyCoffee(packId) {
    await new Promise(r => setTimeout(r, 1200)); // simulate PayPal
    return this._mockBuy(packId);
  },
  async buyStripe(packId) {
    await new Promise(r => setTimeout(r, 1200)); // simulate Stripe Checkout
    return this._mockBuy(packId);
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
      body: JSON.stringify({ token, image: imageDataUrl,
        canvas: [out.cw, out.ch], orig_size: [out.imgW, out.imgH], orig_loc: [out.ox, out.oy], prompt }),
    });
    const j = await res.json();
    if (!res.ok) { const e = new Error(j.error || 'Extend failed'); e.code = res.status; throw e; }
    return j;
  },
  async sharpen(imageDataUrl, scale, token) {
    const res = await fetch(CONFIG.API_BASE + '/api/sharpen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, image: imageDataUrl, scale }),
    });
    const j = await res.json();
    if (!res.ok) { const e = new Error(j.error || 'Sharpen failed'); e.code = res.status; throw e; }
    return j;
  },
  async unblur(imageDataUrl, token) {
    const res = await fetch(CONFIG.API_BASE + '/api/unblur', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, image: imageDataUrl }),
    });
    const j = await res.json();
    if (!res.ok) { const e = new Error(j.error || 'Unblur failed'); e.code = res.status; throw e; }
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
  async buyCoffee(packId) {
    const res = await fetch(CONFIG.API_BASE + '/api/paypal/create-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: packId || 'coffee5' }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Could not start PayPal checkout');
    location.href = j.approval_url; // returns after approval; we capture on load
    return new Promise(() => {});
  },
  async buyStripe(packId) {
    const res = await fetch(CONFIG.API_BASE + '/api/stripe/create-checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: packId || 'coffee5' }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Could not start card checkout');
    location.href = j.checkout_url; // Stripe hosted page; returns with ?stripe_session=
    return new Promise(() => {});
  },
};
const backend = DEMO ? mockBackend : workerBackend;

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    /* Ask for CORS: if the host allows it the canvas stays clean and
       exportable; data:/blob: sources are unaffected. */
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Could not load image'));
    im.src = src;
  });
}
/* Finish the AI result at the chosen output size: the AI's working-size
   image supplies the painted edges, and the full-resolution original is
   drawn crisply on top, centered — exactly what the preview showed. */
async function finishResult(aiSrc) {
  const C = currentCanvas();
  const ai = await loadImage(aiSrc);
  lastAi = ai;
  const c = document.createElement('canvas');
  c.width = C.tw; c.height = C.th;
  const x = c.getContext('2d');
  x.drawImage(ai, 0, 0, C.tw, C.th);
  /* Feather the original over the AI result: a hard paste leaves a visible line
     wherever the AI's edge tone differs even slightly, so blend a few px at the
     boundary with a blurred mask. The original stays pixel-sharp everywhere else. */
  const f = Math.max(2, Math.round(Math.min(C.ow, C.oh) * 0.004));
  const fg = document.createElement('canvas');
  fg.width = C.tw; fg.height = C.th;
  const fx = fg.getContext('2d');
  fx.drawImage(imgEl, C.ox, C.oy, C.ow, C.oh);
  const mask = document.createElement('canvas');
  mask.width = C.tw; mask.height = C.th;
  const mx = mask.getContext('2d');
  mx.fillStyle = '#fff';
  mx.fillRect(C.ox, C.oy, C.ow, C.oh);
  const soft = document.createElement('canvas');
  soft.width = C.tw; soft.height = C.th;
  const sx = soft.getContext('2d');
  try { sx.filter = `blur(${f}px)`; } catch (e) { /* old browser: falls back to a hard edge */ }
  sx.drawImage(mask, 0, 0);
  fx.globalCompositeOperation = 'destination-in';
  fx.drawImage(soft, 0, 0);
  x.drawImage(fg, 0, 0);
  lastClean = await loadImage(c.toDataURL('image/png'));
  drawLayers(x, C.tw, C.th); // burn the text layers into the final image
  const url = c.toDataURL('image/png');
  lastFinal = await loadImage(url);
  return { url, w: C.tw, h: C.th };
}
/* Show the extend result in the before/after compare slider:
   "before" = the original placed on the target canvas (what you'd get with no AI),
   "after" = the finished AI result. Both share the target dimensions, so the
   comparison is pixel-aligned. */
function showExtendResult(fin, C) {
  const bc = document.createElement('canvas');
  bc.width = C.tw; bc.height = C.th;
  bc.getContext('2d').drawImage(imgEl, C.ox, C.oy, C.ow, C.oh);
  $('baBeforeEx').src = bc.toDataURL('image/jpeg', 0.9);
  $('baAfterEx').src = fin.url;
  $('baWrapEx').style.setProperty('--pos', '50%');
  $('downloadBtn').href = fin.url;
  $('downloadBtn').download = `jsm-enhance-${fin.w}x${fin.h}.png`;
  $('resultSize').textContent = `${fin.w.toLocaleString()} × ${fin.h.toLocaleString()} px PNG`;
}
function briaImageDataUrl(out) {  const c = document.createElement('canvas');
  c.width = out.imgW; c.height = out.imgH;
  c.getContext('2d').drawImage(imgEl, 0, 0, out.imgW, out.imgH);
  return c.toDataURL('image/jpeg', 0.92);
}

/* ---------- extend flow ---------- */
$('extendBtn').onclick = async () => {
  if (!imgEl || currentCanvas().none) return;
  const need = $('chainSharpen').checked ? 2 : 1; // extend + optional chained enhance
  if (balance < need) { openModal(); return; }
  const out = briaLayout();
  const prompt = $('promptInput').value.trim();
  $('progress').hidden = false;
  $('resultWrap').hidden = true;
  $('extendErr').hidden = true;
  $('extendBtn').disabled = true;
  try {
    // The server atomically deducts 1 credit; the returned balance is authoritative.
    const r = await backend.extend(briaImageDataUrl(out), out, prompt, store.token);
    setBalance(r.credits);
    const C = currentCanvas();
    const fin = await finishResult(r.image_b64 || r.image_url);
    showExtendResult(fin, C);
    $('resultWrap').hidden = false;
    $('demoBanner').hidden = !r.mock;
    drawTextPreview(); // step 4 must show the extended image, not the original
    $('sharpenResultBtn').hidden = false; // manual "enhance this result" path on the left card
    if ($('chainSharpen').checked && lastClean) {
      await runChainedSharpen(); // auto-chain: enhance now, then land on the Sharpen tab
    } else {
      $('resultWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (e) {
    if (e.code === 402) { setBalance(0); openModal(); return; } // server says empty
    /* Never claim "no credit was used": the debit happens server-side before
       the AI runs, so only the server knows the truth. Refresh and report it. */
    await refreshBalance();
    const err = $('extendErr');
    err.textContent = 'Extension failed: ' + (e.message || e) + ` Your balance: ${balance} credit${balance === 1 ? '' : 's'}.`;
    err.hidden = false;
    $('resultWrap').hidden = true;
  } finally {
    $('progress').hidden = true;
    updateExtendUI();
  }
};
$('openEditor').onclick = () => { drawTextPreview(); openEditor(); }; // editor opens on the extended result

/* ---------- tool tabs: extend vs sharpen (inside the controls card) ---------- */
let activeTool = 'extend';
function syncWsInfo() {
  const t = activeTool, ext = t === 'extend';
  const chained = ext && $('chainSharpen') && $('chainSharpen').checked;
  $('wsNewLabel').textContent = ext ? 'New size' : 'Output';
  $('wsCost').textContent = chained ? '2 credits per extension + sharpen'
    : ext ? '1 credit per extension'
    : (t === 'sharpen' || t === 'unblur') ? '1 credit per photo' : 'Free';
  $('wsNote').innerHTML =
    ext ? 'The AI paints only the new areas — your original stays pixel-sharp.'
    : t === 'sharpen' ? 'AI reconstruction for pixelated or soft photos. Detail is <b>re-imagined, not recovered</b> — faces come out best.'
    : t === 'unblur' ? 'True deblurring for shaky or out-of-focus photos — the AI reverses the blur itself. Same size in, same size out.'
    : 'Every line is its own layer — font, size, color, position, rotation. Text alone is free, no credit needed.';
  // extend: drawPreview()->updateSizeInfo() refreshes wsOrig/wsNew + previewInfo right after this
  if (t === 'sharpen' || t === 'unblur') $('previewInfo').textContent = 'Dashed frame shows exactly what you will receive.';
  else if (t === 'text') $('previewInfo').textContent = 'Click the preview or Open text editor to edit.';
}
function selectTool(t) {
  activeTool = t;
  document.querySelectorAll('.ws-tab').forEach(b => {
    const on = b.dataset.tool === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('wsExtendTab').hidden = t !== 'extend';
  $('wsSharpenTab').hidden = t !== 'sharpen';
  $('wsUnblurTab').hidden = t !== 'unblur';
  $('wsTextTab').hidden = t !== 'text';
  $('previewCanvas').hidden = t !== 'extend';
  $('shPreviewCanvas').hidden = t !== 'sharpen' && t !== 'unblur';
  $('textCanvas').hidden = t !== 'text';
  syncWsInfo();
  if (t === 'sharpen') updateSharpenUI();
  else if (t === 'unblur') updateUnblurUI();
  else if (t === 'text') updateTextUI();
  else { drawPreview(); updateExtendUI(); }
}
document.querySelectorAll('.ws-tab').forEach(b => b.onclick = () => selectTool(b.dataset.tool));
/* Cross-links that jump to a workspace tab (e.g. "…or you may want to Sharpen"). */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-goto-tool]');
  if (!t || $('workspace').hidden) return;
  e.preventDefault();
  selectTool(t.dataset.gotoTool);
});
/* interactive preview controls (jsm-image style) */
$('replaceImgBtn').onclick = () => $('fileInput').click();
$('showOrigBtn').onclick = () => setPreviewMode('original');
$('showPlanBtn').onclick = () => setPreviewMode('planned');
/* "New image" buttons under each result card: clear results, pick a fresh image */
function newImage() {
  ['resultWrap', 'shResultWrap', 'unResultWrap'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
  $('fileInput').click();
}
$('newImageBtn').onclick = newImage;
$('shNewBtn').onclick = newImage;
$('unNewBtn').onclick = newImage;
/* "Sharpen this" under the Extend result: chain the extended image into the Sharpen tab */
$('sharpenThisBtn').onclick = async () => {
  const src = $('baAfterEx').src;
  if (!src) return;
  ['resultWrap', 'shResultWrap', 'unResultWrap'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
  try {
    setUploadedImage(await loadImage(src));
    selectTool('sharpen');
  } catch (e) { alert('Could not load the extended image.'); }
};
/* dropdown open/close */
$('ratioDDBtn').onclick = e => { e.stopPropagation(); toggleRatioMenu(); };
document.addEventListener('click', e => { if (!$('ratioDD').contains(e.target)) closeRatioMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRatioMenu(); });

/* ---------- sharpen flow ---------- */
const SH_MAX_PIXELS = 2000000; // real-esrgan OOMs above 2096704 total px on this GPU; keep a safety margin
let shScale = 1;
let sharpenSrc = null; // { img, w, h } — an extend result; overrides the upload as the sharpen source when set
function shImg() { return (sharpenSrc && sharpenSrc.img) || imgEl; }
function shIW() { return (sharpenSrc && sharpenSrc.w) || imgW; }
function shIH() { return (sharpenSrc && sharpenSrc.h) || imgH; }
function sharpenInputDims() {
  // Cap TOTAL pixels, not just the longest side: a 1500x1500 square (2.25M px)
  // passes a side-cap but blows the GPU memory limit.
  const s = Math.min(1, Math.sqrt(SH_MAX_PIXELS / (shIW() * shIH())));
  // floor (not round): rounding w and h independently can land 1px over the cap
  return { w: Math.max(1, Math.floor(shIW() * s)), h: Math.max(1, Math.floor(shIH() * s)) };
}
function sharpenInputDataUrl() {
  const { w, h } = sharpenInputDims();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(shImg(), 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.92);
}
function updateSharpenUI() {
  if (!shImg()) return;
  const { w, h } = sharpenInputDims();
  const ow = w * shScale, oh = h * shScale;
  $('wsOrig').textContent = `${w.toLocaleString()} × ${h.toLocaleString()} px`;
  $('wsNew').textContent = shScale === 1
    ? `${ow.toLocaleString()} × ${oh.toLocaleString()} px — AI-enhanced, same size`
    : `${ow.toLocaleString()} × ${oh.toLocaleString()} px`;
  drawSharpenPreview();
}
/* Sharpen preview: the uploaded photo centered inside the output frame,
   new-pixel area tinted — the same visual language as the Extend preview. */
function drawSharpenPreview() {
  // drawImage silently no-ops on an incomplete image — never paint blank.
  const simg = shImg();
  if (!simg || !simg.complete || !simg.naturalWidth) {
    if (simg) simg.addEventListener('load', drawSharpenPreview, { once: true });
    return;
  }
  const { w, h } = sharpenInputDims();
  const c = $('shPreviewCanvas');
  if (previewMode === 'original') { drawOriginalPreview(c, 640, simg, shIW(), shIH()); return; }
  const ow = w * shScale, oh = h * shScale;
  const s = Math.min(1, 640 / Math.max(ow, oh));
  c.width = Math.max(1, Math.round(ow * s));
  c.height = Math.max(1, Math.round(oh * s));
  const x = c.getContext('2d');
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2563eb';
  x.globalAlpha = 0.12; x.fillRect(0, 0, c.width, c.height); x.globalAlpha = 1;
  const iw = w * s, ih = h * s;
  x.drawImage(simg, (c.width - iw) / 2, (c.height - ih) / 2, iw, ih);
  x.strokeStyle = '#2563eb'; x.setLineDash([6, 4]); x.lineWidth = 2;
  x.strokeRect(1, 1, c.width - 2, c.height - 2); x.setLineDash([]);
}
document.querySelectorAll('#shScaleSeg button').forEach(b => b.onclick = () => {
  shScale = parseInt(b.dataset.scale, 10);
  document.querySelectorAll('#shScaleSeg button').forEach(x => x.classList.toggle('active', x === b));
  updateSharpenUI();
});
/* ---------- extend → enhance chain ---------- */
let chainScale = 1;
document.querySelectorAll('#chainScaleSeg button').forEach(b => b.onclick = () => {
  chainScale = parseInt(b.dataset.scale, 10);
  document.querySelectorAll('#chainScaleSeg button').forEach(x => x.classList.toggle('active', x === b));
  updateExtendUI();
});
$('chainSharpen').onchange = () => {
  $('chainScaleSeg').hidden = !$('chainSharpen').checked;
  updateExtendUI();
  syncWsInfo(); // left-card Cost row: 2 credits per extension + sharpen
};
// Sharpen the just-finished extend result (text-free) with the chained scale,
// then land on the Sharpen tab showing the final result.
async function runChainedSharpen() {
  if (!lastClean) return;
  if (balance < 1) { openModal(); return; } // extend already took its credit
  sharpenSrc = { img: lastClean, w: lastClean.naturalWidth, h: lastClean.naturalHeight };
  shScale = chainScale;
  document.querySelectorAll('#shScaleSeg button').forEach(x => x.classList.toggle('active', +x.dataset.scale === chainScale));
  await runSharpen();
  selectTool('sharpen');
}
// Manual path: load the extend result into the Sharpen tab (user picks scale, then runs).
$('sharpenResultBtn').onclick = () => {
  if (!lastClean) return;
  sharpenSrc = { img: lastClean, w: lastClean.naturalWidth, h: lastClean.naturalHeight };
  selectTool('sharpen');
};
/* GPU OOM (and similar infra errors) come back as raw technical dumps;
   translate them into something a human can act on. */
function friendlyAiError(msg) {
  msg = String(msg || '');
    if (/out of memory/i.test(msg))
    return 'The AI\u2019s GPU ran out of memory \u2014 it was already nearly full, so this is usually temporary. Wait a minute and try again; if it keeps failing, use a smaller image.';
  if (/NSFW|flagged/i.test(msg))
    return 'The AI declined this image (content filter). Try a different photo.';
  return msg;
}
async function runSharpen() {
  if (!shImg()) return;
  if (balance < 1) { openModal(); return; } // server re-checks anyway
  $('shProgress').hidden = false;
  $('shResultWrap').hidden = true;
  $('shErr').hidden = true;
  $('sharpenBtn').disabled = true;
  try {
    // The server atomically deducts 1 credit; the returned balance is authoritative.
    // 1x = enhance at original size: run the model at 2x, then size back down.
    const modelScale = shScale === 1 ? 2 : shScale;
    const r = await backend.sharpen(sharpenInputDataUrl(), modelScale, store.token);
    setBalance(r.credits);
    const ai = await loadImage(r.image_b64); // data: URL — can never taint
    const { w, h } = sharpenInputDims();
    let outUrl = r.image_b64, ow = ai.naturalWidth, oh = ai.naturalHeight;
    if (shScale === 1) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(ai, 0, 0, w, h);
      outUrl = c.toDataURL('image/png');
      ow = w; oh = h;
    }
    // before image at the same aspect; CSS scales both to the wrap
    const bc = document.createElement('canvas');
    bc.width = w; bc.height = h;
    bc.getContext('2d').drawImage(shImg(), 0, 0, w, h);
    $('baBeforeSh').src = bc.toDataURL('image/jpeg', 0.9);
    $('baAfterSh').src = outUrl;
    $('baWrapSh').style.setProperty('--pos', '50%');
    $('shDownloadBtn').href = outUrl;
    $('shDownloadBtn').download = `jsm-sharpen-${ow}x${oh}.png`;
    $('shResultSize').textContent = `${ow.toLocaleString()} × ${oh.toLocaleString()} px PNG`;
    $('shResultWrap').hidden = false;
    $('demoBanner').hidden = !r.mock;
    $('shResultWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    if (e.code === 402) { setBalance(0); openModal(); return; } // server says empty
    /* Never claim "no credit was used": the debit happens server-side, so
       only the server knows the truth. Refresh and report it. */
    await refreshBalance();
    const err = $('shErr');
    err.textContent = 'Sharpen failed: ' + friendlyAiError(e.message || e) + ` Your balance: ${balance} credit${balance === 1 ? '' : 's'}.`;
    err.hidden = false;
    $('shResultWrap').hidden = true;
  } finally {
    $('shProgress').hidden = true;
    $('sharpenBtn').disabled = false;
    updateSharpenUI();
  }
}
$('sharpenBtn').onclick = runSharpen;

/* ---------- unblur ---------- */
const UN_MAX_SIDE = 2048; // NAFNet returns input resolution; cap longest side for speed
function unblurInput() {
  const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
  const s = Math.min(1, UN_MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(imgEl, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height };
}
function updateUnblurUI() {
  if (!imgEl) return;
  const { w, h } = unblurInput();
  $('wsOrig').textContent = `${imgEl.naturalWidth.toLocaleString()} × ${imgEl.naturalHeight.toLocaleString()} px`;
  $('wsNew').textContent = `${w.toLocaleString()} × ${h.toLocaleString()} px — deblurred, same size`;
  drawUnblurPreview();
}
/* Unblur preview: the uploaded photo with the dashed "what you receive" frame,
   same visual language as the Sharpen preview (reuses its canvas). */
function drawUnblurPreview() {
  const simg = imgEl;
  if (!simg || !simg.complete || !simg.naturalWidth) return;
  const { w, h } = unblurInput();
  const c = $('shPreviewCanvas');
  const s = Math.min(1, 640 / Math.max(w, h));
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const x = c.getContext('2d');
  x.drawImage(simg, 0, 0, c.width, c.height);
  x.strokeStyle = '#2563eb'; x.setLineDash([6, 4]); x.lineWidth = 2;
  x.strokeRect(1, 1, c.width - 2, c.height - 2); x.setLineDash([]);
}
async function runUnblur() {
  if (!imgEl) return;
  if (balance < 1) { openModal(); return; } // server re-checks anyway
  $('unProgress').hidden = false;
  $('unResultWrap').hidden = true;
  $('unErr').hidden = true;
  $('unblurBtn').disabled = true;
  try {
    // The server atomically deducts 1 credit; the returned balance is authoritative.
    const src = unblurInput();
    const r = await backend.unblur(src.url, store.token);
    setBalance(r.credits);
    const outUrl = r.image_b64 || r.image_url;
    const outImg = await loadImage(outUrl);
    // before/after: pixel-aligned — "before" is exactly what was sent to the AI
    $('baBeforeUn').src = src.url;
    $('baAfterUn').src = outUrl;
    $('baWrapUn').style.setProperty('--pos', '50%');
    $('unDownloadBtn').href = outUrl;
    $('unDownloadBtn').download = `jsm-unblur-${outImg.naturalWidth}x${outImg.naturalHeight}.png`;
    $('unResultSize').textContent = `${outImg.naturalWidth.toLocaleString()} × ${outImg.naturalHeight.toLocaleString()} px PNG`;
    $('unResultWrap').hidden = false;
    $('demoBanner').hidden = !r.mock;
    $('unResultWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    if (e.code === 402) { setBalance(0); openModal(); return; } // server says empty
    /* Never claim "no credit was used": the debit happens server-side, so
       only the server knows the truth. Refresh and report it. */
    await refreshBalance();
    const err = $('unErr');
    err.textContent = 'Unblur failed: ' + friendlyAiError(e.message || e) + ` Your balance: ${balance} credit${balance === 1 ? '' : 's'}.`;
    err.hidden = false;
    $('unResultWrap').hidden = true;
  } finally {
    $('unProgress').hidden = true;
    $('unblurBtn').disabled = false;
  }
}
$('unblurBtn').onclick = runUnblur;

/* before/after compare sliders (extend + sharpen + unblur) */
['baWrapEx', 'baWrapSh', 'baWrapUn'].forEach(wrapId => {
  const wrap = $(wrapId);
  let drag = false;
  const setPos = e => {
    const r = wrap.getBoundingClientRect();
    const x = Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100));
    wrap.style.setProperty('--pos', x + '%');
  };
  wrap.addEventListener('pointerdown', e => { drag = true; wrap.setPointerCapture(e.pointerId); setPos(e); });
  wrap.addEventListener('pointermove', e => { if (drag) setPos(e); });
  wrap.addEventListener('pointerup', () => drag = false);
  wrap.addEventListener('pointercancel', () => drag = false);
});

/* ---------- buy + redeem ---------- */
function resetBuyModal() {
  $('payHint').textContent = DEMO
    ? 'Demo mode: the PayPal and card buttons simulate a payment and issue a test code.'
    : `Secure checkout via PayPal or card. $5 → 50 credits, $10 → 100, $15 → 150.`;
  const m = $('redeemMsg'); m.className = 'muted'; m.textContent = '';
}
resetBuyModal();

/* ---------- pack selector ($5 default, $10 / $15 optional) ---------- */
let selectedPack = CONFIG.PACKS[0];
function renderPacks() {
  const row = $('packRow'); if (!row) return;
  row.innerHTML = '';
  CONFIG.PACKS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pack-btn' + (p.id === selectedPack.id ? ' active' : '');
    const amt = document.createElement('b'); amt.textContent = '$' + p.usd;
    const cr = document.createElement('span'); cr.textContent = p.credits + ' credits';
    b.append(amt, cr);
    b.onclick = () => { selectedPack = p; renderPacks(); updateBuyLabels(); };
    row.appendChild(b);
  });
}
function updateBuyLabels() {
  $('paypalBuyBtn').textContent = `🅿 Pay $${selectedPack.usd} with PayPal`;
  $('stripeBuyBtn').textContent = `💳 Pay $${selectedPack.usd} with Card`;
}
/* Landing-page pricing cards jump straight to checkout with a pack preselected. */
function openModalWithPack(packId) {
  const p = CONFIG.PACKS.find(x => x.id === packId);
  if (p) { selectedPack = p; renderPacks(); updateBuyLabels(); }
  openModal();
}

async function startPurchase(kind) {
  const btn = $(kind === 'stripe' ? 'stripeBuyBtn' : 'paypalBuyBtn');
  btn.disabled = true;
  $('payHint').textContent = kind === 'stripe' ? 'Opening secure card checkout…' : 'Opening PayPal…';
  try {
    const r = await (kind === 'stripe' ? backend.buyStripe(selectedPack.id) : backend.buyCoffee(selectedPack.id));
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
    '<p class="code-note small">📸 Take a screenshot of this code and keep it safe — it works even if you clear your browser. ' +
    'Single-use: once redeemed, your remaining credits live in this browser\'s wallet.</p>' +
    '<div><button type="button" class="btn btn-primary" id="codeOkBtn">OK</button></div></div>';
  $('payHint').querySelector('.code-value').textContent = code;
  $('codeInput').value = code;
  $('redeemMsg').className = 'muted'; $('redeemMsg').textContent = '';
  // OK tucks the banner away shortly; an ignored banner tidies itself up anyway
  let dismissed = false;
  const dismissCode = () => { if (dismissed) return; dismissed = true; resetBuyModal(); };
  $('codeOkBtn').onclick = e => { e.target.disabled = true; setTimeout(dismissCode, 600); };
  setTimeout(dismissCode, 15000);
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
    // let the success register, then dismiss and leave a clean modal behind
    setTimeout(() => { closeModal(); resetBuyModal(); }, 1600);
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
renderPacks();
updateBuyLabels();
$('demoBanner').hidden = !DEMO;


/* ---------- Step 4: text studio (layer-based fullscreen editor) ---------- */
/* Curated popular Google Fonts (loaded on demand, never all at once). */
const FONTS = [
  { name: 'Anton', cat: 'Display' }, { name: 'Bebas Neue', cat: 'Display' },
  { name: 'Archivo Black', cat: 'Display' }, { name: 'Oswald', cat: 'Display' },
  { name: 'Fjalla One', cat: 'Display' }, { name: 'Alfa Slab One', cat: 'Display' },
  { name: 'Bungee', cat: 'Display' }, { name: 'Titan One', cat: 'Display' },
  { name: 'Luckiest Guy', cat: 'Display' }, { name: 'Russo One', cat: 'Display' },
  { name: 'Orbitron', cat: 'Display' }, { name: 'Audiowide', cat: 'Display' },
  { name: 'Barlow Condensed', cat: 'Display' },
  { name: 'Montserrat', cat: 'Sans' }, { name: 'Poppins', cat: 'Sans' },
  { name: 'Raleway', cat: 'Sans' }, { name: 'Work Sans', cat: 'Sans' },
  { name: 'Inter', cat: 'Sans' }, { name: 'Roboto', cat: 'Sans' },
  { name: 'Open Sans', cat: 'Sans' }, { name: 'Lato', cat: 'Sans' },
  { name: 'Playfair Display', cat: 'Serif' }, { name: 'Merriweather', cat: 'Serif' },
  { name: 'Lobster', cat: 'Script' }, { name: 'Pacifico', cat: 'Script' },
  { name: 'Dancing Script', cat: 'Script' }, { name: 'Caveat', cat: 'Script' },
  { name: 'Pinyon Script', cat: 'Script' },
  { name: 'Bodoni Moda', cat: 'Serif' },
   { name: 'Fredoka', cat: 'Rounded' }, { name: 'Baloo 2', cat: 'Rounded' },
];
/* Each text line is an independent layer: own font, size, color, position,
   rotation and style — like a real text editor, tools edit the selection. */
let textLayers = [];
let selectedId = null;
let layerSeq = 0;
let lastAi = null;    // Image: AI working-size result (for re-burning text)
let lastClean = null; // Image: final without text (AI + crisp original)
let lastFinal = null; // Image: final composited result (with text)

const sel = () => textLayers.find(l => l.id === selectedId) || null;
function addLayer(text) {
  const l = {
    id: 't' + (++layerSeq), text: text == null ? 'New text' : text,
    font: 'Anton', sizePct: 11, color: '#ffffff', bold: true, outline: true,
    tracking: 2, xPct: 50, yPct: 70, align: 'center', rotation: 0, visible: true,
  };
  textLayers.push(l);
  selectedId = l.id;
  return l;
}

const loadedFonts = new Set();
function ensureFont(name) {
  if (loadedFonts.has(name)) return Promise.resolve();
  loadedFonts.add(name);
  const fam = name.replace(/ /g, '+');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${fam}:wght@400;700&display=swap`;
  document.head.appendChild(link);
  const timeout = new Promise(res => setTimeout(res, 3500));
  let loaded = Promise.resolve();
  try { loaded = document.fonts.load(`700 40px "${name}"`).catch(() => {}); } catch (e) {}
  return Promise.race([loaded, timeout]);
}

const hitCtx = document.createElement('canvas').getContext('2d');
function measureLayer(l, W) {
  const size = Math.max(8, W * l.sizePct / 100);
  hitCtx.font = `${l.bold ? 700 : 400} ${size}px "${l.font}", sans-serif`;
  let w = 0;
  try { w = hitCtx.measureText(l.text).width + l.tracking * Math.max(0, l.text.length - 1); } catch (e) {}
  return { w, h: size * 1.25, size };
}
function drawLayer(ctx, l, W, H) {
  const size = Math.max(8, W * l.sizePct / 100);
  ctx.save();
  ctx.translate(W * l.xPct / 100, H * l.yPct / 100);
  ctx.rotate(l.rotation * Math.PI / 180);
  ctx.font = `${l.bold ? 700 : 400} ${size}px "${l.font}", sans-serif`;
  ctx.textAlign = l.align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  try { ctx.letterSpacing = l.tracking + 'px'; } catch (e) {}
  if (l.outline) {
    ctx.lineWidth = Math.max(2, size / 9);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(l.text, 0, 0);
  }
  ctx.fillStyle = l.color;
  ctx.fillText(l.text, 0, 0);
  ctx.restore();
}
function drawLayers(ctx, W, H) {
  for (const l of textLayers) {
    if (l.visible && l.text.trim()) drawLayer(ctx, l, W, H);
  }
}
/* Hit test: is canvas point (px,py, in backing px) on layer l? */
function layerHit(l, px, py, cw, ch) {
  if (!l.visible || !l.text.trim()) return false;
  const { w, h } = measureLayer(l, cw);
  const cx = cw * l.xPct / 100, cy = ch * l.yPct / 100;
  const dx = px - cx, dy = py - cy;
  const a = -l.rotation * Math.PI / 180;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  const x0 = l.align === 'center' ? -w / 2 : l.align === 'right' ? -w : 0;
  return lx >= x0 - 8 && lx <= x0 + w + 8 && ly >= -h / 2 - 8 && ly <= h / 2 + 8;
}

/* Base composition without text: clean AI result if extended, else the
   original placed on the chosen canvas. */
function baseComposition() {
  const c = document.createElement('canvas');
  if (lastClean) {
    c.width = lastClean.naturalWidth; c.height = lastClean.naturalHeight;
    c.getContext('2d').drawImage(lastClean, 0, 0);
  } else {
    const C = currentCanvas();
    c.width = C.tw; c.height = C.th;
    c.getContext('2d').drawImage(imgEl, C.ox, C.oy, C.ow, C.oh);
  }
  return c;
}
/* Full-resolution export: base + text layers. */
function composeDownload() {
  const base = baseComposition();
  drawLayers(base.getContext('2d'), base.width, base.height);
  return base;
}
/* Small card preview. */
function drawTextPreview() {
  if (!imgEl) return null;
  const src = previewMode === 'original' ? baseComposition() : composeDownload();
  const c = $('textCanvas');
  const s = Math.min(1, 900 / Math.max(src.width, src.height));
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const n = textLayers.length;
  $('layerCount').textContent = n
    ? `${n} text layer${n > 1 ? 's' : ''} — open the editor to edit.`
    : 'No text yet — open the editor to add some.';
  return src;
}
/* Text tab: refresh preview + info rows (output = text composition size). */
function updateTextUI() {
  const src = drawTextPreview();
  if (!src) return;
  $('wsOrig').textContent = `${imgW.toLocaleString()} × ${imgH.toLocaleString()} px`;
  $('wsNew').textContent = `${src.width.toLocaleString()} × ${src.height.toLocaleString()} px`;
}
/* Re-burn the current layers into the last AI result (after edits post-extend). */
async function refreshFinal() {
  if (!lastAi) return;
  const C = currentCanvas();
  const fin = await finishResult(lastAi.src);
  showExtendResult(fin, C);
  drawTextPreview();
}

/* ---------- fullscreen editor ---------- */
function drawEditorCanvas() {
  const base = baseComposition();
  const c = $('editorCanvas');
  const s = Math.min(1, 1600 / Math.max(base.width, base.height));
  c.width = Math.max(1, Math.round(base.width * s));
  c.height = Math.max(1, Math.round(base.height * s));
  const x = c.getContext('2d');
  x.drawImage(base, 0, 0, c.width, c.height);
  drawLayers(x, c.width, c.height);
  const l = sel();
  if (l && l.visible && l.text.trim()) {
    const { w, h } = measureLayer(l, c.width);
    x.save();
    x.translate(c.width * l.xPct / 100, c.height * l.yPct / 100);
    x.rotate(l.rotation * Math.PI / 180);
    x.strokeStyle = '#3b82f6';
    x.lineWidth = 2;
    x.setLineDash([8, 5]);
    const x0 = l.align === 'center' ? -w / 2 : l.align === 'right' ? -w : 0;
    x.strokeRect(x0 - 10, -h / 2 - 10, w + 20, h + 16);
    x.restore();
  }
}
async function renderEditor() {
  if (!imgEl) return;
  await Promise.all(textLayers.map(l => ensureFont(l.font)));
  drawEditorCanvas();
  renderLayerList();
  syncTools();
}
let textRaf = 0;
function refreshText() {
  cancelAnimationFrame(textRaf);
  textRaf = requestAnimationFrame(async () => {
    await renderEditor();
    drawTextPreview();
    if (lastAi) await refreshFinal();
  });
}
function openEditor() {
  if (!imgEl) return;
  $('textEditorOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  renderEditor();
}
function closeEditor() {
  $('textEditorOverlay').hidden = true;
  document.body.style.overflow = '';
  drawTextPreview();
}

/* ---------- layers list ---------- */
function moveLayer(i, d) {
  const j = i + d;
  if (j < 0 || j >= textLayers.length) return;
  [textLayers[i], textLayers[j]] = [textLayers[j], textLayers[i]];
  renderLayerList();
  drawEditorCanvas();
}
function dupLayer(l) {
  const c = { ...l, id: 't' + (++layerSeq), xPct: Math.min(96, l.xPct + 4), yPct: Math.min(96, l.yPct + 6) };
  textLayers.push(c);
  selectedId = c.id;
  refreshText();
}
function delLayer(id) {
  const i = textLayers.findIndex(l => l.id === id);
  if (i < 0) return;
  textLayers.splice(i, 1);
  if (selectedId === id) selectedId = textLayers.length ? textLayers[Math.min(i, textLayers.length - 1)].id : null;
  refreshText();
}
function renderLayerList() {
  const list = $('layerList');
  list.innerHTML = '';
  $('noLayer').hidden = textLayers.length > 0;
  $('layerTools').hidden = !sel();
  for (let i = textLayers.length - 1; i >= 0; i--) {
    const l = textLayers[i];
    const row = document.createElement('div');
    row.className = 'layer-row' + (l.id === selectedId ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'lr-dot'; dot.style.background = l.color;
    const tx = document.createElement('span');
    tx.className = 'lr-text';
    tx.textContent = l.text.trim() || '(empty)';
    tx.style.fontFamily = `"${l.font}", sans-serif`;
    tx.title = 'Select layer';
    tx.onclick = () => { selectedId = l.id; renderLayerList(); syncTools(); drawEditorCanvas(); };
    const mkBtn = (t, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t; b.title = title;
      b.onclick = e => { e.stopPropagation(); fn(); };
      return b;
    };
    row.append(dot, tx);
    row.append(mkBtn('⬆', 'Bring forward', () => moveLayer(i, 1)));
    row.append(mkBtn('⬇', 'Send backward', () => moveLayer(i, -1)));
    row.append(mkBtn('⧉', 'Duplicate', () => dupLayer(l)));
    row.append(mkBtn(l.visible ? '👁' : '🚫', 'Show/hide', () => { l.visible = !l.visible; refreshText(); }));
    row.append(mkBtn('🗑', 'Delete', () => delLayer(l.id)));
    list.appendChild(row);
  }
}

/* ---------- per-layer tools (edit the selected layer) ---------- */
function syncTools() {
  const l = sel();
  $('layerTools').hidden = !l;
  if (!l) return;
  $('edText').value = l.text;
  $('fontBtnName').textContent = l.font;
  $('fontBtnSample').style.fontFamily = `"${l.font}", sans-serif`;
  $('textSize').value = l.sizePct;
  $('textSizeVal').textContent = l.sizePct.toFixed(1) + '% of width';
  $('edX').value = l.xPct; $('xVal').textContent = Math.round(l.xPct) + '%';
  $('edY').value = l.yPct; $('yVal').textContent = Math.round(l.yPct) + '%';
  $('edRot').value = l.rotation; $('rotVal').textContent = Math.round(l.rotation) + '°';
  $('alignRow').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.align === l.align));
  $('textColor').value = l.color;
  $('swatches').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.title === l.color));
  $('textBold').checked = l.bold;
  $('textOutline').checked = l.outline;
  $('textTrack').value = l.tracking;
  $('trackVal').textContent = l.tracking + 'px';
  buildFontList($('fontFilter').value);
}
function buildFontList(filter) {
  const list = $('fontList');
  list.innerHTML = '';
  const q = (filter || '').trim().toLowerCase();
  let lastCat = '', n = 0;
  FONTS.filter(f => f.name.toLowerCase().includes(q)).forEach(f => {
    if (f.cat !== lastCat) {
      lastCat = f.cat;
      const h = document.createElement('div');
      h.className = 'font-cat'; h.textContent = f.cat;
      list.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'font-item' + (sel() && f.name === sel().font ? ' active' : '');
    b.setAttribute('role', 'option');
    const ag = document.createElement('span'); ag.className = 'font-ag'; ag.textContent = 'Ag';
    const nm = document.createElement('span'); nm.textContent = f.name;
    b.append(ag, nm);
    if (loadedFonts.has(f.name)) b.style.fontFamily = `"${f.name}", sans-serif`;
    b.addEventListener('mouseenter', () => {
      ensureFont(f.name).then(() => { b.style.fontFamily = `"${f.name}", sans-serif`; });
    });
    b.onclick = () => selectFont(f.name);
    list.appendChild(b);
    n++;
  });
  if (!n) list.innerHTML = '<div class="muted small" style="padding:10px">No fonts match.</div>';
}
function selectFont(name) {
  const l = sel(); if (!l) return;
  l.font = name;
  $('fontBtnName').textContent = name;
  $('fontBtnSample').style.fontFamily = `"${name}", sans-serif`;
  $('fontDrop').hidden = true;
  $('fontBtn').setAttribute('aria-expanded', 'false');
  buildFontList($('fontFilter').value);
  ensureFont(name).then(refreshText);
}
function initFontPicker() {
  const btn = $('fontBtn'), drop = $('fontDrop'), filter = $('fontFilter');
  buildFontList('');
  btn.onclick = e => {
    e.stopPropagation();
    const open = drop.hidden;
    drop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { filter.value = ''; buildFontList(''); filter.focus(); }
  };
  filter.addEventListener('input', () => buildFontList(filter.value));
  filter.addEventListener('click', e => e.stopPropagation());
  drop.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => { drop.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { drop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
}

function initTextEditor() {
  // Editor-level Escape first: closes the editor only when the font dropdown is already closed.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('textEditorOverlay').hidden && $('fontDrop').hidden) closeEditor();
  });
  initFontPicker();
  $('openEditor').onclick = openEditor;
  $('textCanvas').onclick = openEditor;
  $('editorDone').onclick = closeEditor;
  $('editorClose').onclick = closeEditor;
  $('editorReset').onclick = () => { textLayers = []; selectedId = null; refreshText(); };
  $('layerAdd').onclick = () => {
    addLayer();
    refreshText();
    setTimeout(() => { const t = $('edText'); t.focus(); t.select(); }, 80);
  };
  $('layerDup').onclick = () => { const l = sel(); if (l) dupLayer(l); };
  $('layerDel').onclick = () => { if (selectedId) delLayer(selectedId); };
  $('edText').addEventListener('input', e => { const l = sel(); if (l) { l.text = e.target.value; refreshText(); } });
  $('textSize').addEventListener('input', e => {
    const l = sel(); if (!l) return;
    l.sizePct = parseFloat(e.target.value);
    $('textSizeVal').textContent = l.sizePct.toFixed(1) + '% of width';
    refreshText();
  });
  $('edX').addEventListener('input', e => {
    const l = sel(); if (!l) return;
    l.xPct = parseFloat(e.target.value);
    $('xVal').textContent = Math.round(l.xPct) + '%';
    refreshText();
  });
  $('edY').addEventListener('input', e => {
    const l = sel(); if (!l) return;
    l.yPct = parseFloat(e.target.value);
    $('yVal').textContent = Math.round(l.yPct) + '%';
    refreshText();
  });
  $('edRot').addEventListener('input', e => {
    const l = sel(); if (!l) return;
    l.rotation = parseFloat(e.target.value);
    $('rotVal').textContent = Math.round(l.rotation) + '°';
    refreshText();
  });
  $('alignRow').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      const l = sel(); if (!l) return;
      l.align = b.dataset.align;
      $('alignRow').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      refreshText();
    };
  });
  const colorEl = $('textColor');
  const sw = ['#ffffff', '#f5c542', '#000000', '#dc2626', '#2563eb'];
  const swWrap = $('swatches');
  sw.forEach(hex => {
    const b = document.createElement('button');
    b.type = 'button'; b.style.background = hex; b.title = hex;
    b.onclick = () => {
      const l = sel(); if (!l) return;
      l.color = hex; colorEl.value = hex;
      swWrap.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      refreshText();
    };
    swWrap.appendChild(b);
  });
  colorEl.addEventListener('input', () => {
    const l = sel(); if (!l) return;
    l.color = colorEl.value;
    swWrap.querySelectorAll('button').forEach(x => x.classList.toggle('active', false));
    refreshText();
  });
  $('textBold').addEventListener('change', e => { const l = sel(); if (l) { l.bold = e.target.checked; refreshText(); } });
  $('textOutline').addEventListener('change', e => { const l = sel(); if (l) { l.outline = e.target.checked; refreshText(); } });
  $('textTrack').addEventListener('input', e => {
    const l = sel(); if (!l) return;
    l.tracking = parseInt(e.target.value, 10);
    $('trackVal').textContent = l.tracking + 'px';
    refreshText();
  });
  $('textDownload').onclick = () => {
    const src = composeDownload();
    const a = document.createElement('a');
    a.href = src.toDataURL('image/png');
    a.download = 'jsm-enhance-text.png';
    document.body.appendChild(a); a.click(); a.remove();
  };
  /* Canvas: click a layer to select it, drag to move it. */
  const ec = $('editorCanvas');
  let drag = null;
  const toBacking = e => {
    const r = ec.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * ec.width / r.width,
      y: (e.clientY - r.top) * ec.height / r.height,
    };
  };
  ec.addEventListener('pointerdown', e => {
    const p = toBacking(e);
    for (let i = textLayers.length - 1; i >= 0; i--) {
      const l = textLayers[i];
      if (layerHit(l, p.x, p.y, ec.width, ec.height)) {
        selectedId = l.id;
        renderLayerList(); syncTools(); drawEditorCanvas();
        drag = { id: l.id, dx: p.x - ec.width * l.xPct / 100, dy: p.y - ec.height * l.yPct / 100 };
        try { ec.setPointerCapture(e.pointerId); } catch (err) {}
        ec.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
    }
  });
  ec.addEventListener('pointermove', e => {
    if (!drag) return;
    const l = textLayers.find(x => x.id === drag.id);
    if (!l) { drag = null; return; }
    const p = toBacking(e);
    l.xPct = Math.round((p.x - drag.dx) / ec.width * 100);
    l.yPct = Math.round((p.y - drag.dy) / ec.height * 100);
    drawEditorCanvas();
    $('edX').value = l.xPct; $('xVal').textContent = Math.round(l.xPct) + '%';
    $('edY').value = l.yPct; $('yVal').textContent = Math.round(l.yPct) + '%';
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    ec.style.cursor = 'default';
    refreshText();
  };
  ec.addEventListener('pointerup', endDrag);
  ec.addEventListener('pointercancel', endDrag);
}
initTextEditor();
