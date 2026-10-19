// Elevation from AWS Terrain Tiles (Terrarium encoding), reprojected to equirectangular grids.

const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const MAX_LAT = 85.0511287798;
export const MAX_ZOOM = 12;

// Small LRU of decoded tiles so panning around a region reuses what is already loaded.
const cache = new Map();
const CACHE_SIZE = 600;

async function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const promise = (async () => {
    const res = await fetch(TILE_URL(z, x, y), { mode: 'cors' });
    if (!res.ok) throw new Error(`tile ${key}: ${res.status}`);
    // Avoid color management / premultiplication touching the encoded RGB values.
    return createImageBitmap(await res.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  })();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  while (cache.size > CACHE_SIZE) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    old.then((b) => b.close(), () => {});
  }
  return promise;
}

// Tile edges in degrees.
export const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * 2 ** z;
};

// A single 256×256 canvas is reused to decode every tile, so large regions never need
// one huge canvas (browsers cap canvas area, e.g. ~16.7 Mpx in Safari).
let decodeCtx = null;
function decodeInto(img, data, width, ox, oy) {
  if (!decodeCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    decodeCtx = c.getContext('2d', { willReadFrequently: true });
  }
  decodeCtx.clearRect(0, 0, 256, 256);
  decodeCtx.drawImage(img, 0, 0);
  const px = decodeCtx.getImageData(0, 0, 256, 256).data;
  for (let y = 0; y < 256; y++) {
    let i = (oy + y) * width + ox;
    for (let x = 0, j = y * 1024; x < 256; x++, i++, j += 4) {
      const h = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
      // Clamp known spike artifacts to Earth's physical range (Challenger Deep … Everest).
      data[i] = h < -11000 ? -11000 : h > 8850 ? 8850 : h;
    }
  }
}

// Loads tiles [x0, x0+nx) × [y0, y0+ny) at zoom z into one Web Mercator raster (row 0 = north).
// x wraps around the antimeridian; y must be inside [0, 2^z).
export async function loadMercatorRegion(z, x0, y0, nx, ny, { onProgress = () => {}, isStale = () => false } = {}) {
  const n = 2 ** z;
  const width = 256 * nx;
  const height = 256 * ny;
  const data = new Float32Array(width * height); // failed tiles stay at 0 m

  const jobs = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) jobs.push([x, y]);
  const total = jobs.length;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (jobs.length && !isStale()) {
      const [x, y] = jobs.shift();
      try {
        const img = await loadTile(z, (((x0 + x) % n) + n) % n, y0 + y);
        decodeInto(img, data, width, x * 256, y * 256);
      } catch {
        failed++;
      }
      onProgress(++done / total, done, total);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  if (isStale()) return null;
  return { z, x0, y0, nx, ny, width, height, data, failed };
}

// Mercator raster → equirectangular grid W×H over `bounds`, row 0 = south (texture v = 0).
// Latitudes outside the raster are clamped to its edge (the poles, for the global grid).
export function reproject(merc, W, H, bounds) {
  const { z, x0, y0, width: S, height: SH, data: src } = merc;
  const wrap = merc.nx === 2 ** z;
  const out = new Float32Array(W * H);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < H; j++) {
    const lat = bounds.latMin + ((j + 0.5) / H) * (bounds.latMax - bounds.latMin);
    const my = (latToTileY(lat, z) - y0) * 256 - 0.5;
    const y0i = Math.max(0, Math.min(SH - 1, Math.floor(my)));
    const y1i = Math.min(SH - 1, y0i + 1);
    const fy = Math.max(0, Math.min(1, my - y0i));
    for (let i = 0; i < W; i++) {
      const lon = bounds.lonMin + ((i + 0.5) / W) * (bounds.lonMax - bounds.lonMin);
      const mx = (lonToTileX(lon, z) - x0) * 256 - 0.5;
      let xa = Math.floor(mx);
      const fx = mx - xa;
      let xb = xa + 1;
      if (wrap) {
        xa = ((xa % S) + S) % S;
        xb = xb % S;
      } else {
        xa = Math.max(0, Math.min(S - 1, xa));
        xb = Math.max(0, Math.min(S - 1, xb));
      }
      const a = src[y0i * S + xa] * (1 - fx) + src[y0i * S + xb] * fx;
      const b = src[y1i * S + xa] * (1 - fx) + src[y1i * S + xb] * fx;
      const h = a * (1 - fy) + b * fy;
      out[j * W + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { width: W, height: H, data: out, min, max, wrap, ...bounds };
}

export const GLOBAL_BOUNDS = { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 };

export async function loadGlobal(z, onProgress) {
  const n = 2 ** z;
  const merc = await loadMercatorRegion(z, 0, 0, n, n, { onProgress });
  const grid = reproject(merc, merc.width, merc.width / 2, GLOBAL_BOUNDS);
  grid.failed = merc.failed;
  return grid;
}

export function contains(grid, lat, lon) {
  return lat >= grid.latMin && lat <= grid.latMax && lon >= grid.lonMin && lon <= grid.lonMax;
}

// Bilinear height lookup in degrees.
export function heightAt(grid, lat, lon) {
  const { width: W, height: H, data } = grid;
  let u = ((lon - grid.lonMin) / (grid.lonMax - grid.lonMin)) * W - 0.5;
  if (grid.wrap) u = ((u % W) + W) % W;
  else u = Math.max(0, Math.min(W - 1.001, u));
  const v = Math.max(0, Math.min(H - 1.001, ((lat - grid.latMin) / (grid.latMax - grid.latMin)) * H - 0.5));
  const x0 = Math.floor(u);
  const fx = u - x0;
  const y0 = Math.floor(v);
  const fy = v - y0;
  const xa = grid.wrap ? (x0 + W) % W : x0;
  const xb = grid.wrap ? (x0 + 1) % W : Math.min(W - 1, x0 + 1);
  const r0 = data[y0 * W + xa] * (1 - fx) + data[y0 * W + xb] * fx;
  const r1 = data[(y0 + 1) * W + xa] * (1 - fx) + data[(y0 + 1) * W + xb] * fx;
  return r0 * (1 - fy) + r1 * fy;
}
