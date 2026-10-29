// DOM-side pieces of the interface: drawers, legend, search, status chip, scale bar.
// Nothing here knows about Three.js; main.js wires these to the scene.

import { t, locale } from './i18n.js';

const $ = (id) => document.getElementById(id);
export const fmt = (n) => Math.round(n).toLocaleString(locale());
export const fmtM = (m) => `${fmt(m)} ${t('unit.m')}`;
export const fmtH = (h) => `${h > 0 ? '+' : ''}${fmtM(h)}`;
// Ground distance per pixel, in m below 1 km and km above.
export const fmtDist = (m) => (m >= 1000 ? `${fmt(m / 1000)} ${t('unit.km')}` : fmtM(m));

// ---------- drawers (left rail on desktop, sheet tabs on mobile) ----------
// Buttons carry data-drawer="<id>"; the drawer with that id opens and the others close.
export function initDrawers() {
  const buttons = [...document.querySelectorAll('[data-drawer]')];
  const drawers = [...document.querySelectorAll('.drawer')];
  let open = null;
  const set = (id) => {
    open = open === id ? null : id;
    for (const d of drawers) d.hidden = d.id !== open;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.drawer === open));
  };
  for (const b of buttons) b.addEventListener('click', () => set(b.dataset.drawer));
  for (const d of drawers) d.querySelector('.drawer-close')?.addEventListener('click', () => set(d.id));
  return { close: () => { if (open) set(open); }, isOpen: () => !!open };
}

// Popover toggled by a button (the info panel).
export function initPopover(button, panel) {
  const toggle = (show = panel.hidden) => {
    panel.hidden = !show;
    button.setAttribute('aria-expanded', String(show));
  };
  button.addEventListener('click', () => toggle());
  panel.querySelector('.drawer-close')?.addEventListener('click', () => toggle(false));
  return { close: () => toggle(false), isOpen: () => !panel.hidden };
}

// ---------- state-bound inputs ----------
// Inputs with data-bind="<key>" mirror state[key] (several inputs may share one key);
// elements with data-out="<key>" show its formatted value.
export function bindInputs(state, formats, onChange) {
  const inputs = [...document.querySelectorAll('[data-bind]')];
  const sync = () => {
    for (const el of inputs) {
      const v = state[el.dataset.bind];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (document.activeElement !== el) el.value = v;
    }
    for (const el of document.querySelectorAll('[data-out]')) {
      const k = el.dataset.out;
      el.textContent = formats[k] ? formats[k](state[k]) : state[k];
    }
  };
  for (const el of inputs) {
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      const k = el.dataset.bind;
      if (el.type === 'number' && el.value === '') return; // mid-edit (e.g. just typed "-")
      state[k] = el.type === 'checkbox' ? el.checked
        : el.type === 'range' || el.type === 'number' ? Math.min(Number(el.max), Math.max(Number(el.min), Math.round(Number(el.value) * 100) / 100))
          : el.value;
      sync();
      onChange(k);
    });
  }
  sync();
  return sync;
}

// ---------- status chip ----------
export function setStatus(text, progress = null) {
  const chip = $('status');
  chip.hidden = !text;
  if (!text) return;
  $('status-text').textContent = text;
  const bar = $('status-bar');
  bar.hidden = progress == null;
  if (progress != null) bar.firstElementChild.style.width = `${Math.round(progress * 100)}%`;
}

// ---------- elevation legend ----------
// "Nice" tick values between min and max (1, 2, 2.5 or 5 × 10^n steps).
export function niceTicks(min, max, count = 5) {
  const span = Math.max(1, max - min);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) ticks.push(v);
  return ticks;
}

// A legend bar (vertical: max on top; horizontal: min on the left) with ticks and a cursor mark.
export function createLegend({ bar, ticks, mark, horizontal = false }) {
  let range = { min: 0, max: 1 };
  const pos = (h) => {
    const t = Math.min(1, Math.max(0, (h - range.min) / (range.max - range.min || 1)));
    return `${((horizontal ? t : 1 - t) * 100).toFixed(2)}%`;
  };
  return {
    set(min, max, css) {
      range = { min, max };
      bar.style.background = css;
      if (!ticks) return;
      const vals = niceTicks(min, max, horizontal ? 3 : 5);
      // Always label the ends; drop interior ticks that would crowd them.
      const near = (v) => Math.abs(v - min) < (max - min) * 0.08 || Math.abs(v - max) < (max - min) * 0.08;
      const all = [max, ...vals.filter((v) => !near(v)), min];
      ticks.innerHTML = '';
      for (const v of all) {
        const s = document.createElement('span');
        s.textContent = fmt(v);
        s.style[horizontal ? 'left' : 'top'] = pos(v);
        if (v === max) s.className = 'end-max';
        if (v === min) s.className = 'end-min';
        ticks.appendChild(s);
      }
    },
    cursor(h) {
      mark.hidden = h == null;
      if (h != null) mark.style[horizontal ? 'left' : 'top'] = pos(h);
    },
  };
}

// ---------- scale bar ----------
// Longest round distance (1/2/5 × 10^n m) that fits in maxPx at the given meters per pixel.
export function updateScaleBar(metersPerPx, maxPx = 120) {
  const el = $('scalebar');
  if (!metersPerPx || !isFinite(metersPerPx)) { el.hidden = true; return; }
  el.hidden = false;
  const maxM = metersPerPx * maxPx;
  const mag = 10 ** Math.floor(Math.log10(maxM));
  const m = [5, 2, 1].map((k) => k * mag).find((v) => v <= maxM);
  $('scalebar-line').style.width = `${Math.round(m / metersPerPx)}px`;
  $('scalebar-text').textContent = fmtDist(m);
}

// ---------- search ----------
// items: { label, sub, kind, keys: lowercased search text, ...payload }.
// Coordinates like "18.79, 98.98" are recognized and passed as { kind: 'coord', lat, lon }.
export function createSearch(input, list, onPick) {
  let items = [];
  let results = [];
  let active = -1;
  const render = () => {
    list.innerHTML = '';
    list.hidden = results.length === 0;
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `search-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const b = document.createElement('b');
      b.textContent = r.label;
      const s = document.createElement('span');
      s.textContent = r.sub;
      li.append(b, s);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    input.setAttribute('aria-expanded', String(results.length > 0));
    input.setAttribute('aria-activedescendant', active >= 0 ? `search-opt-${active}` : '');
  };
  const query = () => {
    // "จ.เชียงใหม่", "อำเภอฮอด" → match on the bare name.
    const q = input.value.trim().toLowerCase().replace(/^(จังหวัด|อำเภอ|ตำบล|จ\.|อ\.|ต\.|เขต|แขวง)\s*/, '');
    active = -1;
    const coord = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (coord) {
      const lat = Number(coord[1]);
      const lon = Number(coord[2]);
      results = Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? [{ kind: 'coord', lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, sub: t('search.coord') }]
        : [];
    } else if (!q) {
      results = [];
    } else {
      // Prefix matches first, then substring matches; provinces before districts before tambons.
      const rank = { province: 0, amphoe: 1, tambon: 2 };
      results = items
        .map((it) => ({ it, at: it.keys.indexOf(q) }))
        .filter((m) => m.at >= 0)
        .sort((a, b) => (a.at > 0) - (b.at > 0) || rank[a.it.kind] - rank[b.it.kind])
        .slice(0, 8)
        .map((m) => m.it);
    }
    render();
  };
  const choose = (i) => {
    const r = results[i];
    if (!r) return;
    input.value = r.label;
    results = [];
    render();
    input.blur();
    onPick(r);
  };
  input.addEventListener('input', query);
  input.addEventListener('focus', query);
  input.addEventListener('blur', () => { results = []; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') {
      choose(active >= 0 ? active : 0);
    } else if (e.key === 'Escape') {
      input.value = '';
      results = [];
      render();
      input.blur();
      e.stopPropagation();
    }
  });
  return { setItems(next) { items = next; } };
}
