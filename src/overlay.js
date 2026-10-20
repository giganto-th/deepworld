// Map overlays draped on the 3D terrain: roads and place names as transparent raster tiles
// (Esri reference layers, which carry no land fill so the terrain shows through). Tiles for a
// surface's Web Mercator range are drawn into one canvas per layer and used as a texture.
import * as THREE from 'three';

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference';
export const OVERLAY_LAYERS = {
  roads: (z, x, y) => `${ESRI}/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
  places: (z, x, y) => `${ESRI}/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
};
export const OVERLAY_ATTRIBUTION = 'Esri, HERE, Garmin, © OpenStreetMap contributors, GIS user community';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// Draws one layer's tiles for range t = { z, x0, y0, nx, ny } into a texture.
// Resolves null when stale (the surface it was for has been replaced).
export async function loadOverlay(layer, t, { isStale = () => false, concurrency = 8 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = t.nx * 256;
  canvas.height = t.ny * 256;
  const ctx = canvas.getContext('2d');
  const n = 2 ** t.z;
  const jobs = [];
  for (let y = 0; y < t.ny; y++) for (let x = 0; x < t.nx; x++) jobs.push([x, y]);
  let drawn = 0;
  const worker = async () => {
    while (jobs.length && !isStale()) {
      const [x, y] = jobs.shift();
      try {
        const img = await loadImage(OVERLAY_LAYERS[layer](t.z, (((t.x0 + x) % n) + n) % n, t.y0 + y));
        ctx.drawImage(img, x * 256, y * 256);
        drawn++;
      } catch { /* missing tile: leave transparent */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (isStale() || !drawn) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace; // shader works in display (sRGB) space
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8; // stays sharp on oblique (tilted) views
  return texture;
}

// Overlay zoom for a terrain range: the same zoom when the tile count is reasonable,
// otherwise one or two levels coarser (labels stay legible; fewer requests).
export function overlayRange(t, maxTiles = 160) {
  let r = { ...t };
  while (r.nx * r.ny > maxTiles && r.z > 3) {
    const z = r.z - 1;
    const x0 = Math.floor(r.x0 / 2);
    const y0 = Math.floor(r.y0 / 2);
    r = { z, x0, y0, nx: Math.floor((r.x0 + r.nx - 1) / 2) - x0 + 1, ny: Math.floor((r.y0 + r.ny - 1) / 2) - y0 + 1 };
  }
  return r;
}
