import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  MAX_LAT, MAX_ZOOM, loadGlobal, loadMercatorRegion, prefetchTiles, reproject, despike, heightAt, contains,
  tileLon, tileLat, lonToTileX, latToTileY,
} from './elevation.js';
import {
  EARTH_RADIUS, RAMP_MIN, RAMP_MAX, RAMPS, rampColor, rampCss, setRamp,
  createSurface, createDrapedLines, createStarfield, createMask, geojsonLines, latLonToVec3, vec3ToLatLon,
} from './globe.js';
import { bbox, extremes, createPin, inRings, provinceTileRange } from './province.js';
import { t, lang, applyDom, switchLanguage, pageUrl } from './i18n.js';
import {
  fmt, fmtH, fmtM, fmtDist, initDrawers, initPopover, bindInputs, setStatus, createLegend, updateScaleBar, createSearch,
} from './ui.js';

const PLATES_URL =
  'https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_boundaries.json';
const PROVINCES_URL =
  'https://cdn.jsdelivr.net/gh/chingchai/OpenGISData-Thailand@master/provinces.geojson';
const SUBDISTRICTS_URL =
  'https://cdn.jsdelivr.net/gh/chingchai/OpenGISData-Thailand@master/subdistricts.geojson';
// Precomputed per-province highest/lowest points with place names (tools/precompute.html).
const EXTREMES_URL = 'data/province-extremes.json';
// The world's 10 highest peaks and 10 deepest points (curated, see the file's sources).
const WORLD_EXTREMES_URL = 'data/world-extremes.json';

const QUALITY = {
  low: { zoom: 2, segments: 512 },
  medium: { zoom: 3, segments: 1024 },
  high: { zoom: 4, segments: 2048 },
};

// /thai shows only Thailand: one detailed Thailand surface instead of the globe,
// masked to the national border.
const THAI_MODE = /\/thai\/?$/.test(location.pathname);
const THAI_BOUNDS = { latMin: 5.5, latMax: 20.6, lonMin: 97.2, lonMax: 105.8 };
const THAI_MAX_TILES = 360;
let baseZoom = 0;   // zoom of the base surface (globe or Thailand)
let thaiMask = null;

const HOME = { lat: 13.2, lon: 101.0, dist: 1.42 };
const PLACES = {
  everest: { lat: 27.99, lon: 86.93, dist: 1.6 },
  mariana: { lat: 11.35, lon: 142.2, dist: 1.6 },
  atlantic: { lat: 10, lon: -35, dist: 2.4 },
  andes: { lat: -20, lon: -68, dist: 1.9 },
  thailand: HOME,
  himalaya: { lat: 31, lon: 85, dist: 2.0 },
};
const REGION_CODES = ['North', 'Northeast', 'Central', 'East', 'West', 'South'];
const regionName = (code) => (code ? t(`region.${code}`) : '');
const EN = lang === 'en';
// Localized name of a record that carries Thai `name` and English `nameEn`.
const nm = (o) => (EN ? o.nameEn || o.name : o.name);

// Detail patches: below this altitude (in Earth radii) finer tiles are streamed in.
const DETAIL_MAX_ALT = 0.5;
const DETAIL_MAX_TILES = 144;
// The province view loads one larger patch covering the whole province. 240 tiles keeps the
// grid under ~16 Mpx (the province mask canvas must fit browser canvas-area limits).
const PROVINCE_MAX_TILES = 240;
const LABEL_MAX_ALT = 0.2;
// Province 3D view: exaggeration used on entry and camera elevation above the horizon.
const PROVINCE_EXAG = 4;
const PROVINCE_ELEVATION = 24;

const $ = (id) => document.getElementById(id);
const d2r = Math.PI / 180;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = matchMedia('(max-width: 720px)');

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.001, 100);
camera.position.copy(latLonToVec3(HOME.lat, HOME.lon, HOME.dist));

const ORIGIN = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let controls = null;

const state = {
  exaggeration: 50,
  relief: 20,
  water: false,
  sea: 0,
  plates: !THAI_MODE,
  provinces: true,
  tambonLines: true,
  labels: true,
  pins: true,
  quality: 'medium',
  ramp: 'natural',
  range: 'local',
  orbit: false,
  worldPois: !THAI_MODE,
};

// OrbitControls fixes its "up" when created, so switching between the globe view
// (orbit the Earth's center) and a province view (orbit a ground point, tilted)
// recreates it.
function makeControls(target, up, provinceMode) {
  controls?.dispose();
  camera.up.copy(up);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  if (provinceMode) {
    controls.enablePan = true;
    controls.screenSpacePanning = false; // pan along the ground
    controls.minDistance = 0.001;
    controls.maxDistance = 0.35;
    controls.maxPolarAngle = 82 * d2r;
    controls.rotateSpeed = 0.5;
    controls.autoRotate = state.orbit;
    controls.autoRotateSpeed = 0.6;
  } else {
    controls.enablePan = false;
    controls.minDistance = 1.004;
    controls.maxDistance = THAI_MODE ? 2.2 : 8;
  }
  controls.addEventListener('start', () => { flight = null; });
  controls.update();
}
makeControls(ORIGIN, WORLD_UP, false);

renderer.setClearColor(0x010208);
const stars = createStarfield();
scene.add(stars.object);

let globe = null;     // base surface: the whole Earth, or Thailand in /thai
let patch = null;     // high-detail surface around the view, or null
let patchTiles = null;
let plates = null;
let provinces = null; // { lines, highlight, features, labels }
let tambons = null;   // Map pro_code → [{ name, amp, lines, bbox }]
let tambonLines = null; // draped tambon boundaries of the province in view
let extremeData = null; // pro_code → precomputed { max, min, hist, mpp }
let flight = null;
let view = null;      // province 3D view: { f, target, up, prevExag, stemLen, pins, ex }
let loadId = 0;
let detailId = 0;
let thaiExtent = null;

const scale = () => state.exaggeration / EARTH_RADIUS;

// Terrain height (m) of the visible surface, including the water surface when shown.
function surfaceHeight(lat, lon) {
  const grid = patch && contains(patch.grid, lat, lon) ? patch.grid : globe?.grid;
  if (!grid) return 0;
  const h = heightAt(grid, lat, lon);
  return state.water ? Math.max(h, state.sea) : h;
}

// ---------- loading status (one chip, several background tasks) ----------
const tasks = new Map();
function task(key, text, progress = null) {
  if (text) tasks.set(key, { text, progress });
  else tasks.delete(key);
  const last = [...tasks.values()].pop();
  setStatus(last?.text ?? null, last?.progress ?? null);
}

// ---------- base surfaces ----------
// Thailand surface at the finest zoom ≤ maxZoom that fits the tile budget and GPU texture
// size. Called twice: a quick z7 preview, then z9 (~300 m/px) swapped in when ready.
function thaiTiles(maxZoom) {
  const maxDim = Math.min(renderer.capabilities.maxTextureSize, 8192);
  const b = THAI_BOUNDS;
  for (let z = maxZoom; z >= 6; z--) {
    const x0 = Math.floor(lonToTileX(b.lonMin, z));
    const x1 = Math.floor(lonToTileX(b.lonMax, z));
    const y0 = Math.floor(latToTileY(b.latMax, z));
    const y1 = Math.floor(latToTileY(b.latMin, z));
    const c = { z, x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
    if (c.nx * c.ny <= THAI_MAX_TILES && c.nx * 256 <= maxDim && c.ny * 256 <= maxDim) return c;
  }
  return null;
}

async function loadThailand(maxZoom, { preview = false } = {}) {
  const tile = thaiTiles(maxZoom);
  const label = t(preview ? 'status.thai' : 'status.thaiDetail');
  task('thai', `${label} z${tile.z}`, 0);
  const merc = await loadMercatorRegion(tile.z, tile.x0, tile.y0, tile.nx, tile.ny, {
    onProgress: (p, done, total) => task('thai', `${label} z${tile.z} · ${done}/${total}`, p),
  });
  await new Promise(requestAnimationFrame);
  despike(merc);
  const grid = reproject(merc, merc.width, merc.height, {
    lonMin: tileLon(tile.x0, tile.z), lonMax: tileLon(tile.x0 + tile.nx, tile.z),
    latMax: tileLat(tile.y0, tile.z), latMin: tileLat(tile.y0 + tile.ny, tile.z),
  });
  if (globe) { scene.remove(globe.mesh); globe.dispose(); }
  baseZoom = tile.z;
  globe = createSurface(grid, { segments: 1024 });
  if (thaiMask) { globe.setMask(thaiMask); thaiRange(); }
  scene.add(globe.mesh);
  if (patch) globe.setHole(patch);
  applyState();
  task('thai', null);
  const mpp = ((grid.lonMax - grid.lonMin) / grid.width) * d2r * EARTH_RADIUS * Math.cos(13 * d2r);
  $('stats').textContent = t('stats.thai', { z: tile.z, w: grid.width, h: grid.height, m: fmtDist(mpp) });
  setDetailStatus();
}

// Highest / lowest land of Thailand on the base surface (masked samples only).
function thaiRange() {
  const g = globe.grid;
  const m = thaiMask;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < g.height; j++) {
    const lat = g.latMin + ((j + 0.5) / g.height) * (g.latMax - g.latMin);
    const my = Math.floor(((lat - THAI_BOUNDS.latMin) / (THAI_BOUNDS.latMax - THAI_BOUNDS.latMin)) * m.height);
    if (my < 0 || my >= m.height) continue;
    for (let i = 0; i < g.width; i++) {
      const lon = g.lonMin + ((i + 0.5) / g.width) * (g.lonMax - g.lonMin);
      const mx = Math.floor(((lon - THAI_BOUNDS.lonMin) / (THAI_BOUNDS.lonMax - THAI_BOUNDS.lonMin)) * m.width);
      if (mx < 0 || mx >= m.width || m.data[my * m.width + mx] < 128) continue;
      const h = g.data[j * g.width + i];
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  thaiExtent = { min: Math.max(min, 0), max };
  updateRange();
}

// Border mask from the province polygons, applied to every surface in /thai.
function applyThaiMask() {
  if (!provinces) return;
  thaiMask = createMask(provinces.features.map((f) => f.lines), THAI_BOUNDS, 4096);
  globe?.setMask(thaiMask);
  patch?.setMask(thaiMask);
  if (globe) thaiRange();
}

async function loadQuality(key) {
  const q = QUALITY[key];
  const id = ++loadId;
  const label = t('status.globe', { n: 4 ** q.zoom });
  task('globe', label, 0);
  const grid = await loadGlobal(q.zoom, (p) => id === loadId && task('globe', label, p));
  if (id !== loadId) return; // superseded by a newer quality choice

  if (globe) { scene.remove(globe.mesh); globe.dispose(); }
  baseZoom = q.zoom;
  globe = createSurface(grid, { segments: q.segments, globe: true });
  scene.add(globe.mesh);
  dropPatch();
  applyState();
  task('globe', null);
  $('stats').textContent =
    t('stats.world', { w: grid.width, h: grid.height, min: fmtM(grid.min), max: fmtM(grid.max) }) +
    (grid.failed ? t('stats.failed', { n: grid.failed }) : '');
}

// ---------- vector data ----------
async function loadPlates() {
  try {
    const json = await (await fetch(PLATES_URL)).json();
    plates = createDrapedLines(json.features.flatMap((f) => geojsonLines(f.geometry)), {
      color: '#ff5a36', opacity: 0.9,
    });
    scene.add(plates.object);
    refreshLines();
  } catch (e) {
    console.warn('plate boundaries unavailable', e);
    $('plates').disabled = true;
  }
}

async function loadProvinces() {
  try {
    const json = await (await fetch(PROVINCES_URL)).json();
    const features = json.features
      .map((f) => ({
        name: f.properties.pro_th,
        nameEn: f.properties.pro_en,
        code: f.properties.pro_code,
        region: f.properties.reg_royin,
        lat: f.properties.lat,
        lon: f.properties.lon,
        area: f.properties.area_sqkm,
        lines: geojsonLines(f.geometry),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'));

    const lines = createDrapedLines(features.flatMap((f) => f.lines), {
      color: '#ffffff', opacity: 0.85, maxStepDeg: 0.01, bias: 0.003,
    });
    scene.add(lines.object);

    const labels = features.map((f) => {
      const el = document.createElement('div');
      el.className = 'label';
      el.textContent = nm(f);
      $('labels').appendChild(el);
      return { el, f, pos: new THREE.Vector3() };
    });

    provinces = { lines, features, labels, highlight: null };
    renderPlaceList();
    updateSearchIndex();
    refreshLines();
  } catch (e) {
    console.warn('provinces unavailable', e);
  }
}

// ~7,400 tambons (≈2 MB compressed), grouped by province so a hover only tests
// the hundred or so tambons of the province under the cursor.
async function loadSubdistricts() {
  try {
    const json = await (await fetch(SUBDISTRICTS_URL)).json();
    const map = new Map();
    for (const f of json.features) {
      const p = f.properties;
      const lines = geojsonLines(f.geometry);
      const tb = { name: p.tam_th, nameEn: p.tam_en, amp: p.amp_th, ampEn: p.amp_en, lines, bbox: bbox({ lines }) };
      if (!map.has(p.pro_code)) map.set(p.pro_code, []);
      map.get(p.pro_code).push(tb);
    }
    tambons = map;
    updateSearchIndex();
    if (view) {
      showTambonLines(view.f);
      fillInspectorAdmin(view.f);
      if (view.ex) applyExtremes(view.f, view.ex, view.exPre); // place names need tambons
    }
  } catch (e) {
    console.warn('subdistricts unavailable', e);
  }
}

async function loadExtremeData() {
  try {
    const res = await fetch(EXTREMES_URL);
    if (res.ok) extremeData = (await res.json()).provinces;
  } catch { /* computed on the fly instead */ }
}

const isBkk = (f) => f.code === '10';
const provinceTitle = (f) => (isBkk(f) ? nm(f) : t('province.title', { n: nm(f) }));
const ampName = (tb) => (EN ? tb.ampEn || tb.amp : tb.amp);

// Districts of a province with their tambons and combined bounds.
function amphoesOf(f) {
  const list = tambons?.get(f.code);
  if (!list) return [];
  const by = new Map();
  for (const t of list) {
    if (!by.has(t.amp)) by.set(t.amp, []);
    by.get(t.amp).push(t);
  }
  return [...by.entries()]
    .map(([name, ts]) => ({
      name,
      nameEn: ts[0].ampEn,
      tambons: ts,
      bbox: ts.reduce((b, t) => ({
        latMin: Math.min(b.latMin, t.bbox.latMin), latMax: Math.max(b.latMax, t.bbox.latMax),
        lonMin: Math.min(b.lonMin, t.bbox.lonMin), lonMax: Math.max(b.lonMax, t.bbox.lonMax),
      }), { latMin: Infinity, latMax: -Infinity, lonMin: Infinity, lonMax: -Infinity }),
    }))
    .sort((a, b) => nm(a).localeCompare(nm(b), EN ? 'en' : 'th'));
}

function showTambonLines(f) {
  if (tambonLines) {
    scene.remove(tambonLines.object);
    tambonLines.dispose();
    tambonLines = null;
  }
  const list = f && tambons?.get(f.code);
  if (!list) return;
  tambonLines = createDrapedLines(list.flatMap((t) => t.lines), {
    color: '#ffffff', opacity: 0.3, maxStepDeg: 0.005, bias: 0.0025,
  });
  scene.add(tambonLines.object);
  refreshLines();
}

function setHighlight(lines) {
  if (provinces.highlight) {
    scene.remove(provinces.highlight.object);
    provinces.highlight.dispose();
    provinces.highlight = null;
  }
  if (!lines) return;
  provinces.highlight = createDrapedLines(lines, {
    color: '#ffd34d', opacity: 1, maxStepDeg: 0.01, bias: 0.004,
  });
  provinces.highlight.object.renderOrder = 2; // draw over the other province lines
  scene.add(provinces.highlight.object);
  refreshLines();
}

// ---------- province 3D view ----------
function setExaggeration(v) {
  state.exaggeration = v;
  syncInputs();
  applyState();
}

const northAt = (lat, lon) => new THREE.Vector3(
  -Math.sin(lat * d2r) * Math.sin(lon * d2r), Math.cos(lat * d2r), -Math.sin(lat * d2r) * Math.cos(lon * d2r),
);

// Fly so that bounds `b` fills the view, orbiting its center from the south.
function frameArea(b, { elevation = PROVINCE_ELEVATION } = {}) {
  const lat = (b.latMin + b.latMax) / 2;
  const lon = (b.lonMin + b.lonMax) / 2;
  const up = latLonToVec3(lat, lon);
  const north = northAt(lat, lon);
  const extent = Math.max(b.latMax - b.latMin, (b.lonMax - b.lonMin) * Math.cos(lat * d2r)) * d2r; // radians ≈ R units
  const target = up.clone().multiplyScalar(1 + Math.max(0, surfaceHeight(lat, lon)) * scale());
  const dist = (extent * 1.15) / (2 * Math.tan((camera.fov / 2) * d2r)) + 0.004;
  const el = elevation * d2r;
  const pos = target.clone().addScaledVector(up, dist * Math.sin(el)).addScaledVector(north, -dist * Math.cos(el));
  if (view) { view.target = target; view.up = up; }
  flyCamera({ pos, target, up, onDone: () => makeControls(target, up, true) });
}

// Enter (or switch to) the tilted 3D view of a province; `focus` frames a district or tambon in it.
async function enterProvince(f, { focus = null, focusLines = null } = {}) {
  if (!f) return;
  const switching = view?.f !== f;
  const prevExag = view ? view.prevExag : state.exaggeration;
  if (switching) clearPins();
  setHighlight(focusLines ?? f.lines);
  if (switching) showTambonLines(f);
  if (!view && state.exaggeration !== PROVINCE_EXAG) {
    setExaggeration(PROVINCE_EXAG);
    showExagNote(prevExag);
  }
  const b = bbox(f);
  const lat = (b.latMin + b.latMax) / 2;
  const extent = Math.max(b.latMax - b.latMin, (b.lonMax - b.lonMin) * Math.cos(lat * d2r)) * d2r;
  if (!view || switching) {
    view = { ...(view ?? {}), f, prevExag, stemLen: extent * 0.07, pins: switching ? null : view?.pins, ex: null };
  }
  document.body.classList.add('province');
  drawers.close();
  $('poi-card').hidden = true;
  showInspector(f);
  frameArea(focus ?? b);

  if (!switching) return;
  const pre = extremeData?.[f.code];
  if (pre) applyExtremes(f, pre, true);
  await loadProvinceDetail(b);
  if (view?.f !== f) return; // user moved on meanwhile
  if (!pre) {
    const grid = patch && contains(patch.grid, f.lat, f.lon) ? patch.grid : globe.grid;
    const ex = extremes(f, grid);
    if (ex) applyExtremes(f, { ...ex, mpp: gridMpp(grid) }, false);
  } else {
    placePins(); // re-drape on the detailed surface
  }
}

function exitProvince({ fly = true } = {}) {
  if (!view) return;
  const { lat, lon } = vec3ToLatLon(view.target);
  const prevExag = view.prevExag;
  clearPins();
  setHighlight(null);
  showTambonLines(null);
  view = null;
  document.body.classList.remove('province');
  $('pi-exag-note').hidden = true;
  setExaggeration(prevExag);
  renderPlaceList();
  updateRange();
  if (fly) {
    flyCamera({
      pos: latLonToVec3(lat, lon, 1.3), target: ORIGIN, up: WORLD_UP,
      onDone: () => makeControls(ORIGIN, WORLD_UP, false),
    });
  } else {
    flight = null;
    makeControls(ORIGIN, WORLD_UP, false);
  }
}

// Detail patch covering the whole province at the finest zoom that fits the tile budget.
function provinceTiles(b) {
  const maxDim = Math.min(renderer.capabilities.maxTextureSize, 8192);
  const t = provinceTileRange(b, { maxDim, maxTiles: PROVINCE_MAX_TILES, maxZoom: MAX_ZOOM });
  return t && { t, maxDim };
}

async function loadProvinceDetail(b) {
  const { t: tile, maxDim } = provinceTiles(b);
  const done = () => { if (view && patch) $('pi-res').textContent = t('pi.res', { z: patchTiles.z, m: fmtDist(gridMpp(patch.grid)) }); };
  if (covers(patchTiles, tile)) { done(); return; }
  $('pi-res').textContent = t('pi.loading', { z: tile.z });
  await loadPatch(tile, {
    maxDim,
    segments: 640,
    onProgress: (done, total) => {
      if (view) $('pi-res').textContent = t('pi.loadingN', { z: tile.z, done, total });
    },
  });
  done();
}

const gridMpp = (g) =>
  ((g.lonMax - g.lonMin) / g.width) * d2r * EARTH_RADIUS * Math.cos(((g.latMin + g.latMax) / 2) * d2r);

// Fill the inspector, pins and legend from extremes (precomputed or just measured).
function applyExtremes(f, ex, precomputed) {
  view.ex = ex;
  view.exPre = precomputed;
  clearPins();
  const make = (pt, color, cls, text) => {
    const pin = createPin(color);
    scene.add(pin.group);
    const el = document.createElement('div');
    el.className = `pin-label ${cls}`;
    el.innerHTML = `${text}<b>${fmtH(pt.h)}</b>`;
    $('pins').appendChild(el);
    return { pin, el, pt };
  };
  view.pins = [
    make(ex.max, 0xff6b57, 'hi', `▲ ${(EN ? ex.max.nameEn : ex.max.name) ?? t('pin.max')}`),
    make(ex.min, 0x3d9bff, 'lo', `▼ ${(EN ? ex.min.nameEn : ex.min.name) ?? t('pin.min')}`),
  ];
  placePins();
  const where = (pt) => `${pt.lat.toFixed(3)}°N ${pt.lon.toFixed(3)}°E`;
  // Precomputed points carry a peak name and/or "ต.… อ.…"; measured ones get the tambon now.
  const label = (pt) => [EN ? pt.nameEn : pt.name,
    (!EN && pt.place) || placeName(f, tambonAt(f, pt.lat, pt.lon), { province: false })].filter(Boolean).join(' · ');
  $('pi-max').textContent = fmtM(ex.max.h);
  $('pi-max-name').textContent = label(ex.max);
  $('pi-max-at').textContent = where(ex.max);
  $('pi-min').textContent = fmtM(ex.min.h);
  $('pi-min-name').textContent = label(ex.min);
  $('pi-min-at').textContent = where(ex.min);
  $('pi-x-note').hidden = !(ex.max.h < 300 && !ex.max.name);
  renderHistogram(ex);
  $('pi-hist-note').textContent = precomputed
    ? t('pi.histPre', { m: fmtDist(ex.mpp) })
    : t('pi.histLive', { m: fmtDist(ex.mpp) });
  updateRange();
}

function renderHistogram(ex) {
  const el = $('pi-hist');
  el.innerHTML = '';
  const hist = ex.hist ?? [];
  const peak = Math.max(1, ...hist);
  const c = { r: 0, g: 0, b: 0 };
  hist.forEach((n, i) => {
    const s = document.createElement('span');
    const h = ex.min.h + ((i + 0.5) / hist.length) * (ex.max.h - ex.min.h);
    rampColor(RAMPS[state.ramp].stops, h, c);
    s.style.height = `${Math.max(3, Math.sqrt(n / peak) * 100)}%`; // sqrt keeps thin tails visible
    s.style.background = `rgb(${c.r * 255} ${c.g * 255} ${c.b * 255})`;
    el.appendChild(s);
  });
  $('pi-hist-min').textContent = fmt(ex.min.h);
  $('pi-hist-mid').textContent = fmt((ex.min.h + ex.max.h) / 2);
  $('pi-hist-max').textContent = fmtM(ex.max.h);
}

function placePins() {
  if (!view?.pins) return;
  for (const { pin, pt } of view.pins) {
    const up = latLonToVec3(pt.lat, pt.lon);
    const base = up.clone().multiplyScalar(1 + surfaceHeight(pt.lat, pt.lon) * scale());
    pin.place(base, up, view.stemLen);
    pin.group.visible = state.pins;
  }
}

function clearPins() {
  if (!view?.pins) return;
  for (const { pin, el } of view.pins) {
    scene.remove(pin.group);
    pin.dispose();
    el.remove();
  }
  view.pins = null;
}

function showInspector(f) {
  $('pi-name').textContent = provinceTitle(f);
  $('crumb-province').textContent = nm(f);
  $('crumb-region').textContent = regionName(f.region);
  if (view.f === f && view.ex) return;
  for (const id of ['pi-max', 'pi-min']) $(id).textContent = '…';
  $('pi-x-note').hidden = true;
  for (const id of ['pi-max-name', 'pi-min-name', 'pi-max-at', 'pi-min-at', 'pi-hist-note', 'pi-hist-min', 'pi-hist-mid', 'pi-hist-max']) $(id).textContent = '';
  $('pi-hist').innerHTML = '';
  fillInspectorAdmin(f);
}

// Subtitle counts and the district list (needs the tambon data).
function fillInspectorAdmin(f) {
  const amps = amphoesOf(f);
  const nTam = tambons?.get(f.code)?.length;
  $('pi-sub').textContent = [EN ? f.name : f.nameEn, `${fmt(f.area)} ${t('unit.km2')}`,
    amps.length ? `${fmt(amps.length)} ${t(isBkk(f) ? 'unit.khet' : 'unit.amphoe')}` : '',
    nTam ? `${fmt(nTam)} ${t(isBkk(f) ? 'unit.khwaeng' : 'unit.tambon')}` : ''].filter(Boolean).join(' · ');
  $('pi-amphoe-title').textContent = amps.length ? t(isBkk(f) ? 'pi.khetN' : 'pi.amphoeN', { n: amps.length }) : t('pi.amphoe');
  const list = $('pi-amphoe');
  list.innerHTML = '';
  if (!amps.length) {
    list.innerHTML = `<p class="hint">${t('pi.loadingAdmin')}</p>`;
    return;
  }
  for (const a of amps) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-btn';
    btn.innerHTML = `<span></span><small>${a.tambons.length} ${t(isBkk(f) ? 'unit.khwaeng' : 'unit.tambonShort')}</small>`;
    btn.firstChild.textContent = nm(a);
    btn.addEventListener('click', () => {
      for (const b of list.children) b.removeAttribute('aria-current');
      btn.setAttribute('aria-current', 'true');
      enterProvince(f, { focus: a.bbox, focusLines: a.tambons.flatMap((t) => t.lines) });
    });
    list.appendChild(btn);
  }
}

function showExagNote(prev) {
  const note = $('pi-exag-note');
  note.hidden = false;
  note.innerHTML = t('pi.exagNote', { to: PROVINCE_EXAG, from: prev });
  note.querySelector('button').addEventListener('click', () => { setExaggeration(prev); note.hidden = true; });
}

function flyToPoint(pt) {
  const d = 0.06; // ~6 km box around the point
  frameArea({ latMin: pt.lat - d, latMax: pt.lat + d, lonMin: pt.lon - d, lonMax: pt.lon + d }, { elevation: 30 });
}

const pinProj = new THREE.Vector3();
function updatePins() {
  if (!view?.pins) return;
  for (const { pin, el } of view.pins) {
    pin.resize(camera);
    pinProj.copy(pin.top).project(camera);
    const visible = state.pins && pinProj.z < 1 && Math.abs(pinProj.x) < 1.1 && Math.abs(pinProj.y) < 1.1;
    el.style.display = visible ? '' : 'none';
    if (visible) {
      const x = (pinProj.x * 0.5 + 0.5) * innerWidth;
      const y = (-pinProj.y * 0.5 + 0.5) * innerHeight;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 12px))`;
    }
  }
}

// Re-drape vector layers after heights change (exaggeration, water, new detail patch).
function refreshLines() {
  if (!globe) return;
  const s = scale();
  if (plates) {
    plates.object.visible = state.plates;
    if (state.plates) plates.update(surfaceHeight, s);
  }
  if (provinces) {
    provinces.lines.object.visible = state.provinces;
    if (provinces.highlight) provinces.highlight.update(surfaceHeight, s);
    if (state.provinces) {
      provinces.lines.update(surfaceHeight, s);
      for (const l of provinces.labels) {
        l.pos.copy(latLonToVec3(l.f.lat, l.f.lon, 1 + surfaceHeight(l.f.lat, l.f.lon) * s));
      }
    }
  }
  if (tambonLines) {
    tambonLines.object.visible = state.tambonLines;
    if (state.tambonLines) tambonLines.update(surfaceHeight, s);
  }
  placePins();
  placePois();
  updatePoiModel();
}

function applyState() {
  for (const surf of [globe, patch]) {
    if (!surf) continue;
    const u = surf.uniforms;
    u.uScale.value = scale();
    u.uWater.value = state.water;
    u.uSea.value = state.sea;
    surf.setRelief(state.relief);
  }
  refreshLines();
}

// ---------- detail patches ----------
function dropPatch() {
  detailId++;
  if (patch) { scene.remove(patch.mesh); patch.dispose(); }
  patch = null;
  patchTiles = null;
  globe?.setHole(null);
  setDetailStatus();
}

// Tile range at the zoom whose texels roughly match screen pixels for the current view.
function wantedTiles() {
  const alt = camera.position.length() - 1;
  if (alt > DETAIL_MAX_ALT || !globe) return null;
  const { lat, lon } = vec3ToLatLon(camera.position);
  const spanLat = (2 * alt * Math.tan((camera.fov / 2) * d2r) * 1.25) / d2r * Math.max(1, 1 / camera.aspect);
  const spanLon = (spanLat * Math.max(1, camera.aspect)) / Math.max(Math.cos(lat * d2r), 0.2);
  const pixels = Math.min(renderer.domElement.width, 2560);
  const minZoom = baseZoom + 1;
  let z = Math.min(MAX_ZOOM, Math.round(Math.log2((pixels * 360) / (spanLon * 256))));
  for (; z >= minZoom; z--) {
    const n = 2 ** z;
    const x0 = Math.floor(lonToTileX(lon - spanLon / 2, z)) - 1;
    const x1 = Math.floor(lonToTileX(lon + spanLon / 2, z)) + 1;
    const y0 = Math.max(0, Math.floor(latToTileY(Math.min(MAX_LAT, lat + spanLat / 2), z)) - 1);
    const y1 = Math.min(n - 1, Math.floor(latToTileY(Math.max(-MAX_LAT, lat - spanLat / 2), z)) + 1);
    const nx = Math.min(n, x1 - x0 + 1);
    const ny = y1 - y0 + 1;
    if (nx * ny <= DETAIL_MAX_TILES) return { z, x0, y0, nx, ny };
  }
  return null;
}

const covers = (a, b) =>
  a && a.z === b.z && b.x0 >= a.x0 && b.x0 + b.nx <= a.x0 + a.nx && b.y0 >= a.y0 && b.y0 + b.ny <= a.y0 + a.ny;

async function loadPatch(tile, { maxDim = 3072, segments = 320, onProgress = () => {} } = {}) {
  const id = ++detailId;
  task('detail', t('status.detail', { z: tile.z }), 0);
  const merc = await loadMercatorRegion(tile.z, tile.x0, tile.y0, tile.nx, tile.ny, {
    isStale: () => id !== detailId,
    onProgress: (p, done, total) => {
      if (id !== detailId) return;
      task('detail', `${t('status.detail', { z: tile.z })} · ${done}/${total}`, p);
      onProgress(done, total);
    },
  });
  if (!merc || id !== detailId) return;
  await new Promise(requestAnimationFrame); // let the status text paint before heavy work
  despike(merc);
  const bounds = {
    lonMin: tileLon(tile.x0, tile.z), lonMax: tileLon(tile.x0 + tile.nx, tile.z),
    latMax: tileLat(tile.y0, tile.z), latMin: tileLat(tile.y0 + tile.ny, tile.z),
  };
  const grid = reproject(merc, Math.min(merc.width, maxDim), Math.min(merc.height, maxDim), bounds);
  if (tile.z >= 10 && !THAI_MODE) patchSeaFromGlobe(grid); // /thai masks the sea anyway
  if (id !== detailId) return;
  const next = createSurface(grid, { segments });
  if (thaiMask) next.setMask(thaiMask);
  if (patch) { scene.remove(patch.mesh); patch.dispose(); }
  patch = next;
  patchTiles = tile;
  scene.add(patch.mesh);
  globe.setHole(patch);
  applyState();
  task('detail', null);
  setDetailStatus();
}

// Fine Terrain Tiles (z10+) carry no bathymetry: the sea is exactly 0 m, and some coasts
// have void pits hundreds of meters deep. Fill both from the coarse global grid (ETOPO).
function patchSeaFromGlobe(grid) {
  const { width: W, height: H, data } = grid;
  for (let j = 0; j < H; j++) {
    const lat = grid.latMin + ((j + 0.5) / H) * (grid.latMax - grid.latMin);
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const h = data[k];
      if (h !== 0 && h > -100) continue;
      const lon = grid.lonMin + ((i + 0.5) / W) * (grid.lonMax - grid.lonMin);
      const g = heightAt(globe.grid, lat, lon);
      if (h === 0 ? g < -5 : g > -100) data[k] = h === 0 ? g : Math.max(g, 0);
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
  grid.min = min;
  grid.max = max;
}

function setDetailStatus() {
  updateRange();
  const el = $('detail');
  if (!patchTiles) {
    el.textContent = THAI_MODE
      ? t('detail.thai', { z: baseZoom })
      : t('detail.world');
    return;
  }
  el.textContent = t('detail.now', { z: patchTiles.z, m: fmtDist(gridMpp(patch.grid)) });
}

let lastCheck = 0;
const lastCam = new THREE.Vector3();
function updateDetail(now) {
  if (view) return; // the province view manages its own patch
  if (now - lastCheck < 300) return;
  lastCheck = now;
  const moving = lastCam.distanceTo(camera.position) > (camera.position.length() - 1) * 0.02;
  lastCam.copy(camera.position);
  if (moving || flight) return; // wait for the view to settle
  const want = wantedTiles();
  if (!want) { if (patch) dropPatch(); return; }
  if (covers(patchTiles, want)) return;
  if (pendingKey === key(want)) return;
  pendingKey = key(want);
  loadPatch(want).finally(() => { if (pendingKey === key(want)) pendingKey = null; });
}
let pendingKey = null;
const key = (t) => `${t.z}/${t.x0}/${t.y0}/${t.nx}/${t.ny}`;

// ---------- background prefetch ----------
// After the first view is up, quietly warm the tile cache: Thailand's detailed base (so
// /thai opens fast) on the world page, and a province's detail tiles while the cursor rests on it.
let prefetchBusy = false;
async function prefetchQuietly(z, t) {
  if (prefetchBusy) return;
  prefetchBusy = true;
  try { await prefetchTiles(z, t.x0, t.y0, t.nx, t.ny, { concurrency: 3 }); } catch { /* best effort */ }
  prefetchBusy = false;
}
function prefetchThailand() {
  const t = thaiTiles(9);
  const idle = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 2000));
  idle(() => prefetchQuietly(t.z, t));
}
let hoverTimer = 0;
let hoverCode = null;
function prefetchProvinceSoon(f) {
  if (!f || f.code === hoverCode || view?.f === f) return;
  hoverCode = f.code;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const pt = provinceTiles(bbox(f));
    if (pt) prefetchQuietly(pt.t.z, pt.t);
  }, 700);
}

// ---------- world top-10 highest / deepest ----------
// Each point is a rank badge on screen joined to its true ground position by a leader line;
// badges are placed so they never overlap (nearest free slot around the point).
let pois = [];        // [{ kind, rank, name, ..., el, up, base }]
let poiNote = '';
let poiNoteEn = '';
let poiKind = 'high';
let poiSelected = null;
const SVG_NS = 'http://www.w3.org/2000/svg';

async function loadWorldPois() {
  try {
    const json = await (await fetch(WORLD_EXTREMES_URL)).json();
    poiNote = json.note;
    poiNoteEn = json.noteEn ?? json.note;
    pois = [...json.high.map((p) => ({ ...p, kind: 'high' })), ...json.deep.map((p) => ({ ...p, kind: 'deep' }))];
    for (const p of pois) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `poi ${p.kind}`;
      el.setAttribute('aria-label', t('poi.aria', { kind: t(p.kind === 'high' ? 'poi.highest' : 'poi.deepest'), n: p.rank, name: nm(p), h: fmtH(p.h) }));
      el.innerHTML = `<b><i>${p.kind === 'high' ? '▲' : '▼'}</i><span>${p.rank}</span></b><span class="t"></span>`;
      el.querySelector('.t').textContent = nm(p).split(EN ? ', ' : ' · ')[0];
      el.querySelector('.t').insertAdjacentHTML('beforeend', `<small>${fmtM(p.h)}</small>`);
      el.addEventListener('click', () => selectPoi(p, { fly: true }));
      $('pois').appendChild(el);
      p.el = el;
      p.up = latLonToVec3(p.lat, p.lon);
      p.line = document.createElementNS(SVG_NS, 'line');
      p.dot = document.createElementNS(SVG_NS, 'circle');
      p.dot.setAttribute('r', '3.5');
      const color = p.kind === 'high' ? '#ff8a70' : '#b79cff';
      p.line.setAttribute('stroke', color);
      p.dot.setAttribute('fill', color);
      $('poi-lines').append(p.line, p.dot);
    }
    renderPoiList();
    placePois();
  } catch (e) {
    console.warn('world extremes unavailable', e);
  }
}

// Ground radius under each point; refreshed when heights change (exaggeration, new detail).
function placePois() {
  const s = scale();
  for (const p of pois) p.base = 1 + Math.max(0, surfaceHeight(p.lat, p.lon)) * s;
}

// Candidate badge offsets (px) from the anchor, nearest first: straight above, then
// fanning out sideways and upward.
const SLOTS = (() => {
  const out = [];
  for (let ring = 1; ring <= 6; ring++) {
    for (let k = -ring; k <= ring; k++) out.push([k, -ring]);
    out.push([-ring - 1, 0], [ring + 1, 0]);
  }
  return out.sort((a, b) => Math.hypot(a[0] * 1.2, a[1]) - Math.hypot(b[0] * 1.2, b[1]));
})();

const poiTop = new THREE.Vector3();
function updatePois() {
  const show = state.worldPois && !view && pois.length;
  $('pois').hidden = !show;
  if (!show) return;
  const near = camera.position.length() - 1 < 0.35;
  for (const p of pois) {
    poiTop.copy(p.up).multiplyScalar(p.base);
    toCam.copy(camera.position).sub(poiTop);
    projected.copy(poiTop).project(camera);
    p.onScreen = toCam.dot(p.up) > 0 && projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
    p.sx = (projected.x * 0.5 + 0.5) * innerWidth;
    p.sy = (-projected.y * 0.5 + 0.5) * innerHeight;
  }
  // The selected point first, then by rank (both #1s, then both #2s, …). Each badge takes the
  // nearest slot that overlaps neither a placed badge nor another point's anchor dot.
  const order = pois.filter((p) => p.onScreen)
    .sort((a, b) => (b === poiSelected) - (a === poiSelected) || a.rank - b.rank || (a.kind > b.kind) - (a.kind < b.kind));
  const placed = [];
  const dots = order.map((p) => ({ l: p.sx - 5, r: p.sx + 5, t: p.sy - 5, b: p.sy + 5 }));
  const overlaps = (box) => placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t) ||
    dots.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t);
  for (const p of pois) {
    if (p.onScreen) continue;
    p.el.style.display = 'none';
    p.line.style.display = p.dot.style.display = 'none';
  }
  for (const p of order) {
    const full = near || p === poiSelected;
    p.el.classList.toggle('compact', !full);
    p.el.style.display = '';
    p.line.style.display = p.dot.style.display = '';
    const w = p.el.offsetWidth || (full ? 170 : 30);
    const h = 28;
    let box = null;
    for (const [dx, dy] of SLOTS) {
      const cx = p.sx + dx * (w * 0.55 + 4);
      const cy = p.sy - 14 + dy * (h + 6);
      const cand = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2, cx, cy };
      if (!overlaps(cand)) { box = cand; break; }
    }
    if (!box) { // crowded beyond every slot: keep only the dot
      p.el.style.display = 'none';
      p.line.style.display = 'none';
    } else {
      placed.push(box);
      p.el.style.transform = `translate(${box.l}px, ${box.t}px)`;
      p.line.setAttribute('x1', p.sx);
      p.line.setAttribute('y1', p.sy);
      p.line.setAttribute('x2', box.cx);
      p.line.setAttribute('y2', box.b > p.sy ? box.t : box.b);
    }
    p.dot.setAttribute('cx', p.sx);
    p.dot.setAttribute('cy', p.sy);
  }
}

function selectPoi(p, { fly = false } = {}) {
  if (view) exitProvince({ fly: false });
  poiSelected = p;
  for (const q of pois) q.el.setAttribute('aria-pressed', String(q === p));
  const card = $('poi-card');
  card.hidden = false;
  card.scrollTop = 0;
  card.classList.toggle('deep', p.kind === 'deep');
  $('poi-rank').textContent = t(p.kind === 'high' ? 'poi.rankHigh' : 'poi.rankDeep', { n: p.rank });
  $('poi-name').textContent = nm(p);
  $('poi-en').textContent = EN ? p.name : p.nameEn;
  $('poi-h').textContent = p.kind === 'high' ? fmtM(p.h) : t('poi.belowSea', { h: fmtM(-p.h) });
  $('poi-where').textContent = (EN ? [p.whereEn, p.rangeEn] : [p.where, p.range]).filter(Boolean).join(' · ');
  $('poi-at').textContent = `${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}`;
  // Photo from Wikimedia Commons with its author and license.
  const fig = $('poi-figure');
  fig.hidden = !p.image;
  if (p.image) {
    $('poi-img').src = p.image.src;
    $('poi-img').alt = p.nameEn;
    const credit = $('poi-credit');
    credit.innerHTML = '';
    const a = document.createElement('a');
    a.href = p.image.page;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = [p.image.artist, p.image.license].filter(Boolean).join(' · ') || 'Wikimedia Commons';
    credit.append(`${t('poi.photo')}: `, a, ' / Wikimedia Commons');
  }
  $('poi-summary').textContent = (EN ? p.summaryEn : p.summaryTh ?? p.summaryEn) ?? '';
  const article = $('poi-article');
  const thArticle = !EN && p.articleTh;
  article.href = thArticle || p.articleEn;
  article.textContent = t(thArticle ? 'poi.readTh' : 'poi.readEn');
  updatePoiModel();
  $('poi-note').textContent = EN ? poiNoteEn : poiNote;
  if (fly) flyTo({ lat: p.lat, lon: p.lon, dist: p.kind === 'high' ? 1.12 : 1.18 });
  for (const b of $('poi-list').children) b.setAttribute('aria-current', String(b.dataset.key === `${p.kind}${p.rank}`));
}

// What the loaded elevation model says at the point (coarse grids smooth peaks and trenches).
function updatePoiModel() {
  const p = poiSelected;
  if (!p || $('poi-card').hidden) return;
  const grid = patch && contains(patch.grid, p.lat, p.lon) ? patch.grid : globe?.grid;
  if (!grid) return;
  const mpp = gridMpp(grid);
  $('poi-model').textContent = `${fmtH(heightAt(grid, p.lat, p.lon))} (~${fmtDist(mpp)}/${EN ? 'pixel' : 'พิกเซล'})`;
}

function stepPoi(dir) {
  if (!poiSelected) return;
  const list = pois.filter((q) => q.kind === poiSelected.kind);
  const next = list[(list.indexOf(poiSelected) + dir + list.length) % list.length];
  selectPoi(next, { fly: true });
}

function renderPoiList() {
  const list = $('poi-list');
  list.innerHTML = '';
  for (const p of pois.filter((q) => q.kind === poiKind)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-btn';
    btn.dataset.key = `${p.kind}${p.rank}`;
    btn.innerHTML = '<span><span class="rank"></span><span class="n"></span></span><small></small>';
    btn.querySelector('.rank').textContent = p.rank;
    btn.querySelector('.n').textContent = nm(p).split(EN ? ', ' : ' · ')[0];
    btn.querySelector('small').textContent = fmtM(p.h);
    btn.addEventListener('click', () => { drawers.close(); selectPoi(p, { fly: true }); });
    list.appendChild(btn);
  }
}

// ---------- UI ----------
applyDom();
document.title = t(THAI_MODE ? 'meta.title.thai' : 'meta.title.world');
$('lang-btn').addEventListener('click', switchLanguage);
// World / Thailand links stay in the current language.
$('mode-world').href = pageUrl('world');
$('mode-thai').href = pageUrl('thai');
const drawers = initDrawers();
const info = initPopover($('info-btn'), $('info'));
$('credit').addEventListener('click', () => { if (!info.isOpen()) $('info-btn').click(); });

$(THAI_MODE ? 'mode-thai' : 'mode-world').setAttribute('aria-current', 'page');

const syncInputs = bindInputs(state, {
  exaggeration: (v) => `${v}×`,
  relief: (v) => `${v}`,
  sea: (v) => fmtH(v),
}, (k) => {
  if (k === 'quality') { loadQuality(state.quality); return; }
  if (k === 'water') $('sea').disabled = !state.water;
  applyState();
});
$('sea').disabled = !state.water;

// Color schemes
for (const [id, r] of Object.entries(RAMPS)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.ramp = id;
  btn.setAttribute('aria-pressed', String(id === state.ramp));
  btn.innerHTML = `<span style="background:${rampCss(r.stops, -6000, 6000, 'to left', 16)}"></span>${t(`ramp.${id}`)}`;
  btn.addEventListener('click', () => {
    state.ramp = id;
    setRamp(r.stops);
    for (const b of $('ramps').children) b.setAttribute('aria-pressed', String(b === btn));
    updateRange();
    if (view?.ex) renderHistogram(view.ex);
  });
  $('ramps').appendChild(btn);
}

// Legend: range fitted to what is on screen, or the whole ramp.
const legend = createLegend({ bar: $('legend-bar'), ticks: $('legend-ticks'), mark: $('legend-mark') });
const mini = createLegend({ bar: $('mini-bar'), ticks: $('mini-ticks'), mark: $('mini-mark'), horizontal: true });
function currentRange() {
  if (state.range === 'world') return { min: RAMP_MIN, max: RAMP_MAX };
  if (view?.ex) return { min: view.ex.min.h, max: view.ex.max.h };
  if (THAI_MODE && thaiExtent && !patch) return thaiExtent;
  const g = patch?.grid ?? globe?.grid;
  return g ? { min: g.min, max: g.max } : { min: 0, max: 1 };
}
function updateRange() {
  let { min, max } = currentRange();
  if (max - min < 10) max = min + 10;
  const stops = RAMPS[state.ramp].stops;
  legend.set(min, max, rampCss(stops, min, max, 'to bottom'));
  mini.set(min, max, rampCss(stops, min, max, 'to left'));
}
for (const btn of document.querySelectorAll('[data-range]')) {
  btn.addEventListener('click', () => {
    state.range = btn.dataset.range;
    for (const b of document.querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(b === btn));
    updateRange();
  });
}

// World top-10 list & card
for (const btn of document.querySelectorAll('[data-poi-kind]')) {
  btn.addEventListener('click', () => {
    poiKind = btn.dataset.poiKind;
    for (const b of document.querySelectorAll('[data-poi-kind]')) b.setAttribute('aria-pressed', String(b === btn));
    renderPoiList();
  });
}
$('poi-close').addEventListener('click', () => {
  $('poi-card').hidden = true;
  poiSelected = null;
  for (const q of pois) q.el.setAttribute('aria-pressed', 'false');
});
$('poi-go').addEventListener('click', () => poiSelected && selectPoi(poiSelected, { fly: true }));
$('poi-prev').addEventListener('click', () => stepPoi(-1));
$('poi-next').addEventListener('click', () => stepPoi(1));

// Places drawer
document.querySelectorAll('[data-place]').forEach((btn) =>
  btn.addEventListener('click', () => {
    exitProvince({ fly: false });
    drawers.close();
    flyTo(PLACES[btn.dataset.place]);
  }),
);
function renderPlaceList() {
  if (!provinces) return;
  const q = $('place-filter').value.trim().toLowerCase();
  const list = $('place-list');
  list.innerHTML = '';
  for (const code of REGION_CODES) {
    const fs = provinces.features.filter((f) => f.region === code &&
      (!q || f.name.includes(q) || f.nameEn.toLowerCase().includes(q)))
      .sort((a, b) => nm(a).localeCompare(nm(b), EN ? 'en' : 'th'));
    if (!fs.length) continue;
    const h = document.createElement('h3');
    h.textContent = regionName(code);
    list.appendChild(h);
    for (const f of fs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-btn';
      btn.innerHTML = '<span></span><small></small>';
      btn.firstChild.textContent = nm(f);
      btn.lastChild.textContent = `${fmt(f.area)} ${t('unit.km2')}`;
      if (view?.f === f) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', () => enterProvince(f));
      list.appendChild(btn);
    }
  }
}
$('place-filter').addEventListener('input', renderPlaceList);

// Search: provinces, districts, tambons, or "lat, lon".
const search = createSearch($('search'), $('search-list'), (r) => {
  if (r.kind === 'coord') {
    exitProvince({ fly: false });
    flyTo({ lat: r.lat, lon: r.lon, dist: 1.08 });
  } else if (r.kind === 'province') {
    enterProvince(r.f);
  } else {
    enterProvince(r.f, { focus: r.bbox, focusLines: r.lines });
  }
});
function updateSearchIndex() {
  if (!provinces) return;
  const items = [];
  const bkkUnit = (f, [th, bkk]) => (isBkk(f) ? bkk : th);
  for (const f of provinces.features) {
    items.push({ kind: 'province', label: provinceTitle(f), sub: `${EN ? f.name : f.nameEn} · ${regionName(f.region)}`, keys: `${f.name} ${f.nameEn}`.toLowerCase(), f });
    for (const a of amphoesOf(f)) {
      const aLabel = EN ? `${a.nameEn} District` : `${bkkUnit(f, ['อ.', 'เขต'])}${a.name}`;
      items.push({ kind: 'amphoe', label: aLabel, sub: provinceTitle(f), keys: `${a.name} ${a.nameEn ?? ''}`.toLowerCase(), f, bbox: a.bbox, lines: a.tambons.flatMap((tb) => tb.lines) });
      for (const tb of a.tambons) {
        const tLabel = EN ? (tb.nameEn ?? tb.name) : `${bkkUnit(f, ['ต.', 'แขวง'])}${tb.name}`;
        items.push({ kind: 'tambon', label: tLabel, sub: `${aLabel}, ${provinceTitle(f)}`, keys: `${tb.name} ${tb.nameEn ?? ''}`.toLowerCase(), f, bbox: tb.bbox, lines: tb.lines });
      }
    }
  }
  search.setItems(items);
}

// Inspector & camera buttons
$('back').addEventListener('click', () => exitProvince());
$('crumb-home').addEventListener('click', () => exitProvince());
$('pi-max-go').addEventListener('click', () => view?.ex && flyToPoint(view.ex.max));
$('pi-min-go').addEventListener('click', () => view?.ex && flyToPoint(view.ex.min));
$('orbit').addEventListener('click', () => {
  state.orbit = !state.orbit;
  $('orbit').setAttribute('aria-pressed', String(state.orbit));
  if (view) controls.autoRotate = state.orbit;
});
$('north').dataset.provinceOnly = '';

// Camera elevation above the local horizon, in the province view.
const offset = new THREE.Vector3();
const horiz = new THREE.Vector3();
function cameraElevation() {
  offset.copy(camera.position).sub(controls.target);
  return Math.asin(THREE.MathUtils.clamp(offset.dot(view.up) / offset.length(), -1, 1)) / d2r;
}
// Place the camera at `elevation`° (keeping distance), facing `heading` or its current direction.
function setCamera({ elevation = cameraElevation(), north = false } = {}) {
  if (!view || flight) return;
  offset.copy(camera.position).sub(controls.target);
  const d = offset.length();
  const { lat, lon } = vec3ToLatLon(controls.target);
  horiz.copy(offset).addScaledVector(view.up, -offset.dot(view.up));
  if (north || horiz.lengthSq() < 1e-12) horiz.copy(northAt(lat, lon)).negate();
  horiz.normalize();
  const el = THREE.MathUtils.clamp(elevation, 8, 89.5) * d2r;
  camera.position.copy(controls.target).addScaledVector(view.up, d * Math.sin(el)).addScaledVector(horiz, d * Math.cos(el));
  controls.update();
}
$('tilt').addEventListener('input', (e) => setCamera({ elevation: Number(e.target.value) }));
$('topview').addEventListener('click', () => setCamera({ elevation: 89.5, north: true }));
$('north').addEventListener('click', () => setCamera({ north: true }));
function zoomBy(f) {
  if (flight) return;
  if (view) {
    offset.copy(camera.position).sub(controls.target);
    const d = THREE.MathUtils.clamp(offset.length() * f, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).addScaledVector(offset.normalize(), d);
  } else {
    const dist = THREE.MathUtils.clamp(1 + (camera.position.length() - 1) * f, controls.minDistance, controls.maxDistance);
    camera.position.setLength(dist);
  }
  controls.update();
}
$('zoom-in').addEventListener('click', () => zoomBy(0.6));
$('zoom-out').addEventListener('click', () => zoomBy(1 / 0.6));

addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); return; }
  if (e.key !== 'Escape' || typing) return;
  if (info.isOpen()) info.close();
  else if (!$('poi-card').hidden) $('poi-close').click();
  else if (drawers.isOpen()) drawers.close();
  else exitProvince();
});

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
const hit = new THREE.Vector3();

// Ground point under a screen position (iterating the sphere radius onto the terrain).
function pickLatLon(clientX, clientY) {
  if (!globe) return null;
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  let r = 1;
  let ll = null;
  for (let i = 0; i < 4; i++) {
    sphere.radius = r;
    if (!raycaster.ray.intersectSphere(sphere, hit)) break;
    ll = vec3ToLatLon(hit);
    r = 1 + surfaceHeight(ll.lat, ll.lon) * scale();
  }
  return ll;
}

function pick(clientX, clientY) {
  const ll = pickLatLon(clientX, clientY);
  if (!ll) return null;
  const grid = patch && contains(patch.grid, ll.lat, ll.lon) ? patch.grid : globe.grid;
  const province = provinceAt(ll.lat, ll.lon);
  return { ...ll, h: heightAt(grid, ll.lat, ll.lon), province, tambon: tambonAt(province, ll.lat, ll.lon) };
}

function provinceAt(lat, lon) {
  return provinces?.features.find((f) => inRings(f.lines, lat, lon)) ?? null;
}

function tambonAt(province, lat, lon) {
  const list = province && tambons?.get(province.code);
  if (!list) return null;
  return list.find((t) => {
    const b = t.bbox;
    return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax && inRings(t.lines, lat, lon);
  }) ?? null;
}

// "ต.… อ.… จ.…" (Bangkok uses แขวง / เขต).
function placeName(province, tambon, opts = {}) {
  if (!province) return '';
  const bkk = isBkk(province);
  const parts = [];
  if (EN) {
    if (tambon) parts.push(tambon.nameEn ?? tambon.name, ampName(tambon));
    if (opts.province !== false) parts.push(nm(province));
    return parts.join(', ');
  }
  if (tambon) parts.push(`${bkk ? 'แขวง' : 'ต.'}${tambon.name}`, `${bkk ? 'เขต' : 'อ.'}${tambon.amp}`);
  if (opts.province !== false) parts.push(provinceTitle(province));
  return parts.join(' ');
}

let tapped = null; // province of the last tap (mobile sheet's "view in 3D")
function showReadout(p) {
  const hud = $('hud');
  hud.classList.toggle('idle', !p);
  legend.cursor(p ? p.h : null);
  mini.cursor(p ? p.h : null);
  if (!p) {
    $('hud-place').textContent = t('hud.idle');
    $('hud-coord').textContent = '—';
    $('hud-h').textContent = '—';
    return;
  }
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  const coord = `${Math.abs(p.lat).toFixed(3)}°${ns} ${Math.abs(p.lon).toFixed(3)}°${ew}`;
  const below = state.water ? state.sea - p.h : -p.h;
  const place = placeName(p.province, p.tambon) || (below > 0 ? t('hud.underwater') : '—');
  $('hud-place').textContent = place;
  $('hud-coord').textContent = coord;
  $('hud-h').textContent = fmtH(p.h);
  $('sheet-place').textContent = place;
  $('sheet-coord').textContent = coord;
  $('sheet-h').textContent = fmtH(p.h);
  tapped = p.province;
  $('sheet-3d').hidden = !tapped;
  if (tapped) $('sheet-3d').textContent = t('sheet.view3d', { p: provinceTitle(tapped) });
}
$('sheet-3d').addEventListener('click', () => tapped && enterProvince(tapped));

renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const p = pick(e.clientX, e.clientY);
  showReadout(p);
  prefetchProvinceSoon(p?.province);
  renderer.domElement.style.cursor = p?.province && p.province !== view?.f ? 'pointer' : '';
});
renderer.domElement.addEventListener('pointerleave', () => showReadout(null));
let pressed = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pressed = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (e.pointerType !== 'mouse') showReadout(pick(e.clientX, e.clientY));
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pressed || e.button !== 0) return;
  const click = Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < 5 && performance.now() - pressed.t < 500;
  pressed = null;
  if (!click) return;
  // On phones a tap shows the sheet; the sheet's button opens the 3D view.
  if (e.pointerType !== 'mouse' && mobile.matches) return;
  const p = pick(e.clientX, e.clientY);
  if (p?.province && p.province !== view?.f) enterProvince(p.province);
});

// ---------- fly-to ----------
function flyTo({ lat, lon, dist }) {
  const from = camera.position.clone();
  const to = latLonToVec3(lat, lon, dist);
  if (reducedMotion) { camera.position.copy(to); return; }
  const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const angle = from.angleTo(to);
  flight = { from, q, d0: from.length(), d1: dist, lift: Math.min(0.6, angle * 0.5), t0: performance.now(), dur: 1800 };
}

// Move the camera to `pos`, looking at `target`, easing "up" so the view does not snap.
function flyCamera({ pos, target, up, onDone }) {
  controls.enabled = false;
  flight = {
    kind: 'look', p0: camera.position.clone(), p1: pos.clone(),
    a0: controls.target.clone(), a1: target.clone(), u0: camera.up.clone(), u1: up.clone(),
    t0: performance.now(), dur: reducedMotion ? 0 : 1800, onDone,
  };
}

const look = new THREE.Vector3();
function stepFlight(now) {
  if (!flight) return;
  if (flight.kind === 'look') {
    const t = flight.dur ? Math.min(1, (now - flight.t0) / flight.dur) : 1;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    camera.position.lerpVectors(flight.p0, flight.p1, e);
    camera.up.lerpVectors(flight.u0, flight.u1, e).normalize();
    camera.lookAt(look.lerpVectors(flight.a0, flight.a1, e));
    if (t >= 1) {
      const done = flight.onDone;
      flight = null;
      done?.();
    }
    return;
  }
  const t = Math.min(1, (now - flight.t0) / flight.dur);
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const q = new THREE.Quaternion().slerp(flight.q, e);
  const d = flight.d0 + (flight.d1 - flight.d0) * e + Math.sin(Math.PI * e) * flight.lift;
  camera.position.copy(flight.from).normalize().applyQuaternion(q).multiplyScalar(d);
  if (t >= 1) flight = null;
}

// ---------- labels ----------
const projected = new THREE.Vector3();
const toCam = new THREE.Vector3();
function updateLabels() {
  const show = provinces && state.provinces && state.labels && camera.position.length() - 1 < LABEL_MAX_ALT;
  $('labels').hidden = !show;
  if (!show) return;
  for (const l of provinces.labels) {
    toCam.copy(camera.position).sub(l.pos);
    const facing = toCam.dot(l.pos) > 0;
    projected.copy(l.pos).project(camera);
    const visible = facing && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
    l.el.style.display = visible ? '' : 'none';
    if (visible) {
      const x = (projected.x * 0.5 + 0.5) * innerWidth;
      const y = (-projected.y * 0.5 + 0.5) * innerHeight;
      l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }
}

// ---------- scale bar & tilt readout (a few times a second) ----------
let lastUi = 0;
function haversine(a, b) {
  const dLat = (b.lat - a.lat) * d2r;
  const dLon = (b.lon - a.lon) * d2r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(s));
}
function updateSlowUi(now) {
  if (now - lastUi < 300) return;
  lastUi = now;
  const cx = innerWidth / 2;
  const cy = innerHeight * (view ? 0.6 : 0.5);
  const a = pickLatLon(cx - 50, cy);
  const b = pickLatLon(cx + 50, cy);
  updateScaleBar(a && b ? haversine(a, b) / 100 : null);
  if (view && !flight) {
    const el = Math.round(cameraElevation());
    if (document.activeElement !== $('tilt')) $('tilt').value = el;
    $('tilt-val').textContent = `${el}°`;
  }
}

// ---------- loop ----------
const right = new THREE.Vector3();
const up = new THREE.Vector3();
function frame(now) {
  stepFlight(now);
  const dist = camera.position.length();
  const alt = dist - 1;
  if (!view) {
    controls.rotateSpeed = THREE.MathUtils.clamp(alt * 0.6, 0.01, 1);
    controls.zoomSpeed = THREE.MathUtils.clamp(alt * 2, 0.4, 1);
  }
  if (globe && !view) {
    // Keep the camera above the (exaggerated) ground beneath it.
    const { lat, lon } = vec3ToLatLon(camera.position);
    controls.minDistance = 1 + Math.max(0, surfaceHeight(lat, lon)) * scale() + 0.003;
  }
  if (flight?.kind !== 'look') controls.update();
  const nearRef = view ? Math.min(alt, camera.position.distanceTo(controls.target)) : alt;
  camera.near = Math.max(nearRef * 0.02, 1e-6);
  camera.far = dist + 2;
  stars.follow(camera);
  camera.updateProjectionMatrix();

  if (globe) {
    // Headlight from upper-left of the view, so relief reads well from any angle.
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    const sun = globe.uniforms.uSun.value
      .copy(camera.position).normalize()
      .addScaledVector(up, 0.7).addScaledVector(right, -0.6).normalize();
    if (patch) patch.uniforms.uSun.value.copy(sun);
    updateDetail(now);
    updateSlowUi(now);
  }
  updateLabels();
  updatePins();
  updatePois();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

loadExtremeData();
if (THAI_MODE) {
  document.body.classList.add('thai');
  Promise.all([loadThailand(7, { preview: true }), loadProvinces()])
    .then(() => { applyThaiMask(); refreshLines(); })
    .then(() => Promise.all([loadThailand(9), loadSubdistricts()]));
} else {
  loadQuality(state.quality)
    .then(() => Promise.all([loadPlates(), loadProvinces(), loadWorldPois()]))
    .then(loadSubdistricts)
    .then(prefetchThailand);
}
