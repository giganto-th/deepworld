import * as THREE from 'three';
import { lonToTileX, latToTileY } from './elevation.js';

// Tiles covering a province's bounds at the finest zoom that fits `maxTiles` and the GPU
// texture size (the province view's detail patch, also used by tools/precompute.html).
export function provinceTileRange(b, { maxDim = 8192, maxTiles = 240, maxZoom = 12 } = {}) {
  const padLat = (b.latMax - b.latMin) * 0.06;
  const padLon = (b.lonMax - b.lonMin) * 0.06;
  for (let z = maxZoom; z >= 5; z--) {
    const x0 = Math.floor(lonToTileX(b.lonMin - padLon, z));
    const x1 = Math.floor(lonToTileX(b.lonMax + padLon, z));
    const y0 = Math.floor(latToTileY(b.latMax + padLat, z));
    const y1 = Math.floor(latToTileY(b.latMin - padLat, z));
    const t = { z, x0, y0, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
    if (t.nx * t.ny <= maxTiles && t.nx * 256 <= maxDim && t.ny * 256 <= maxDim) return t;
  }
  return null;
}

// Even-odd point-in-polygon over a feature's rings ([lon, lat] arrays).
export function inRings(lines, lat, lon) {
  let inside = false;
  for (const ring of lines) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Lat/lon bounding box of a province's rings.
export function bbox(f) {
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const ring of f.lines) {
    for (const [lon, lat] of ring) {
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
    }
  }
  return { latMin, latMax, lonMin, lonMax };
}

// Lowest point counts land at or above sea level; values below are sea or coastal data noise.
const LAND_MIN = 0;

// Highest and lowest (on land) points inside the province polygon, plus a height histogram.
// The polygon is rasterized onto the grid with a canvas (even-odd fill handles holes),
// which is far cheaper than a point-in-polygon test per sample.
export function extremes(f, grid) {
  const { width: W, height: H, data } = grid;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const sx = W / (grid.lonMax - grid.lonMin);
  const sy = H / (grid.latMax - grid.latMin);
  ctx.beginPath();
  for (const ring of f.lines) {
    ring.forEach(([lon, lat], i) => {
      const x = (lon - grid.lonMin) * sx;
      const y = (grid.latMax - lat) * sy; // canvas row 0 = north
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = '#fff';
  ctx.fill('evenodd');
  const mask = ctx.getImageData(0, 0, W, H).data;

  // Pass 1: highest sample, and a 1 m histogram of land heights.
  const inside = (y, x) => mask[(y * W + x) * 4 + 3] >= 128;
  let hi = -Infinity;
  let hiIdx = -1;
  const meters = new Uint32Array(9000);
  let land = 0;
  for (let y = 0; y < H; y++) {
    const row = (H - 1 - y) * W; // grid row 0 = south
    for (let x = 0; x < W; x++) {
      if (!inside(y, x)) continue;
      const h = data[row + x];
      if (h > hi) { hi = h; hiIdx = row + x; }
      // Coastal outlines include some sea, which is not "the province's" low.
      if (h >= LAND_MIN) { meters[Math.min(8999, Math.floor(h))]++; land++; }
    }
  }
  if (hiIdx < 0) return null;

  // The lowest land is noisier than the peak (coastal fringes, residual pits), so it is the
  // lowest height above the bottom 0.1 % of land samples rather than the single lowest one.
  let floor = 0;
  for (let m = 0, seen = 0; m < meters.length; m++) {
    seen += meters[m];
    if (seen > land * 0.001) { floor = m; break; }
  }
  // Pass 2: the sample closest to that floor (from above).
  let lo = Infinity;
  let loIdx = -1;
  for (let y = 0; y < H; y++) {
    const row = (H - 1 - y) * W;
    for (let x = 0; x < W; x++) {
      if (!inside(y, x)) continue;
      const h = data[row + x];
      if (h >= floor && h < lo) { lo = h; loIdx = row + x; }
    }
  }
  if (loIdx < 0) { loIdx = hiIdx; lo = hi; }
  const at = (idx, h) => ({
    lat: grid.latMin + ((Math.floor(idx / W) + 0.5) / H) * (grid.latMax - grid.latMin),
    lon: grid.lonMin + (((idx % W) + 0.5) / W) * (grid.lonMax - grid.lonMin),
    h,
  });
  const BINS = 14;
  const hist = new Array(BINS).fill(0);
  const span = Math.max(1, hi - lo);
  meters.forEach((n, m) => {
    if (n && m >= lo) hist[Math.min(BINS - 1, Math.floor(((m + 0.5 - lo) / span) * BINS))] += n;
  });
  return { max: at(hiIdx, hi), min: at(loIdx, lo), hist };
}

// A map pin: a stem rising from the ground and a round head that keeps
// a constant on-screen size.
export function createPin(color) {
  const group = new THREE.Group();
  const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const stem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({ color }));
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  const ring = new THREE.Mesh(
    new THREE.SphereGeometry(1.35, 20, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide }),
  );
  head.add(ring); // white outline
  group.add(stem, head);
  [stem, head, ring].forEach((o) => { o.frustumCulled = false; });

  const top = new THREE.Vector3();
  return {
    group,
    top,
    // base: ground point, up: local up, length: stem length (scene units)
    place(base, up, length) {
      top.copy(base).addScaledVector(up, length);
      stemGeo.attributes.position.setXYZ(0, base.x, base.y, base.z);
      stemGeo.attributes.position.setXYZ(1, top.x, top.y, top.z);
      stemGeo.attributes.position.needsUpdate = true;
      head.position.copy(top);
    },
    resize(camera) {
      head.scale.setScalar(camera.position.distanceTo(top) * 0.008);
    },
    dispose() {
      stemGeo.dispose();
      stem.material.dispose();
      head.geometry.dispose();
      head.material.dispose();
      ring.geometry.dispose();
      ring.material.dispose();
    },
  };
}
