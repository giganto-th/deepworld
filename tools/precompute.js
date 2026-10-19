// Builds data/province-extremes.json: each province's highest and lowest land point,
// measured on the same detail tiles the province view uses, and named from
// OpenStreetMap peaks (highest) and the tambon / amphoe it falls in (both).
import { loadMercatorRegion, reproject, despike, tileLon, tileLat, disableTileStorage } from '../src/elevation.js';
import { geojsonLines, EARTH_RADIUS } from '../src/globe.js';
import { bbox, extremes, inRings, provinceTileRange } from '../src/province.js';

const PROVINCES_URL = 'https://cdn.jsdelivr.net/gh/chingchai/OpenGISData-Thailand@master/provinces.geojson';
const SUBDISTRICTS_URL = 'https://cdn.jsdelivr.net/gh/chingchai/OpenGISData-Thailand@master/subdistricts.geojson';
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const PEAK_RADIUS_M = 3000;

const $ = (id) => document.getElementById(id);
const log = (text) => { $('log').textContent += `${text}\n`; $('log').scrollTop = 1e9; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d2r = Math.PI / 180;

disableTileStorage(); // a one-off sweep; keep the viewer's tile cache for viewing

function haversine(a, b) {
  const dLat = (b.lat - a.lat) * d2r;
  const dLon = (b.lon - a.lon) * d2r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(s));
}

// "ดอยอินทนนท์, Doi Inthanon" → "ดอยอินทนนท์": prefer the Thai part of a mixed name.
function thaiName(tags) {
  if (tags['name:th']) return tags['name:th'];
  const name = tags.name;
  if (!name) return null;
  return name.split(/[,/;()]/).map((x) => x.trim()).find((x) => /[\u0E00-\u0E7F]/.test(x)) ?? name;
}

// Every named peak in Thailand's bounding box, from OpenStreetMap, in one request
// (per-point queries get rate limited). Retries across two mirrors.
async function loadPeaks() {
  const q = '[out:json][timeout:120];node[natural=peak](5.5,97.2,20.6,105.8);out;';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(OVERPASS_URLS[attempt % 2], { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const json = await res.json();
      return json.elements
        .map((e) => ({ lat: e.lat, lon: e.lon, name: thaiName(e.tags ?? {}), ele: Number(e.tags?.ele) || null }))
        .filter((e) => e.name);
    } catch (e) {
      log(`  overpass retry ${attempt + 1}: ${e.message}`);
      await sleep(10000 * (attempt + 1));
    }
  }
  log('  overpass unavailable: peaks will be unnamed');
  return [];
}

function nearestPeak(peaks, pt) {
  let best = null;
  for (const p of peaks) {
    if (Math.abs(p.lat - pt.lat) > 0.05 || Math.abs(p.lon - pt.lon) > 0.05) continue;
    const d = haversine(pt, p);
    if (d <= PEAK_RADIUS_M && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

async function run() {
  $('start').disabled = true;
  log('loading boundaries and OpenStreetMap peaks…');
  const [provJson, subJson, peaks] = await Promise.all([
    fetch(PROVINCES_URL).then((r) => r.json()),
    fetch(SUBDISTRICTS_URL).then((r) => r.json()),
    loadPeaks(),
  ]);
  log(`${peaks.length} named peaks`);
  const tambons = new Map();
  for (const f of subJson.features) {
    const p = f.properties;
    const lines = geojsonLines(f.geometry);
    if (!tambons.has(p.pro_code)) tambons.set(p.pro_code, []);
    tambons.get(p.pro_code).push({ name: p.tam_th, amp: p.amp_th, lines, bbox: bbox({ lines }) });
  }
  const place = (code, pt) => {
    const t = tambons.get(code)?.find((x) => pt.lat >= x.bbox.latMin && pt.lat <= x.bbox.latMax &&
      pt.lon >= x.bbox.lonMin && pt.lon <= x.bbox.lonMax && inRings(x.lines, pt.lat, pt.lon));
    if (!t) return null;
    return code === '10' ? `แขวง${t.name} เขต${t.amp}` : `ต.${t.name} อ.${t.amp}`;
  };

  const only = new URLSearchParams(location.search).get('only')?.split(',');
  const features = provJson.features
    .map((f) => ({ name: f.properties.pro_th, code: f.properties.pro_code, lines: geojsonLines(f.geometry) }))
    .filter((f) => !only || only.includes(f.code))
    .sort((a, b) => a.code.localeCompare(b.code));

  const out = {};
  for (const [i, f] of features.entries()) {
    const t0 = performance.now();
    const t = provinceTileRange(bbox(f));
    const merc = await loadMercatorRegion(t.z, t.x0, t.y0, t.nx, t.ny, {
      onProgress: (p, done, total) => { $('progress').textContent = `${i + 1}/${features.length} ${f.name} z${t.z} ${done}/${total}`; },
    });
    despike(merc);
    const grid = reproject(merc, Math.min(merc.width, 8192), Math.min(merc.height, 8192), {
      lonMin: tileLon(t.x0, t.z), lonMax: tileLon(t.x0 + t.nx, t.z),
      latMax: tileLat(t.y0, t.z), latMin: tileLat(t.y0 + t.ny, t.z),
    });
    const ex = extremes(f, grid);
    const mpp = ((grid.lonMax - grid.lonMin) / grid.width) * d2r * EARTH_RADIUS * Math.cos(((grid.latMin + grid.latMax) / 2) * d2r);
    // Lowland provinces' highest "point" is just a rise in the plain; no peak to name.
    const peak = ex.max.h >= 300 ? nearestPeak(peaks, ex.max) : null;
    const round = (pt) => ({ lat: +pt.lat.toFixed(5), lon: +pt.lon.toFixed(5), h: Math.round(pt.h) });
    out[f.code] = {
      province: f.name,
      max: { ...round(ex.max), name: peak?.name ?? null, place: place(f.code, ex.max), peakEle: peak?.ele ?? null, peakDistance: peak ? Math.round(peak.d) : null },
      min: { ...round(ex.min), name: null, place: place(f.code, ex.min) },
      hist: ex.hist,
      mpp: Math.round(mpp),
      z: t.z,
    };
    log(`${f.code} ${f.name}: ▲ ${Math.round(ex.max.h)} m ${peak?.name ?? '(no named peak)'} · ▼ ${Math.round(ex.min.h)} m ${out[f.code].min.place ?? ''} · ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  const result = {
    generated: new Date().toISOString(),
    source: 'AWS Terrain Tiles (despiked), OpenGISData-Thailand (CC BY 4.0), peak names © OpenStreetMap contributors (ODbL)',
    note: 'Lowest = lowest land (≥ 0 m) above the bottom 0.1 % of samples; heights are from the elevation model and may differ from surveyed values.',
    provinces: out,
  };
  $('output').value = JSON.stringify(result, null, 1);
  $('download').disabled = false;
  log('done');
}

$('start').addEventListener('click', run);
$('download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('output').value], { type: 'application/json' }));
  a.download = 'province-extremes.json';
  a.click();
});
