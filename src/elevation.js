// Global elevation from AWS Terrain Tiles (Terrarium encoding), reprojected to equirectangular.

const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const MAX_LAT = 85.0511287798;

async function loadTile(z, x, y) {
  const res = await fetch(TILE_URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: ${res.status}`);
  // Avoid color management / premultiplication touching the encoded RGB values.
  return createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
}

// Returns { size, data: Float32Array(size*size) } in Web Mercator, row 0 = north.
export async function loadMercator(z, onProgress = () => {}) {
  const n = 2 ** z;
  const size = 256 * n;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) jobs.push([x, y]);
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const [x, y] = jobs.shift();
      try {
        const img = await loadTile(z, x, y);
        ctx.drawImage(img, x * 256, y * 256);
        img.close();
      } catch {
        failed++;
        ctx.fillStyle = 'rgb(128,0,0)'; // decodes to 0 m
        ctx.fillRect(x * 256, y * 256, 256, 256);
      }
      onProgress(++done / (n * n));
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  const px = ctx.getImageData(0, 0, size, size).data;
  const data = new Float32Array(size * size);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const h = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    // Clamp known spike artifacts to Earth's physical range (Challenger Deep … Everest).
    data[i] = Math.max(-11000, Math.min(8850, h));
  }
  return { size, data, failed };
}

// Mercator → equirectangular grid W×H, row 0 = south (matches texture v = 0).
export function toEquirect(merc, W, H) {
  const { size: S, data: src } = merc;
  const out = new Float32Array(W * H);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < H; j++) {
    let lat = -90 + ((j + 0.5) / H) * 180;
    lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const phi = (lat * Math.PI) / 180;
    const my = ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * S - 0.5;
    const y0 = Math.max(0, Math.min(S - 1, Math.floor(my)));
    const y1 = Math.min(S - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, my - y0));
    for (let i = 0; i < W; i++) {
      const mx = ((i + 0.5) / W) * S - 0.5;
      const xf = Math.floor(mx);
      const fx = mx - xf;
      const x0 = (xf + S) % S;
      const x1 = (x0 + 1) % S;
      const a = src[y0 * S + x0] * (1 - fx) + src[y0 * S + x1] * fx;
      const b = src[y1 * S + x0] * (1 - fx) + src[y1 * S + x1] * fx;
      const h = a * (1 - fy) + b * fy;
      out[j * W + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { width: W, height: H, data: out, min, max };
}

// Bilinear height lookup in degrees.
export function heightAt(grid, lat, lon) {
  const { width: W, height: H, data } = grid;
  const u = (((lon + 180) / 360) % 1 + 1) % 1 * W - 0.5;
  const v = Math.max(0, Math.min(H - 1.001, ((lat + 90) / 180) * H - 0.5));
  const x0 = Math.floor(u);
  const fx = u - x0;
  const y0 = Math.floor(v);
  const fy = v - y0;
  const xa = (x0 + W) % W;
  const xb = (x0 + 1) % W;
  const r0 = data[y0 * W + xa] * (1 - fx) + data[y0 * W + xb] * fx;
  const r1 = data[(y0 + 1) * W + xa] * (1 - fx) + data[(y0 + 1) * W + xb] * fx;
  return r0 * (1 - fy) + r1 * fy;
}
