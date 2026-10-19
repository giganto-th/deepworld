import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  MAX_LAT, MAX_ZOOM, loadGlobal, loadMercatorRegion, reproject, heightAt, contains,
  tileLon, tileLat, lonToTileX, latToTileY,
} from './elevation.js';
import {
  EARTH_RADIUS, RAMP_MIN, RAMP_MAX, RAMP_STOPS,
  createSurface, createDrapedLines, geojsonLines, latLonToVec3, vec3ToLatLon,
} from './globe.js';

const PLATES_URL =
  'https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_boundaries.json';
const PROVINCES_URL =
  'https://cdn.jsdelivr.net/gh/chingchai/OpenGISData-Thailand@master/provinces.geojson';

const QUALITY = {
  low: { zoom: 2, segments: 512 },
  medium: { zoom: 3, segments: 1024 },
  high: { zoom: 4, segments: 2048 },
};

const HOME = { lat: 13.2, lon: 101.0, dist: 1.42 };
const PLACES = {
  everest: { lat: 27.99, lon: 86.93, dist: 1.6 },
  mariana: { lat: 11.35, lon: 142.2, dist: 1.6 },
  atlantic: { lat: 10, lon: -35, dist: 2.4 },
  andes: { lat: -20, lon: -68, dist: 1.9 },
  thailand: HOME,
  himalaya: { lat: 31, lon: 85, dist: 2.0 },
};

// Detail patches: below this altitude (in Earth radii) finer tiles are streamed in.
const DETAIL_MAX_ALT = 0.5;
const DETAIL_MAX_TILES = 144;
const LABEL_MAX_ALT = 0.3;

const $ = (id) => document.getElementById(id);
const d2r = Math.PI / 180;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (n) => Math.round(n).toLocaleString('th-TH');

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.001, 100);
camera.position.copy(latLonToVec3(HOME.lat, HOME.lon, HOME.dist));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.004;
controls.maxDistance = 8;
controls.addEventListener('start', () => { flight = null; });

const state = {
  exaggeration: 20,
  relief: 8,
  water: false,
  sea: 0,
  plates: true,
  provinces: true,
  quality: 'medium',
};

let globe = null;     // whole-Earth surface
let patch = null;     // high-detail surface around the view, or null
let patchTiles = null;
let plates = null;
let provinces = null; // { lines, highlight, features, labels }
let flight = null;
let loadId = 0;
let detailId = 0;

const scale = () => state.exaggeration / EARTH_RADIUS;

// Terrain height (m) of the visible surface, including the water surface when shown.
function surfaceHeight(lat, lon) {
  const grid = patch && contains(patch.grid, lat, lon) ? patch.grid : globe?.grid;
  if (!grid) return 0;
  const h = heightAt(grid, lat, lon);
  return state.water ? Math.max(h, state.sea) : h;
}

// ---------- global data ----------
async function loadQuality(key) {
  const q = QUALITY[key];
  const id = ++loadId;
  $('loading').hidden = false;
  $('progress').value = 0;
  $('loading-text').textContent = `กำลังโหลดข้อมูลความสูง (${4 ** q.zoom} tiles)…`;
  const grid = await loadGlobal(q.zoom, (p) => id === loadId && ($('progress').value = p));
  if (id !== loadId) return; // superseded by a newer quality choice

  if (globe) { scene.remove(globe.mesh); globe.dispose(); }
  globe = createSurface(grid, { segments: q.segments, globe: true });
  scene.add(globe.mesh);
  dropPatch();
  applyState();
  $('loading').hidden = true;
  $('stats').textContent =
    `ภาพรวม ${grid.width}×${grid.height} · ต่ำสุด ${fmt(grid.min)} ม. · สูงสุด ${fmt(grid.max)} ม.` +
    (grid.failed ? ` · โหลดไม่สำเร็จ ${grid.failed} tiles` : '');
}

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
      el.textContent = f.name;
      $('labels').appendChild(el);
      return { el, f, pos: new THREE.Vector3() };
    });

    const select = $('province');
    for (const [i, f] of features.entries()) select.add(new Option(f.name, i));
    select.disabled = false;

    provinces = { lines, features, labels, highlight: null };
    refreshLines();
  } catch (e) {
    console.warn('provinces unavailable', e);
    $('provinces').disabled = true;
  }
}

function selectProvince(i) {
  if (!provinces) return;
  if (provinces.highlight) {
    scene.remove(provinces.highlight.object);
    provinces.highlight.dispose();
    provinces.highlight = null;
  }
  const f = provinces.features[i];
  if (!f) return;
  provinces.highlight = createDrapedLines(f.lines, {
    color: '#ffd34d', opacity: 1, maxStepDeg: 0.01, bias: 0.004,
  });
  scene.add(provinces.highlight.object);
  refreshLines();
  // Frame the province: its rough extent should fill most of the view.
  const extent = (Math.sqrt(f.area) * 1.8 * 1000) / EARTH_RADIUS;
  flyTo({ lat: f.lat, lon: f.lon, dist: 1 + extent / (2 * Math.tan((camera.fov / 2) * d2r)) });
  $('province-info').textContent = `${f.name} (${f.nameEn}) · ${fmt(f.area)} ตร.กม.`;
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
    if (provinces.highlight) provinces.highlight.object.visible = state.provinces;
    if (state.provinces) {
      provinces.lines.update(surfaceHeight, s);
      provinces.highlight?.update(surfaceHeight, s);
      for (const l of provinces.labels) {
        l.pos.copy(latLonToVec3(l.f.lat, l.f.lon, 1 + surfaceHeight(l.f.lat, l.f.lon) * s));
      }
    }
  }
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
  const minZoom = QUALITY[state.quality].zoom + 1;
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

async function loadPatch(t) {
  const id = ++detailId;
  setDetailStatus(`กำลังโหลดรายละเอียด z${t.z} (${t.nx * t.ny} tiles)…`);
  const merc = await loadMercatorRegion(t.z, t.x0, t.y0, t.nx, t.ny, { isStale: () => id !== detailId });
  if (!merc || id !== detailId) return;
  const bounds = {
    lonMin: tileLon(t.x0, t.z), lonMax: tileLon(t.x0 + t.nx, t.z),
    latMax: tileLat(t.y0, t.z), latMin: tileLat(t.y0 + t.ny, t.z),
  };
  const grid = reproject(merc, Math.min(merc.width, 3072), Math.min(merc.height, 3072), bounds);
  if (id !== detailId) return;
  const next = createSurface(grid, { segments: 320 });
  if (patch) { scene.remove(patch.mesh); patch.dispose(); }
  patch = next;
  patchTiles = t;
  scene.add(patch.mesh);
  globe.setHole(patch);
  applyState();
  setDetailStatus();
}

function setDetailStatus(loading) {
  updateRange();
  const el = $('detail');
  if (loading) { el.textContent = loading; return; }
  if (!patchTiles) { el.textContent = 'รายละเอียด: ภาพรวมทั้งโลก · ซูมเข้าเพื่อดูละเอียดขึ้น'; return; }
  const lat = (patch.grid.latMin + patch.grid.latMax) / 2;
  const mpp = (156543 * Math.cos(lat * d2r)) / 2 ** patchTiles.z;
  el.textContent = `รายละเอียด: z${patchTiles.z} · ~${fmt(mpp)} ม./พิกเซล`;
}

let lastCheck = 0;
const lastCam = new THREE.Vector3();
function updateDetail(now) {
  if (now - lastCheck < 300) return;
  lastCheck = now;
  const moving = lastCam.distanceTo(camera.position) > (camera.position.length() - 1) * 0.02;
  lastCam.copy(camera.position);
  if (moving || flight) return; // wait for the view to settle
  const want = wantedTiles();
  if (!want) { if (patch || detailId) { if (patch) dropPatch(); } return; }
  if (covers(patchTiles, want)) return;
  if (pendingKey === key(want)) return;
  pendingKey = key(want);
  loadPatch(want).finally(() => { if (pendingKey === key(want)) pendingKey = null; });
}
let pendingKey = null;
const key = (t) => `${t.z}/${t.x0}/${t.y0}/${t.nx}/${t.ny}`;

// ---------- UI ----------
function bindRange(id, prop, label) {
  const el = $(id);
  el.value = state[prop];
  const sync = () => {
    state[prop] = Number(el.value);
    $(`${id}-val`).textContent = label(state[prop]);
    applyState();
  };
  el.addEventListener('input', sync);
  sync();
}
bindRange('exag', 'exaggeration', (v) => `${v}×`);
bindRange('relief', 'relief', (v) => `${v}`);
bindRange('sea', 'sea', (v) => `${v > 0 ? '+' : ''}${fmt(v)} ม.`);

$('water').checked = state.water;
$('water').addEventListener('change', (e) => {
  state.water = e.target.checked;
  $('sea').disabled = !state.water;
  applyState();
});
$('sea').disabled = !state.water;
$('plates').checked = state.plates;
$('plates').addEventListener('change', (e) => { state.plates = e.target.checked; applyState(); });
$('provinces').checked = state.provinces;
$('provinces').addEventListener('change', (e) => { state.provinces = e.target.checked; applyState(); });
$('province').addEventListener('change', (e) => selectProvince(Number(e.target.value)));
$('quality').value = state.quality;
$('quality').addEventListener('change', (e) => { state.quality = e.target.value; loadQuality(state.quality); });

document.querySelectorAll('[data-place]').forEach((btn) =>
  btn.addEventListener('click', () => flyTo(PLACES[btn.dataset.place])),
);

// ---------- elevation scale (bottom right) ----------
// Fraction from the top of the bar: RAMP_MAX at 0, RAMP_MIN at 1.
const scaleY = (h) => THREE.MathUtils.clamp((RAMP_MAX - h) / (RAMP_MAX - RAMP_MIN), 0, 1);
const pct = (h) => `${(scaleY(h) * 100).toFixed(2)}%`;
$('scale-bar').style.background = `linear-gradient(to bottom, ${[...RAMP_STOPS]
  .reverse()
  .map(([h, c]) => `${c} ${pct(h)}`)
  .join(', ')})`;
$('scale-ticks').innerHTML = [9000, 6000, 3000, 0, -3000, -6000, -11000]
  .map((h) => `<span style="top:${pct(h)}">${h > 0 ? '+' : ''}${fmt(h)}</span>`)
  .join('');

// Highest / lowest point of the area currently drawn in detail (or the whole globe).
function updateRange() {
  const grid = patch?.grid ?? globe?.grid;
  if (!grid) return;
  $('range-max').textContent = `${grid.max >= 0 ? '+' : ''}${fmt(grid.max)} ม.`;
  $('range-min').textContent = `${grid.min >= 0 ? '+' : ''}${fmt(grid.min)} ม.`;
  const band = $('range-band');
  band.style.top = pct(grid.max);
  band.style.height = `${((scaleY(grid.min) - scaleY(grid.max)) * 100).toFixed(2)}%`;
}

$('toggle-panel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
const hit = new THREE.Vector3();

function pick(clientX, clientY) {
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
  if (!ll) return null;
  const grid = patch && contains(patch.grid, ll.lat, ll.lon) ? patch.grid : globe.grid;
  return { ...ll, h: heightAt(grid, ll.lat, ll.lon), province: provinceAt(ll.lat, ll.lon) };
}

// Point-in-polygon over province rings (even-odd), cheap enough for pointer moves.
function provinceAt(lat, lon) {
  if (!provinces) return null;
  for (const f of provinces.features) {
    let inside = false;
    for (const ring of f.lines) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return f;
  }
  return null;
}

function showReadout(p) {
  const mark = $('cursor-mark');
  if (!p) {
    mark.hidden = true;
    $('readout-place').textContent = '';
    $('readout-coord').textContent = 'วางเคอร์เซอร์บนแผนที่';
    $('readout-h').textContent = '—';
    $('readout-note').textContent = '';
    return;
  }
  mark.hidden = false;
  mark.style.top = pct(p.h);
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  const below = state.water ? state.sea - p.h : -p.h;
  $('readout-place').textContent = p.province ? `จ.${p.province.name}` : '';
  $('readout-coord').textContent =
    `${Math.abs(p.lat).toFixed(3)}°${ns}  ${Math.abs(p.lon).toFixed(3)}°${ew}`;
  $('readout-h').textContent = `${p.h >= 0 ? '+' : ''}${fmt(p.h)} ม.`;
  $('readout-note').textContent = below > 0 ? `ใต้ระดับน้ำ ${fmt(below)} ม.` : 'เหนือระดับน้ำทะเล';
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') showReadout(pick(e.clientX, e.clientY));
});
renderer.domElement.addEventListener('pointerleave', () => showReadout(null));
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') showReadout(pick(e.clientX, e.clientY));
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

function stepFlight(now) {
  if (!flight) return;
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
  const show = provinces && state.provinces && camera.position.length() - 1 < LABEL_MAX_ALT;
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

// ---------- loop ----------
const right = new THREE.Vector3();
const up = new THREE.Vector3();
function frame(now) {
  stepFlight(now);
  const dist = camera.position.length();
  const alt = dist - 1;
  controls.rotateSpeed = THREE.MathUtils.clamp(alt * 0.6, 0.01, 1);
  controls.zoomSpeed = THREE.MathUtils.clamp(alt * 2, 0.4, 1);
  if (globe) {
    // Keep the camera above the (exaggerated) ground beneath it.
    const { lat, lon } = vec3ToLatLon(camera.position);
    controls.minDistance = 1 + Math.max(0, surfaceHeight(lat, lon)) * scale() + 0.003;
  }
  controls.update();
  camera.near = Math.max(alt * 0.05, 1e-5);
  camera.far = dist + 2;
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
  }
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

loadQuality(state.quality).then(() => Promise.all([loadPlates(), loadProvinces()]));
