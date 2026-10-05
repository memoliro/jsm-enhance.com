// Minimal DOM stub to smoke-test app.js top-level init + sample-button upload path.
const fs = require('fs');
const html = fs.readFileSync('/home/hatch/workspace/jsm-ai-extend/index.html', 'utf8');
const realIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
console.log('real IDs in index.html:', realIds.size);

function makeEl(id) {
  const el = {
    _id: id, hidden: true, value: '', files: [],
    textContent: '', innerHTML: '', src: '', href: '',
    style: { setProperty(){} },
    classList: { add(){}, remove(){}, toggle(){} },
    dataset: {},
    addEventListener(){}, removeEventListener(){},
    querySelector(){ return makeEl('q'); }, querySelectorAll(){ return []; },
    setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, append(){}, click(){}, focus(){}, scrollIntoView(){},
    getContext(){ return new Proxy({}, { get: (t, p) => (p === 'canvas' ? el : () => {}) , set: () => true }); },
    getBoundingClientRect(){ return { left: 0, width: 800 }; },
  };
  return el;
}
const els = {};
global.document = {
  getElementById: id => {
    if (!realIds.has(id)) return null;           // browser-accurate: null for missing
    return els[id] || (els[id] = makeEl(id));
  },
  createElement: tag => { const e = makeEl('anon-' + tag);
    e.querySelector = () => makeEl('anon-q'); e.querySelectorAll = () => [];
    e.append = (...a) => {}; return e; },
  querySelectorAll: () => [],
  querySelector: () => null,
  documentElement: makeEl('documentElement'),
  head: makeEl('head'),
  activeElement: null,
  addEventListener(){},
};
global.window = global;
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.location = { search: "", href: "https://jsm-enhance.com/" };
global.localStorage = { _s: {}, getItem(k){ return this._s[k] || null; }, setItem(k, v){ this._s[k] = v; }, removeItem(k){ delete this._s[k]; } };
global.navigator = { onLine: true };
global.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.alert = msg => { console.log('ALERT:', msg); };
global.fetch = () => Promise.reject(new Error('no network in test'));
// Image stub: successful load
global.Image = class {
  set src(v) { this._src = v; setTimeout(() => {
    this.naturalWidth = 800; this.naturalHeight = 600; this.complete = true;
    if (this.onload) this.onload();
  }, 5); }
};
global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL(){} };
global.document.fonts = { load: () => Promise.resolve() };

const src = fs.readFileSync('/home/hatch/workspace/jsm-ai-extend/app.js', 'utf8');
let failures = 0;
try {
  eval(src);
  console.log('TOP-LEVEL: no throw');
} catch (e) {
  console.log('TOP-LEVEL THROW:', e.message);
  console.log(e.stack.split('\n')[1]);
  failures++;
}
// simulate clicking "Try a sample"
const btn = document.getElementById('sampleBtn');
console.log('sampleBtn bound:', typeof btn.onclick === 'function');

// instrument: call the real setUploadedImage with a real-ish image, catch precisely
const __probe = async () => {
  const im = new Image();
  await new Promise((res, rej) => { im.onload = () => res(im); im.onerror = rej; im.src = 'x'; });
  try {
    setUploadedImage(im);
    console.log('setUploadedImage: OK, workspace hidden =', document.getElementById('workspace').hidden);
  } catch (e) {
    console.log('setUploadedImage THROW:', e.message);
    console.log((e.stack || '').split('\n').slice(0, 6).join('\n'));
    failures++;
  }
};
(async () => {
  await __probe();
  // "New image" buttons: unhide a result card, click, expect all result cards hidden
  try {
    for (const id of ['newImageBtn', 'shNewBtn', 'unNewBtn']) {
      const b = document.getElementById(id);
      if (!b || typeof b.onclick !== 'function') throw new Error(id + ' not wired');
    }
    document.getElementById('unResultWrap').hidden = false;
    document.getElementById('unNewBtn').onclick();
    for (const id of ['resultWrap', 'shResultWrap', 'unResultWrap']) {
      if (!document.getElementById(id).hidden) throw new Error(id + ' still visible after New image');
    }
    console.log('newImage buttons: OK');
    for (const id of ['sharpenThisBtn', 'editorReset']) {
      const b = document.getElementById(id);
      if (!b || typeof b.onclick !== 'function') throw new Error(id + ' not wired');
    }
    console.log('sharpenThis + editorReset: wired');
  } catch (e) {
    console.log('newImage buttons THROW:', e.message);
    failures++;
  }
  await new Promise(r => setTimeout(r, 100));
  console.log(failures ? 'SMOKE: FAIL' : 'SMOKE: PASS');
  process.exit(failures ? 1 : 0);
})();
