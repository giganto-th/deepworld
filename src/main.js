import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadMercator, toEquirect, heightAt } from './elevation.js';
import {
  EARTH_RADIUS, RAMP_MIN, RAMP_MAX, RAMP_STOPS,
  createGlobe, createAtmosphere, createPlateBoundaries, latLonToVec3, vec3ToLatLon,
} from './globe.js';

const PLATES_URL =
  'https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_boundaries.json';

const QUALITY = {
  low: { zoom: 2, segments: 512 },
  medium: { zoom: 3, segments: 1024 },
  high: { zoom: 4, segments: 2048 },
};

const PLACES = {
  everest: { lat: 27.99, lon: 86.93, dist: 1.6 },
  mariana: { lat: 11.35, lon: 142.2, dist: 1.6 },
  atlantic: { lat: 10, lon: -35, dist: 2.4 },
  andes: { lat: -20, lon: -68, dist: 1.9 },
  thailand: { lat: 13.7, lon: 100.5, dist: 1.8 },
  himalaya: { lat: 31, lon: 85, dist: 2.0 },
};

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.001, 100);
camera.position.copy(latLonToVec3(15, 100, 3.2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.12;
controls.maxDistance = 8;
controls.autoRotate = !reducedMotion;
controls.autoRotateSpeed = 0.4;
controls.addEventListener('start', () => { controls.autoRotate = false; flight = null; });

scene.add(createAtmosphere());

const state = {
  exaggeration: 30,
  relief: 8,
  water: false,
  sea: 0,
  plates: true,
  quality: 'medium',
};

let globe = null;
let grid = null;
let plates = null;
let flight = null;
let loadId = 0;

// ---------- data ----------
async function loadQuality(key) {
  const q = QUALITY[key];
  const id = ++loadId;
  $('loading').hidden = false;
  $('progress').value = 0;
  $('loading-text').textContent = `กำลังโหลดข้อมูลความสูง (${4 ** q.zoom} tiles)…`;
  const merc = await loadMercator(q.zoom, (p) => id === loadId && ($('progress').value = p));
  if (id !== loadId) return; // superseded by a newer quality choice
  $('loading-text').textContent = 'กำลังแปลงพิกัดเป็นทรงกลม…';
  await new Promise(requestAnimationFrame);
  grid = toEquirect(merc, merc.size, merc.size / 2);

  if (globe) { scene.remove(globe.mesh); globe.dispose(); }
  globe = createGlobe(grid, q.segments);
  scene.add(globe.mesh);
  applyState();
  $('loading').hidden = true;
  $('stats').textContent =
    `กริด ${grid.width}×${grid.height} · ต่ำสุด ${fmt(grid.min)} ม. · สูงสุด ${fmt(grid.max)} ม.` +
    (merc.failed ? ` · โหลดไม่สำเร็จ ${merc.failed} tiles` : '');
}

async function loadPlates() {
  try {
    const res = await fetch(PLATES_URL);
    plates = createPlateBoundaries(await res.json());
    scene.add(plates.lines);
    applyState();
  } catch (e) {
    console.warn('plate boundaries unavailable', e);
    $('plates').disabled = true;
  }
}

function applyState() {
  const scale = state.exaggeration / EARTH_RADIUS;
  if (globe) {
    const u = globe.uniforms;
    u.uScale.value = scale;
    u.uRelief.value = state.relief;
    u.uWater.value = state.water;
    u.uSea.value = state.sea;
  }
  if (plates) {
    plates.lines.visible = state.plates;
    if (grid && state.plates) plates.update(grid, scale, state.water, state.sea);
  }
}

// ---------- UI ----------
const fmt = (n) => Math.round(n).toLocaleString('th-TH');

function bindRange(id, key, label) {
  const el = $(id);
  el.value = state[key];
  const sync = () => {
    state[key] = Number(el.value);
    $(`${id}-val`).textContent = label(state[key]);
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
$('quality').value = state.quality;
$('quality').addEventListener('change', (e) => { state.quality = e.target.value; loadQuality(state.quality); });

document.querySelectorAll('[data-place]').forEach((btn) =>
  btn.addEventListener('click', () => flyTo(PLACES[btn.dataset.place])),
);

$('legend-bar').style.background = `linear-gradient(to right, ${RAMP_STOPS.map(
  ([h, c]) => `${c} ${(((h - RAMP_MIN) / (RAMP_MAX - RAMP_MIN)) * 100).toFixed(2)}%`,
).join(', ')})`;

$('toggle-panel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
if (innerWidth < 640) $('panel').classList.add('collapsed');

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
const hit = new THREE.Vector3();

function pick(clientX, clientY) {
  if (!grid) return null;
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const scale = state.exaggeration / EARTH_RADIUS;
  let r = 1;
  let ll = null;
  let h = 0;
  for (let i = 0; i < 4; i++) {
    sphere.radius = r;
    if (!raycaster.ray.intersectSphere(sphere, hit)) return ll && { ...ll, h };
    ll = vec3ToLatLon(hit);
    h = heightAt(grid, ll.lat, ll.lon);
    r = 1 + (state.water ? Math.max(h, state.sea) : h) * scale;
  }
  return { ...ll, h };
}

function showReadout(p) {
  const el = $('readout');
  if (!p) { el.hidden = true; return; }
  el.hidden = false;
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  const below = state.water ? state.sea - p.h : -p.h;
  $('readout-coord').textContent =
    `${Math.abs(p.lat).toFixed(2)}°${ns}  ${Math.abs(p.lon).toFixed(2)}°${ew}`;
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
  controls.autoRotate = false;
  const from = camera.position.clone();
  const to = latLonToVec3(lat, lon, dist);
  if (reducedMotion) { camera.position.copy(to); return; }
  const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  flight = { from, q, d0: from.length(), d1: dist, t0: performance.now(), dur: 1600 };
}

function stepFlight(now) {
  if (!flight) return;
  const t = Math.min(1, (now - flight.t0) / flight.dur);
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const q = new THREE.Quaternion().slerp(flight.q, e);
  const lift = Math.sin(Math.PI * e) * 0.6; // arc outward mid-flight
  const d = flight.d0 + (flight.d1 - flight.d0) * e + lift;
  camera.position.copy(flight.from).normalize().applyQuaternion(q).multiplyScalar(d);
  if (t >= 1) flight = null;
}

// ---------- loop ----------
const right = new THREE.Vector3();
const up = new THREE.Vector3();
function frame(now) {
  stepFlight(now);
  const dist = camera.position.length();
  controls.rotateSpeed = THREE.MathUtils.clamp((dist - 1) * 0.6, 0.04, 1);
  controls.zoomSpeed = THREE.MathUtils.clamp((dist - 1) * 0.8, 0.2, 1);
  controls.update();

  if (globe) {
    // Headlight from upper-left of the view, so relief reads well from any angle.
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    globe.uniforms.uSun.value
      .copy(camera.position).normalize()
      .addScaledVector(up, 0.7).addScaledVector(right, -0.6).normalize();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

loadQuality(state.quality).then(loadPlates);
