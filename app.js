'use strict';
/* Qadā’ — offline-first Umri tracker. Append-only event log in IndexedDB; all stats derived. */
const APP_VERSION = '1.1.0';
const DB_NAME = 'qaza-db';
const DB_VERSION = 3;

const PRAYERS = [
  { id: 'fajr',    en: 'Fajr',    ar: 'الفجر',   sub: '2 fard rak‘ahs' },
  { id: 'zuhr',    en: 'Zuhr',    ar: 'الظهر',   sub: '4 fard rak‘ahs' },
  { id: 'asr',     en: 'Asr',     ar: 'العصر',   sub: '4 fard rak‘ahs' },
  { id: 'maghrib', en: 'Maghrib', ar: 'المغرب',  sub: '3 fard rak‘ahs' },
  { id: 'isha',    en: 'Isha',    ar: 'العشاء',  sub: '4 fard rak‘ahs' },
  { id: 'witr',    en: 'Witr',    ar: 'الوتر',   sub: 'Wajib · per night' },
];
const MILESTONES = [1, 10, 50, 100, 500, 1000, 2500, 5000, 10000];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = new Intl.NumberFormat();
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
function buzz(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* noop */ } }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- IndexedDB (hand-rolled, versioned w/ migrations) ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const old = e.oldVersion;
      if (old < 1) {
        db.createObjectStore('events', { keyPath: 'id' });
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (old < 2) {
        // v2: index events by timestamp for fast history/heatmap
        try { req.transaction.objectStore('events').createIndex('by-at', 'at'); } catch { /* exists */ }
      }
      if (old < 3) {
        // v3: ensure kv store exists for installs that skipped v1 oddly
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let _db = null;
async function db() { if (!_db) _db = await openDB(); return _db; }
function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    if (out && out.onsuccess === null) { /* request */ }
  }));
}
const store = {
  async allEvents() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = d.transaction('events', 'readonly');
      const rq = t.objectStore('events').openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { out.push(c.value); c.continue(); } else resolve(out); };
      rq.onerror = () => reject(rq.error);
    });
  },
  async putEvent(ev) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('events', 'readwrite');
      t.objectStore('events').put(ev);
      t.oncomplete = () => resolve(ev);
      t.onerror = () => reject(t.error);
    });
  },
  async clearAll() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['events', 'kv'], 'readwrite');
      t.objectStore('events').clear();
      t.objectStore('kv').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async getKV(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', 'readonly');
      const rq = t.objectStore('kv').get(key);
      rq.onsuccess = () => resolve(rq.result ? rq.result.value : undefined);
      rq.onerror = () => reject(rq.error);
    });
  },
  async setKV(key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', 'readwrite');
      t.objectStore('kv').put({ key, value });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
};

/* ---------- State + reducer (pure, testable) ---------- */
const state = { events: [], kv: {}, onboarded: false, witr: true, theme: 'system', tab: 'home', lastUndoIds: [] };

function liveEvents(events) {
  const voided = new Set(events.filter(e => e.kind === 'void').map(e => e.target));
  return events.filter(e => e.kind !== 'void' && !voided.has(e.id));
}
/** Chronological order — IndexedDB cursors return key (UUID) order, which is
    meaningless. Absolute events (init/adjust) must apply in true time order. */
function ordered(events) {
  return liveEvents(events).slice().sort((a, b) =>
    (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)) || (a.id < b.id ? -1 : 1));
}
/** Derive {remaining, completed, initial} per prayer + totals from events. */
function computeStats(events, witrOn) {
  const rem = {}, done = {}, initial = {};
  for (const p of PRAYERS) { rem[p.id] = 0; done[p.id] = 0; initial[p.id] = 0; }
  for (const e of ordered(events)) {
    if (e.kind === 'init') { for (const p of PRAYERS) { rem[p.id] = e.counts[p.id] || 0; initial[p.id] = e.counts[p.id] || 0; } }
    else if (e.kind === 'complete') { const n = Math.min(e.n, rem[e.prayer] ?? 0); rem[e.prayer] = (rem[e.prayer] ?? 0) - n; done[e.prayer] = (done[e.prayer] ?? 0) + n; }
    else if (e.kind === 'day') { for (const p of activePrayers(witrOn)) { if (rem[p.id] > 0) { rem[p.id] -= 1; done[p.id] += 1; } } }
    else if (e.kind === 'add') { rem[e.prayer] = (rem[e.prayer] ?? 0) + e.n; }
    else if (e.kind === 'adjust') {
      const cur = rem[e.prayer] ?? 0;
      if (e.to >= cur) initial[e.prayer] = (initial[e.prayer] ?? 0) + (e.to - cur);
      rem[e.prayer] = e.to;
    }
  }
  const act = witrOn ? PRAYERS : PRAYERS.filter(p => p.id !== 'witr');
  const totRem = act.reduce((s, p) => s + rem[p.id], 0);
  const totDone = act.reduce((s, p) => s + done[p.id], 0);
  const totInit = act.reduce((s, p) => s + initial[p.id], 0);
  const pct = totInit === 0 ? (totDone > 0 ? 100 : 0) : Math.min(100, (totDone / totInit) * 100);
  return { rem, done, initial, totRem, totDone, totInit, pct };
}
function activePrayers(witrOn) { return witrOn ? PRAYERS : PRAYERS.filter(p => p.id !== 'witr'); }

/** Completions per calendar day (local) from live events. */
function completionsByDay(events, witrOn) {
  const map = new Map();
  const bump = (at, n) => { const k = dayKey(new Date(at)); map.set(k, (map.get(k) || 0) + n); };
  for (const e of ordered(events)) {
    if (e.kind === 'complete') bump(e.at, e.n);
    else if (e.kind === 'day') bump(e.at, activePrayers(witrOn).length);
  }
  return map;
}
function streaks(byDay) {
  const days = [...byDay.keys()].filter(k => byDay.get(k) > 0).sort();
  if (!days.length) return { cur: 0, best: 0 };
  const set = new Set(days);
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + 'T12:00'), cur = new Date(days[i] + 'T12:00');
    if ((cur - prev) / 864e5 === 1) run++; else { best = Math.max(best, run); run = 1; }
  }
  best = Math.max(best, run);
  let curStreak = 0;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  for (let i = 0; i < 4000; i++) {
    const d = new Date(today - i * 864e5);
    const k = dayKey(d);
    if (set.has(k)) curStreak++;
    else if (i === 0) continue; // today may still be logged later
    else break;
  }
  return { cur: curStreak, best };
}
function pace(byDay, n) {
  let s = 0;
  const t = new Date(); t.setHours(12, 0, 0, 0);
  for (let i = 0; i < n; i++) s += byDay.get(dayKey(new Date(t - i * 864e5))) || 0;
  return s / n;
}

/* ---------- Derived-state memo ----------
   Everything is derived from the log, but a tap must not pay for the whole
   log twice (append clamps, then render paints). Keyed on the only two
   things that can invalidate it: log length and the Witr toggle. */
let _memo = null;
function derived(forWitr = state.witr) {
  if (!_memo || _memo.n !== state.events.length || _memo.w !== forWitr) {
    _memo = {
      n: state.events.length, w: forWitr,
      stats: computeStats(state.events, forWitr),
      byDay: completionsByDay(state.events, forWitr),
    };
  }
  return _memo;
}

/* ---------- Mutations (all append-only + undoable) ---------- */
let _seqChain = Promise.resolve();
function nextSeq() {
  _seqChain = _seqChain.then(async () => {
    const cur = (await store.getKV('seq')) || 0;
    await store.setKV('seq', cur + 1);
    return cur + 1;
  });
  return _seqChain;
}
async function append(kind, payload = {}, msg) {
  // Clamp at write time so the recorded event is always truthful and undo
  // always moves the number (over-logging from rapid taps records nothing).
  if (kind === 'complete') {
    const rem = derived().stats.rem[payload.prayer] ?? 0;
    payload.n = Math.max(0, Math.min(payload.n, rem));
    if (payload.n === 0) { snack('Nothing left to log here.', null); return null; }
  }
  const ev = { id: uid(), at: Date.now(), seq: await nextSeq(), kind, ...payload };
  await store.putEvent(ev);
  state.events.push(ev);
  state.lastUndoIds = [ev.id];
  render();
  if (msg) snack(msg, [ev.id]);
  return ev;
}
async function undoIds(ids) {
  for (const id of ids) await store.putEvent({ id: uid(), at: Date.now(), seq: await nextSeq(), kind: 'void', target: id });
  state.events = await store.allEvents();
  _memo = null;
  state.lastUndoIds = [];
  render();
}

/* ---------- Snackbar ---------- */
let snackTimer = null;
function snack(msg, ids) {
  const bar = $('#snackbar');
  $('#snack-msg').textContent = msg;
  bar.hidden = false;
  const btn = $('#snack-undo');
  btn.style.display = ids && ids.length ? '' : 'none';
  btn.onclick = () => { hideSnack(); undoIds(ids); };
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideSnack, 8000);
}
function hideSnack() { $('#snackbar').hidden = true; }
$('#snack-close').addEventListener('click', hideSnack);

/* ---------- Theme ---------- */
function applyTheme() {
  const t = state.theme || 'system';
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  // Always resolve to a concrete attribute — never remove it. Component-level
  // [data-theme="dark"] overrides depend on it (see styles.css).
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0D1412' : '#F2EDE2');
  $('#themeBtn').setAttribute('aria-pressed', String(dark));
  const moon = $('#theme-moon'), sun = $('#theme-sun');
  // NB: .hidden doesn't reflect on SVG elements — use the attribute.
  if (moon && sun) { moon.toggleAttribute('hidden', dark); sun.toggleAttribute('hidden', !dark); }
  const sel = $('#set-theme');
  if (sel) sel.value = t;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* ---------- Onboarding ---------- */
function estimateCounts() {
  const b = Math.max(0, parseInt($('#ob-bulugh').value, 10) || 0);
  const n = Math.max(0, parseInt($('#ob-now').value, 10) || 0);
  const p = Math.max(0, parseInt($('#ob-prayed').value, 10) || 0);
  const yrs = Math.max(0, Math.min(n - b, 120));
  const missed = Math.max(0, yrs - Math.min(p, yrs));
  const per = Math.round(missed * 365.25);
  return { per, breakdown: `${missed} missed year${missed === 1 ? '' : 's'} × 365` };
}
function refreshEstimate() {
  const { per, breakdown } = estimateCounts();
  $('#est-total').textContent = fmt.format(per * 5 + (state.witr ? per : 0));
  $('#est-breakdown').textContent = `${fmt.format(per)} per prayer · ${breakdown}`;
}
/** Shared stepper builder: tap adjusts (±step, shift = ±100), typing sets exactly.
    onCommit fires on button tap, blur, or Enter — never per keystroke. */
function buildStepper({ label, step = 10, initial = 0, onCommit }) {
  const wrap = document.createElement('div');
  wrap.className = 'stepper';
  wrap.innerHTML = `<button type="button" data-step="-1" aria-label="Decrease ${label}">−</button>
    <input class="stepper-input" type="text" inputmode="numeric" autocomplete="off"
      value="0" aria-label="${label} — type a number, or use the buttons">
    <button type="button" data-step="1" aria-label="Increase ${label}">+</button>`;
  const input = $('.stepper-input', wrap);
  let v = initial;
  const set = (x) => { v = Math.max(0, Math.min(1000000, Math.round(Number(x) || 0))); };
  const paint = () => { input.value = fmt.format(v); };
  input.addEventListener('focus', () => { input.value = String(v); input.select(); });
  input.addEventListener('input', () => {
    const digits = input.value.replace(/[^\d]/g, '');
    if (digits !== input.value) input.value = digits;
    set(parseInt(digits, 10) || 0);
  });
  input.addEventListener('blur', () => { paint(); if (onCommit) onCommit(v); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    set(v + Number(b.dataset.step) * (e.shiftKey ? 100 : step));
    paint();
    buzz(8);
    if (onCommit) onCommit(v);
  });
  set(initial); paint();
  return { el: wrap, get: () => v, set: (x) => { set(x); paint(); } };
}

function buildExactGrid() {
  const g = $('#exact-grid'); g.innerHTML = '';
  for (const p of PRAYERS) {
    const cell = document.createElement('div');
    cell.className = 'exact-cell';
    cell.dataset.prayer = p.id;
    cell.innerHTML = `<span class="ar" lang="ar">${p.ar}</span><span class="en">${p.en}</span>`;
    const st = buildStepper({ label: `${p.en} count`, step: 10 });
    cell._get = st.get;
    cell.appendChild(st.el);
    g.appendChild(cell);
  }
}
function bindSwitch(el, get, set) {
  el.addEventListener('click', () => {
    set(!get());
    el.setAttribute('aria-checked', String(get()));
    const other = el.id === 'ob-witr' ? $('#ob-witr2') : el.id === 'ob-witr2' ? $('#ob-witr') : null;
    if (other) other.setAttribute('aria-checked', String(get()));
    refreshEstimate();
  });
}

/* ---------- Rendering ---------- */
function tweenNumber(el, to, format = fmt.format.bind(fmt)) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (tweenNumber.instant || matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 2) { el.textContent = format(to); return; }
  const t0 = performance.now(), dur = 600;
  (function tick(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = format(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(tick);
  })(t0);
}

function renderHome(stats) {
  tweenNumber($('#hero-remaining'), stats.totRem);
  $('#hero-done').textContent = `${fmt.format(stats.totDone)} made up`;
  const pct = Math.round(stats.pct);
  $('#hero-pct').textContent = `${pct}%`;
  const bar = $('#hero-progress');
  bar.setAttribute('aria-valuenow', pct);
  $('#hero-fill').style.width = `${pct}%`;

  const byDay = derived().byDay;
  tweenNumber($('#today-count'), byDay.get(dayKey()) || 0, (v) => String(v));

  const list = $('#prayer-list'); list.innerHTML = '';
  const freshList = !list.dataset.done;
  list.dataset.done = '1';
  if (!freshList) list.classList.add('played');
  activePrayers(state.witr).forEach((p, idx) => {
    const r = stats.rem[p.id], li = document.createElement('li');
    const tot = stats.done[p.id] + r;
    const pct = tot === 0 ? 0 : Math.round((stats.done[p.id] / tot) * 100);
    li.className = 'prayer-card' + (r === 0 ? ' is-clear' : '');
    li.style.setProperty('--i', idx);
    li.innerHTML = `
      <div><div class="prayer-top"><span class="prayer-ar" lang="ar">${p.ar}</span><span class="prayer-en">${p.en}</span></div>
      <p class="prayer-sub">${p.sub} · ${fmt.format(stats.done[p.id])} made up</p></div>
      <button type="button" class="logbtn" data-log="${p.id}" ${r === 0 ? 'disabled' : ''}
        aria-label="Log one ${p.en} made up. ${fmt.format(r)} remaining."><span class="plus" aria-hidden="true">+</span><span>1</span></button>
      <div class="prayer-count" aria-live="polite"><strong data-count="${p.id}">${fmt.format(r)}</strong>remaining</div>
      <div class="p-track" role="img" aria-label="${p.en} ${pct}% cleared"><i data-fill="${p.id}" style="width:${pct}%"></i></div>
      <div class="minibtns">
        <button type="button" class="minibtn" data-add5="${p.id}">+5</button>
        <button type="button" class="minibtn" data-undo-p="${p.id}">Undo last</button>
      </div>`;
    const cnt = $('[data-count]', li);
    cnt.dataset.v = r;
    list.appendChild(li);
  });
}

function ringSVG(pct, size = 64, draw = false) {
  const r = (size - 10) / 2, c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="7"/>
    <circle class="fg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="7"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${draw ? c.toFixed(1) : off.toFixed(1)}" ${draw ? `data-off="${off.toFixed(1)}"` : ''}/></svg>`;
}

function renderJourney(stats) {
  tweenNumber($('#st-remaining'), stats.totRem);
  tweenNumber($('#st-done'), stats.totDone);
  const byDay = derived().byDay;
  const { cur, best } = streaks(byDay);
  tweenNumber($('#st-streak'), cur, String);
  tweenNumber($('#st-best'), best, String);
  const p7 = pace(byDay, 7), p30 = pace(byDay, 30);
  $('#st-pace7').textContent = (Math.round(p7 * 10) / 10).toString();
  $('#st-pace30').textContent = (Math.round(p30 * 10) / 10).toString();
  const proj = $('#st-projection'), sub = $('#st-projection-sub');
  if (stats.totRem === 0 && stats.totInit > 0) { proj.textContent = 'All clear — alhamdulillah.'; sub.textContent = 'Your record shows no remaining debt.'; }
  else if (p7 < 0.2 && p30 < 0.2) { proj.textContent = '—'; sub.textContent = 'Log a few days to reveal a projection.'; }
  else {
    const rate = p7 >= 0.2 ? p7 : p30;
    const days = Math.ceil(stats.totRem / rate);
    if (days > 9125) { // beyond ~25 years: the date stops being useful, and a far-off
      // year reads as discouraging. Stay honest, but show the way forward.
      const closer = Math.ceil(stats.totRem / (rate + 1)) ;
      const yearsSaved = Math.max(1, Math.round((days - closer) / 365.25));
      proj.textContent = 'Beyond 25 years at this pace';
      sub.textContent = `About ${Math.round(rate * 10) / 10}/day. One more each day would move it roughly ${yearsSaved} years closer.`;
    } else {
      const d = new Date(); d.setDate(d.getDate() + days);
      proj.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      sub.textContent = `About ${fmt.format(days)} days at ${Math.round(rate * 10) / 10}/day. An estimate, not a promise.`;
    }
  }

  // rings
  const rings = $('#rings'); rings.innerHTML = '';
  const freshRings = !rings.dataset.done;
  rings.dataset.done = '1';
  if (!freshRings) rings.classList.add('played');
  const drawRings = freshRings && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const p of activePrayers(state.witr)) {
    const init = stats.initial[p.id], done = stats.done[p.id];
    const pct = init === 0 ? (done > 0 ? 1 : 0) : Math.min(1, done / init);
    const li = document.createElement('li');
    li.className = 'ring-card';
    li.innerHTML = `${ringSVG(pct, 64, drawRings)}
      <div class="ring-meta"><span class="rn">${p.en}<span class="ar" lang="ar">${p.ar}</span></span>
      <p>${fmt.format(done)} of ${fmt.format(init)} made up · ${fmt.format(stats.rem[p.id])} left</p></div>
      <span class="ring-pct">${Math.round(pct * 100)}%</span>`;
    rings.appendChild(li);
  }
  if (drawRings) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('#rings .ring .fg[data-off]').forEach(el => el.style.strokeDashoffset = el.dataset.off);
    }));
  }

  // heatmap: last 16 calendar weeks (Mon–Sun columns, oldest → newest)
  const heat = $('#heatmap'); heat.innerHTML = '';
  const monthRow = $('#heat-months'); monthRow.innerHTML = '';
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const thisMon = new Date(today); thisMon.setDate(thisMon.getDate() - ((thisMon.getDay() + 6) % 7));
  const dayVals = [];
  let max = 1, lastMonth = -1;
  for (let w = 15; w >= 0; w--) {
    const mon = new Date(thisMon.getTime() - w * 7 * 864e5);
    const lab = document.createElement('span');
    lab.textContent = mon.getMonth() !== lastMonth ? mon.toLocaleDateString(undefined, { month: 'short' }) : '';
    lastMonth = mon.getMonth();
    monthRow.appendChild(lab);
    for (let d = 0; d < 7; d++) {
      const dt = new Date(mon.getTime() + d * 864e5);
      const v = dt > today ? -1 : (byDay.get(dayKey(dt)) || 0);
      if (v > max) max = v;
      dayVals.push({ dt, v });
    }
  }
  for (const { dt, v } of dayVals) {
    const el = document.createElement('i');
    if (v < 0) el.className = 'is-future';
    else {
      el.dataset.l = v === 0 ? '0' : String(Math.min(4, Math.ceil((v / max) * 4)));
      el.title = `${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} — ${v} made up`;
    }
    heat.appendChild(el);
  }
  heat.setAttribute('aria-label', `Made up ${fmt.format(stats.totDone)} prayers in total. Busiest day: ${max}. Last 16 weeks shown.`);

  // weekly bars (last 8 weeks) + monthly (last 6 months)
  const barsW = $('#bars-week'); barsW.innerHTML = '';
  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    let s = 0;
    for (let i = 0; i < 7; i++) { const d = new Date(today - (w * 7 + (6 - i)) * 864e5); s += byDay.get(dayKey(d)) || 0; }
    weeks.push(s);
  }
  const wmax = Math.max(1, ...weeks);
  weeks.forEach((v, i) => {
    const b = document.createElement('div');
    b.className = 'bar';
    b.innerHTML = `<div class="col" style="height:${Math.max(8, Math.round((v / wmax) * 88))}px"><i style="height:100%"></i></div><span class="v">${v}</span><b>${i === 7 ? 'This wk' : '−' + (7 - i) + 'w'}</b>`;
    barsW.appendChild(b);
  });
  barsW.setAttribute('aria-label', `Weekly completions, oldest to newest: ${weeks.join(', ')}`);
  const barsM = $('#bars-month'); barsM.innerHTML = '';
  const months = [];
  const ref = new Date(today.getFullYear(), today.getMonth(), 1);
  for (let m = 5; m >= 0; m--) {
    const first = new Date(ref.getFullYear(), ref.getMonth() - m, 1);
    const last = new Date(ref.getFullYear(), ref.getMonth() - m + 1, 0);
    let s = 0;
    for (let d = new Date(first); d <= last; d = new Date(d.getTime() + 864e5)) s += byDay.get(dayKey(d)) || 0;
    months.push({ v: s, label: first.toLocaleDateString(undefined, { month: 'short' }) });
  }
  const mmax = Math.max(1, ...months.map(x => x.v));
  months.forEach((x, i) => {
    const b = document.createElement('div');
    b.className = 'bar';
    b.innerHTML = `<div class="col" style="height:${Math.max(8, Math.round((x.v / mmax) * 88))}px"><i style="height:100%"></i></div><span class="v">${x.v}</span><b>${i === 5 ? 'This mo' : x.label}</b>`;
    barsM.appendChild(b);
  });

  // moments — quiet, never gamified
  const mo = $('#moments'); mo.innerHTML = '';
  const items = [];
  const firstEv = ordered(state.events).find(e => e.kind === 'complete' || e.kind === 'day');
  if (firstEv) items.push({ t: 'The first one is behind you.', d: firstEv.at });
  for (const p of activePrayers(state.witr)) {
    if (stats.initial[p.id] > 0 && stats.rem[p.id] === 0) items.push({ t: `${p.en} — nothing remaining.`, d: lastCompleteAt(p.id) });
  }
  for (const m of MILESTONES) {
    if (stats.totDone >= m) items.push({ t: `${fmt.format(m)} prayer${m === 1 ? '' : 's'} made up in total.`, d: dateOfNthCompletion(m) });
  }
  if (stats.totRem === 0 && stats.totInit > 0) items.unshift({ t: 'Your debt is clear. May it be accepted.', d: Date.now() });
  items.sort((a, b) => (b.d || 0) - (a.d || 0));
  mo.innerHTML = items.length ? '' : '<li class="empty">Moments will gather here as you go.</li>';
  for (const it of items.slice(0, 12)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" aria-hidden="true"></span><p>${esc(it.t)}<br><time>${it.d ? new Date(it.d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''}</time></p>`;
    mo.appendChild(li);
  }
}
function lastCompleteAt(prayer) {
  const evs = ordered(state.events).filter(e => (e.kind === 'complete' && e.prayer === prayer) || e.kind === 'day');
  return evs.length ? evs[evs.length - 1].at : null;
}
function dateOfNthCompletion(n) {
  let s = 0;
  const evs = ordered(state.events).filter(e => e.kind === 'complete' || e.kind === 'day');
  const wLen = activePrayers(state.witr).length;
  for (const e of evs) { s += e.kind === 'day' ? wLen : e.n; if (s >= n) return e.at; }
  return null;
}

function renderSettings(stats) {
  const g = $('#adjust-grid'); g.innerHTML = '';
  for (const p of activePrayers(state.witr)) {
    const row = document.createElement('div');
    row.className = 'adjust-row';
    row.innerHTML = `<span class="nm">${p.en}<span class="ar" lang="ar">${p.ar}</span></span>`;
    const st = buildStepper({
      label: `remaining ${p.en}`, step: 1, initial: stats.rem[p.id],
      onCommit: async (next) => {
        if (next === stats.rem[p.id]) return;
        await append('adjust', { prayer: p.id, to: next }, `${p.en} remaining set to ${fmt.format(next)}`);
      },
    });
    row.appendChild(st.el);
    g.appendChild(row);
  }
  $('#set-witr').setAttribute('aria-checked', String(state.witr));

  // history (newest first, undo per item)
  const h = $('#history'); h.innerHTML = '';
  const voided = new Set(state.events.filter(e => e.kind === 'void').map(e => e.target));
  const items = [...state.events].sort((a, b) => (b.at - a.at) || ((b.seq || 0) - (a.seq || 0))).slice(0, 40);
  if (!items.length) h.innerHTML = '<li class="empty">No activity yet.</li>';
  for (const e of items) {
    const li = document.createElement('li');
    const label = describe(e);
    const undone = voided.has(e.id);
    li.innerHTML = `<span class="h-act">${undone ? '<s>' + esc(label) + '</s> undone' : esc(label)}<time>${new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></span>`;
    if (e.kind !== 'void' && !undone) {
      const u = document.createElement('button');
      u.type = 'button'; u.className = 'h-undo'; u.textContent = 'Undo';
      u.setAttribute('aria-label', `Undo: ${label}`);
      u.onclick = () => undoIds([e.id]).then(() => snack('Undone.', null));
      li.appendChild(u);
    }
    h.appendChild(li);
  }
}
function describe(e) {
  const nm = (id) => (PRAYERS.find(p => p.id === id) || {}).en || id;
  switch (e.kind) {
    case 'init': return 'Started the record';
    case 'complete': return `Made up ${e.n} ${nm(e.prayer)}`;
    case 'day': return 'Completed a full day';
    case 'add': return `Added ${e.n} ${nm(e.prayer)} to debt`;
    case 'adjust': return `Set ${nm(e.prayer)} remaining to ${fmt.format(e.to)}`;
    case 'void': return 'Undid an entry';
    default: return e.kind;
  }
}

/* ---------- Router ---------- */
function show(tab) {
  state.tab = tab;
  for (const s of ['onboarding', 'home', 'journey', 'settings']) $('#screen-' + s).hidden = s !== (state.onboarded ? tab : 'onboarding');
  $('#topbar').hidden = !state.onboarded;
  $('#tabbar').hidden = !state.onboarded;
  $$('.tab').forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('is-active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (location.hash !== '#/' + tab && state.onboarded) history.replaceState(null, '', '#/' + tab);
  if (state.onboarded) render();
  $('#main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  tweenNumber.instant = !render.seen;
  render.seen = true;
  if (!state.onboarded) return;
  const { stats } = derived();
  // Only paint the visible screen — the other two are rebuilt on arrival by show().
  if (state.tab === 'journey') renderJourney(stats);
  else if (state.tab === 'settings') renderSettings(stats);
  else renderHome(stats);
}

/* ---------- Events wiring ---------- */
function wire() {
  $$('.tab').forEach(t => t.addEventListener('click', () => { buzz(6); show(t.dataset.tab); }));
  $('#themeBtn').addEventListener('click', async () => {
    // Quick toggle: explicit light ↔ dark. (Settings keeps a third
    // "follow system" option for those who want it.)
    const dark = state.theme === 'dark' || (state.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    state.theme = dark ? 'light' : 'dark';
    await store.setKV('theme', state.theme);
    try { localStorage.setItem('qaza-theme', state.theme); } catch { /* noop */ }
    applyTheme();
    buzz(6);
  });
  $('#set-theme').addEventListener('change', async (e) => {
    state.theme = e.target.value; await store.setKV('theme', state.theme);
    try { localStorage.setItem('qaza-theme', state.theme); } catch { /* noop */ }
    applyTheme();
  });

  // onboarding tabs
  const est = $('#form-estimate'), exact = $('#form-exact');
  $('#tab-est').addEventListener('click', () => {
    $('#tab-est').classList.add('is-active'); $('#tab-exact').classList.remove('is-active');
    $('#tab-est').setAttribute('aria-selected', 'true'); $('#tab-exact').setAttribute('aria-selected', 'false');
    est.hidden = false; exact.hidden = true;
  });
  $('#tab-exact').addEventListener('click', () => {
    $('#tab-exact').classList.add('is-active'); $('#tab-est').classList.remove('is-active');
    $('#tab-exact').setAttribute('aria-selected', 'true'); $('#tab-est').setAttribute('aria-selected', 'false');
    est.hidden = true; exact.hidden = false;
  });
  bindSwitch($('#ob-witr'), () => state.witr, (v) => { state.witr = v; });
  bindSwitch($('#ob-witr2'), () => state.witr, (v) => { state.witr = v; });
  bindSwitch($('#set-witr'), () => state.witr, async (v) => {
    state.witr = v; await store.setKV('witr', v); render();
    snack(v ? 'Witr included.' : 'Witr hidden.', null);
  });
  ['ob-bulugh', 'ob-now', 'ob-prayed'].forEach(id => $('#' + id).addEventListener('input', refreshEstimate));

  est.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { per } = estimateCounts();
    const counts = {};
    for (const p of PRAYERS) counts[p.id] = per;
    await finishOnboarding(counts);
  });
  exact.addEventListener('submit', async (e) => {
    e.preventDefault();
    const counts = {};
    $$('#exact-grid .exact-cell').forEach(c => { counts[c.dataset.prayer] = c._get ? c._get() : 0; });
    await finishOnboarding(counts);
  });

  // fast logging (event delegation; pointerdown for <2s feel via instant aria + rAF paint)
  $('#prayer-list').addEventListener('click', async (e) => {
    const log = e.target.closest('[data-log]');
    const add5 = e.target.closest('[data-add5]');
    const un = e.target.closest('[data-undo-p]');
    if (log) {
      const id = log.dataset.log;
      log.classList.remove('pop'); void log.offsetWidth; log.classList.add('pop');
      buzz(12);
      await append('complete', { prayer: id, n: 1 }, `One ${PRAYERS.find(p => p.id === id).en} recorded.`);
    } else if (add5) {
      await append('complete', { prayer: add5.dataset.add5, n: 5 }, 'Five recorded.');
      buzz(12);
    } else if (un) {
      const pid = un.dataset.undoP;
      const last = ordered(state.events).reverse().find(x => (x.kind === 'complete' && x.prayer === pid) || x.kind === 'day');
      if (last) { await undoIds([last.id]); snack('Undone.', null); }
      else snack('Nothing to undo for this prayer.', null);
    }
  });
  $('#fullday-btn').addEventListener('click', async () => {
    buzz(20);
    await append('day', {}, 'A full day recorded — may it be accepted.');
  });

  // bulk dialog
  const bulk = $('#bulk-scrim');
  $('#bulk-btn').addEventListener('click', () => {
    const g = $('#bulk-grid'); g.innerHTML = '';
    for (const p of activePrayers(state.witr)) {
      const row = document.createElement('div');
      row.className = 'adjust-row';
      row.innerHTML = `<span class="nm">${p.en}<span class="ar" lang="ar">${p.ar}</span></span>`;
      const st = buildStepper({ label: `add ${p.en} to debt`, step: 5, initial: 0 });
      row._get = st.get; row.dataset.prayer = p.id;
      row.appendChild(st.el);
      g.appendChild(row);
    }
    bulk.hidden = false;
    openModal(bulk);
    $('#bulk-cancel').focus();
  });
  const closeBulk = () => { bulk.hidden = true; closeModal(); $('#bulk-btn').focus(); };
  $('#bulk-cancel').addEventListener('click', closeBulk);
  bulk.addEventListener('click', (e) => { if (e.target === bulk) closeBulk(); });
  $('#bulk-save').addEventListener('click', async () => {
    const rows = $$('#bulk-grid .adjust-row').filter(r => r._get() > 0);
    if (!rows.length) { closeBulk(); return; }
    const ids = [];
    for (const r of rows) {
      const ev = { id: uid(), at: Date.now(), seq: await nextSeq(), kind: 'add', prayer: r.dataset.prayer, n: r._get() };
      await store.putEvent(ev); state.events.push(ev); ids.push(ev.id);
    }
    state.lastUndoIds = ids;
    bulk.hidden = true; closeModal(); render();
    snack(`Added ${fmt.format(rows.reduce((s, r) => s + r._get(), 0))} to your debt.`, ids);
    $('#bulk-btn').focus();
  });

  // export / import
  $('#export-btn').addEventListener('click', async () => {
    const data = { app: 'qaza-tracker', version: 1, exportedAt: new Date().toISOString(), events: state.events, kv: state.kv };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `qaza-backup-${dayKey()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    snack('Backup downloaded.', null);
  });
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.events)) throw new Error('bad file');
      if (data.events.length > 200000) throw new Error('file too large');
      const PRAYER_IDS = PRAYERS.map(p => p.id);
      const KINDS = ['init', 'complete', 'day', 'add', 'adjust', 'void'];
      const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 1000000;
      for (const ev of data.events) {
        if (!ev || typeof ev !== 'object' || !ev.id || !KINDS.includes(ev.kind) || typeof ev.at !== 'number') throw new Error('bad event');
        if ((ev.kind === 'complete' || ev.kind === 'add') && (!PRAYER_IDS.includes(ev.prayer) || !isCount(ev.n) || ev.n < 1)) throw new Error('bad event');
        if (ev.kind === 'adjust' && (!PRAYER_IDS.includes(ev.prayer) || !isCount(ev.to))) throw new Error('bad event');
        if (ev.kind === 'init' && (!ev.counts || !PRAYER_IDS.every(id => isCount(ev.counts[id] || 0)))) throw new Error('bad event');
      }
      await store.clearAll();
      for (const ev of data.events) await store.putEvent(ev);
      if (data.kv && typeof data.kv === 'object') for (const [k, v] of Object.entries(data.kv)) await store.setKV(k, v);
      await boot(false);
      snack('Backup restored.', null);
    } catch { snack('That file could not be imported.', null); }
  });

  // reset
  const rs = $('#reset-scrim');
  $('#reset-btn').addEventListener('click', () => {
    $('#reset-confirm').checked = false; $('#reset-do').disabled = true;
    rs.hidden = false; openModal(rs); $('#reset-cancel').focus();
  });
  $('#reset-confirm').addEventListener('change', (e) => { $('#reset-do').disabled = !e.target.checked; });
  $('#reset-cancel').addEventListener('click', () => { rs.hidden = true; closeModal(rs); $('#reset-btn').focus(); });
  rs.addEventListener('click', (e) => { if (e.target === rs) { rs.hidden = true; closeModal(rs); $('#reset-btn').focus(); } });
  $('#reset-do').addEventListener('click', async () => {
    await store.clearAll();
    try { localStorage.removeItem('qaza-onboarded'); } catch { /* noop */ }
    _db && _db.close(); _db = null;
    location.hash = ''; location.reload();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!bulk.hidden) { bulk.hidden = true; closeModal(bulk); $('#bulk-btn').focus(); }
    if (!rs.hidden) { rs.hidden = true; closeModal(rs); $('#reset-btn').focus(); }
    hideSnack();
  });
}

/* Dialogs: mark the background inert so focus, pointer and screen readers
   stay inside the sheet (and Tab can't wander behind the scrim). */
function openModal(scrim) {
  ['#main', '#topbar', '#tabbar'].forEach(s => { const el = $(s); if (el) el.inert = true; });
  scrim.inert = false;
}
function closeModal() {
  ['#main', '#topbar', '#tabbar'].forEach(s => { const el = $(s); if (el) el.inert = false; });
}

async function finishOnboarding(counts) {
  state.witr = $('#ob-witr').getAttribute('aria-checked') === 'true';
  await store.putEvent({ id: uid(), at: Date.now(), seq: await nextSeq(), kind: 'init', counts });
  await store.setKV('onboarded', true);
  await store.setKV('witr', state.witr);
  try { localStorage.setItem('qaza-onboarded', '1'); } catch { /* noop */ }
  state.onboarded = true;
  state.events = await store.allEvents();
  render();
  show('home');
  snack('Your record has begun. One at a time.', null);
}

/* ---------- PWA: service worker, install, updates ---------- */
function wirePWA() {
  if ('serviceWorker' in navigator) {
    // Was a worker already in control? Only then is a reload meaningful:
    // on the very first visit clients.claim() fires controllerchange, and
    // reloading there would double-load the app for no reason.
    const hadController = !!navigator.serviceWorker.controller;
    // Register immediately (not on load): avoids a race where load fires
    // before boot's async IndexedDB reads finish attaching the listener.
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        if (reg.waiting) $('#updatebar').hidden = false;
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw && sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) $('#updatebar').hidden = false;
          });
        });
        $('#updateNow').addEventListener('click', () => {
          reg.waiting ? reg.waiting.postMessage({ type: 'SKIP_WAITING' }) : location.reload();
        });
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
      } catch { /* offline-first still works without SW on first load */ }
    })();
  }
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e;
    if (!localStorage.getItem('qaza-install-dismissed')) $('#installbar').hidden = false;
  });
  $('#installNow').addEventListener('click', async () => {
    $('#installbar').hidden = true;
    if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; }
  });
  $('#installLater').addEventListener('click', () => {
    $('#installbar').hidden = true;
    try { localStorage.setItem('qaza-install-dismissed', '1'); } catch { /* noop */ }
  });
}

/* ---------- Boot ---------- */
async function boot(first = true) {
  _memo = null; // the log may have been replaced wholesale (import, reload)
  // 1. Everything that needs no storage happens now, so the first paint is
  //    useful (the estimate is pure arithmetic) even before IndexedDB opens.
  if (first) {
    buildExactGrid(); wire(); wirePWA(); applyTheme(); refreshEstimate();
    $('#appver').textContent = APP_VERSION;
  }
  // Persistence is a nicety, never a gate — ask for it off the critical path.
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }
  // 2. Storage reads run in parallel instead of four sequential round-trips.
  try {
    const [events, onboarded, w, theme] = await Promise.all([
      store.allEvents(), store.getKV('onboarded'), store.getKV('witr'), store.getKV('theme'),
    ]);
    state.events = events;
    state.onboarded = onboarded === true;
    state.witr = w === undefined ? true : w === true;
    state.theme = theme || 'system';
    state.kv = { onboarded: state.onboarded, witr: state.witr, theme: state.theme };
  } catch {
    state.events = [];
    state.onboarded = false;
  }
  // 3. Reconcile the pre-paint hint with the truth (self-heals a stale flag).
  try {
    if (state.onboarded) localStorage.setItem('qaza-onboarded', '1');
    else localStorage.removeItem('qaza-onboarded');
  } catch { /* noop */ }
  applyTheme();
  const hash = (location.hash || '').replace('#/', '');
  show(!state.onboarded ? 'onboarding' : ['home', 'journey', 'settings'].includes(hash) ? hash : 'home');
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#/', '');
    if (state.onboarded && ['home', 'journey', 'settings'].includes(h) && h !== state.tab) show(h);
  });
}
document.addEventListener('DOMContentLoaded', () => boot(true));

/* expose reducer for tests */
if (typeof module !== 'undefined' && module.exports) module.exports = { computeStats, completionsByDay, streaks, pace, liveEvents, PRAYERS };
