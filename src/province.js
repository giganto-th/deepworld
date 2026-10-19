import * as THREE from 'three';

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

// Highest and lowest (on land) grid samples inside the province polygon.
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

  let hi = -Infinity, lo = Infinity, hiIdx = -1, loIdx = -1;
  for (let y = 0; y < H; y++) {
    const row = (H - 1 - y) * W; // grid row 0 = south
    for (let x = 0; x < W; x++) {
      if (mask[(y * W + x) * 4 + 3] < 128) continue;
      const h = data[row + x];
      if (h > hi) { hi = h; hiIdx = row + x; }
      // Lowest point on land: coastal outlines include some sea, which is not "the province's" low.
      if (h < lo && h >= LAND_MIN) { lo = h; loIdx = row + x; }
    }
  }
  if (hiIdx < 0) return null;
  if (loIdx < 0) { loIdx = hiIdx; lo = hi; }
  const at = (idx, h) => ({
    lat: grid.latMin + ((Math.floor(idx / W) + 0.5) / H) * (grid.latMax - grid.latMin),
    lon: grid.lonMin + (((idx % W) + 0.5) / W) * (grid.lonMax - grid.lonMin),
    h,
  });
  return { max: at(hiIdx, hi), min: at(loIdx, lo) };
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
