import * as THREE from 'three';

export const EARTH_RADIUS = 6371000;

// Hypsometric + bathymetric color ramp (meters → color).
export const RAMP_MIN = -11000;
export const RAMP_MAX = 9000;
// Black (deepest ocean) → blue → green (lowlands) → brown (mountains), with a hard
// light-blue/dark-green break at sea level so coastlines stand out.
export const RAMP_STOPS = [
  [-11000, '#000000'],
  [-8000, '#020824'],
  [-6000, '#08195a'],
  [-4000, '#0f3a9e'],
  [-2500, '#1a5fd1'],
  [-1000, '#2f86ee'],
  [-200, '#5fb4ff'],
  [-1, '#9fd6ff'],
  [0, '#0b5d1e'],
  [100, '#1f7a2a'],
  [300, '#3f9a35'],
  [600, '#7fae3a'],
  [1000, '#a68c38'],
  [1600, '#956228'],
  [2500, '#74421b'],
  [4000, '#552d11'],
  [6000, '#3d1f0b'],
  [9000, '#2a1407'],
];

function buildRampTexture() {
  const N = 1024;
  const px = new Uint8Array(N * 4);
  const stops = RAMP_STOPS.map(([h, c]) => [h, new THREE.Color(c)]);
  const tmp = new THREE.Color();
  const srgb = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < N; i++) {
    const h = RAMP_MIN + (i / (N - 1)) * (RAMP_MAX - RAMP_MIN);
    let k = 0;
    while (k < stops.length - 2 && h > stops[k + 1][0]) k++;
    const [h0, c0] = stops[k];
    const [h1, c1] = stops[k + 1];
    tmp.copy(c0).lerp(c1, Math.min(1, Math.max(0, (h - h0) / (h1 - h0))));
    tmp.getRGB(srgb, THREE.SRGBColorSpace); // shader works in display (sRGB) space
    px.set([srgb.r * 255, srgb.g * 255, srgb.b * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(px, N, 1, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
const rampTexture = buildRampTexture();

function buildHeightTexture(grid) {
  const half = new Uint16Array(grid.data.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(grid.data[i]);
  const tex = new THREE.DataTexture(half, grid.width, grid.height, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = grid.wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Global uv: u = (lon + 180) / 360, v = (lat + 90) / 180.
const COMMON = /* glsl */ `
  const float PI = 3.141592653589793;
  uniform vec2 uUvMin;   // global uv of this surface's (lonMin, latMin)
  uniform vec2 uUvSize;  // global uv extent of this surface
  vec3 dirFromUv(vec2 g) {
    float lon = (g.x * 2.0 - 1.0) * PI;
    float lat = (g.y - 0.5) * PI;
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }
`;

const vertexShader = /* glsl */ `
  uniform sampler2D uHeight;
  uniform float uScale;
  uniform float uSea;
  uniform bool uWater;
  varying vec2 vUv;
  varying vec2 vG;
  ${COMMON}
  void main() {
    vUv = uv;
    vG = uUvMin + uv * uUvSize;
    float h = texture2D(uHeight, uv).r;
    float hd = uWater ? max(h, uSea) : h;
    vec3 p = dirFromUv(vG) * (1.0 + hd * uScale);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uHeight;
  uniform sampler2D uRamp;
  uniform vec2 uTexel;
  uniform float uRelief;
  uniform float uSea;
  uniform bool uWater;
  uniform vec3 uSun;
  uniform float uRampMin;
  uniform float uRampMax;
  uniform vec4 uHole;    // global uv rect covered by a more detailed surface
  uniform bool uHoleOn;
  varying vec2 vUv;
  varying vec2 vG;
  ${COMMON}
  void main() {
    if (uHoleOn && vG.x > uHole.x && vG.x < uHole.z && vG.y > uHole.y && vG.y < uHole.w) discard;

    float lat = (vG.y - 0.5) * PI;
    float lon = (vG.x * 2.0 - 1.0) * PI;
    float h  = texture2D(uHeight, vUv).r;
    float hE = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
    float hW = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
    float hN = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
    float hS = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;

    const float R = 6371000.0;
    float dx = 2.0 * uTexel.x * uUvSize.x * 2.0 * PI * R * max(cos(lat), 0.02);
    float dy = 2.0 * uTexel.y * uUvSize.y * PI * R;
    float gx = (hE - hW) / dx * uRelief;
    float gy = (hN - hS) / dy * uRelief;

    bool underwater = uWater && h < uSea;
    if (underwater) { gx = 0.0; gy = 0.0; }

    vec3 up = dirFromUv(vG);
    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
    vec3 north = vec3(-sin(lat) * sin(lon), cos(lat), -sin(lat) * cos(lon));
    vec3 n = normalize(up - gx * east - gy * north);

    vec3 color;
    if (underwater) {
      // Color water by depth below the (possibly shifted) sea level, using the ocean half of the ramp.
      float d = min(h - uSea, -1.0);
      color = texture2D(uRamp, vec2(clamp((d - uRampMin) / (uRampMax - uRampMin), 0.0, 1.0), 0.5)).rgb;
    } else {
      float hc = uWater ? max(h, 0.0) : h;
      float t = clamp((hc - uRampMin) / (uRampMax - uRampMin), 0.0, 1.0);
      color = texture2D(uRamp, vec2(t, 0.5)).rgb;
    }

    float lambert = max(dot(n, uSun), 0.0);
    float light = 0.28 + 0.9 * lambert;
    if (underwater) light = 0.55 + 0.45 * max(dot(up, uSun), 0.0);
    gl_FragColor = vec4(color * light, 1.0);
  }
`;

// Ground size of one texel at the grid's center latitude, used to keep hillshade
// contrast similar between the coarse globe and fine detail patches.
function texelMeters(grid) {
  const lat = ((grid.latMin + grid.latMax) / 2) * (Math.PI / 180);
  return ((grid.lonMax - grid.lonMin) / grid.width) * (Math.PI / 180) * EARTH_RADIUS * Math.max(Math.cos(lat), 0.2);
}

// A displaced, shaded piece of the Earth's surface covering `grid`'s bounds.
// The whole globe is a sphere; detail patches are planes mapped onto their lat/lon box.
export function createSurface(grid, { segments = 256, globe = false } = {}) {
  const heightTex = buildHeightTexture(grid);
  const uniforms = {
    uHeight: { value: heightTex },
    uRamp: { value: rampTexture },
    uTexel: { value: new THREE.Vector2(1 / grid.width, 1 / grid.height) },
    uUvMin: { value: new THREE.Vector2((grid.lonMin + 180) / 360, (grid.latMin + 90) / 180) },
    uUvSize: { value: new THREE.Vector2((grid.lonMax - grid.lonMin) / 360, (grid.latMax - grid.latMin) / 180) },
    uScale: { value: 30 / EARTH_RADIUS },
    uRelief: { value: 8 },
    uSea: { value: 0 },
    uWater: { value: false },
    uSun: { value: new THREE.Vector3(0, 0, 1) },
    uRampMin: { value: RAMP_MIN },
    uRampMax: { value: RAMP_MAX },
    uHole: { value: new THREE.Vector4() },
    uHoleOn: { value: false },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  const geometry = globe
    ? new THREE.SphereGeometry(1, segments, segments / 2)
    : new THREE.PlaneGeometry(1, 1, segments, segments);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // vertices are placed in the shader
  const reliefScale = THREE.MathUtils.clamp(Math.sqrt(texelMeters(grid) / 20000), 0.12, 1);
  return {
    mesh,
    grid,
    uniforms,
    setRelief(v) { uniforms.uRelief.value = v * reliefScale; },
    // Hide the part of this surface that `other` (a detail patch) draws instead.
    setHole(other) {
      uniforms.uHoleOn.value = !!other;
      if (!other) return;
      const g = other.grid;
      const iu = ((g.lonMax - g.lonMin) / 360) * 0.01;
      const iv = ((g.latMax - g.latMin) / 180) * 0.01;
      uniforms.uHole.value.set(
        (g.lonMin + 180) / 360 + iu, (g.latMin + 90) / 180 + iv,
        (g.lonMax + 180) / 360 - iu, (g.latMax + 90) / 180 - iv,
      );
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      heightTex.dispose();
    },
  };
}

export function latLonToVec3(lat, lon, r = 1) {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(la) * Math.sin(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.cos(lo) * r);
}

export function vec3ToLatLon(v) {
  const n = v.clone().normalize();
  return {
    lat: (Math.asin(n.y) * 180) / Math.PI,
    lon: (Math.atan2(n.x, n.z) * 180) / Math.PI,
  };
}

// Pulls line vertices slightly toward the camera so they win the depth test
// against the terrain they are draped on, at any viewing distance.
const lineVertex = /* glsl */ `
  uniform float uBias;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.xyz *= 1.0 - uBias;
    gl_Position = projectionMatrix * mv;
  }
`;
const lineFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() { gl_FragColor = vec4(uColor, uOpacity); }
`;

// Splits long segments so the draped line follows the terrain between vertices.
function densify(line, maxStepDeg) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [lon0, lat0] = line[i - 1];
    const [lon1, lat1] = line[i];
    const steps = Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / maxStepDeg);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t]);
    }
  }
  return out;
}

// Lines in [lon, lat] arrays, draped onto the displaced surface.
export function createDrapedLines(lines, { color, opacity = 0.9, maxStepDeg = 0.25, bias = 0.0015 }) {
  const coords = [];
  for (const raw of lines) {
    const line = densify(raw, maxStepDeg);
    for (let i = 0; i < line.length - 1; i++) {
      const [lon0, lat0] = line[i];
      const [lon1, lat1] = line[i + 1];
      if (Math.abs(lon1 - lon0) > 180) continue; // antimeridian jump
      coords.push(lat0, lon0, lat1, lon1);
    }
  }
  const segs = coords.length / 4;
  const positions = new Float32Array(segs * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uBias: { value: bias },
    },
    vertexShader: lineVertex,
    fragmentShader: lineFragment,
    transparent: true,
    depthWrite: false,
  });
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;

  // sample(lat, lon) → surface height in meters (already accounting for water).
  function update(sample, scale) {
    const d2r = Math.PI / 180;
    for (let k = 0; k < segs * 2; k++) {
      const lat = coords[k * 2] * d2r;
      const lon = coords[k * 2 + 1] * d2r;
      const r = 1 + (sample(coords[k * 2], coords[k * 2 + 1]) + 30) * scale + 2e-6;
      positions[k * 3] = Math.cos(lat) * Math.sin(lon) * r;
      positions[k * 3 + 1] = Math.sin(lat) * r;
      positions[k * 3 + 2] = Math.cos(lat) * Math.cos(lon) * r;
    }
    geometry.attributes.position.needsUpdate = true;
  }
  function dispose() {
    geometry.dispose();
    material.dispose();
  }
  return { object, update, dispose };
}

// GeoJSON (Multi)LineString / (Multi)Polygon → arrays of [lon, lat] lines.
export function geojsonLines(geometry) {
  switch (geometry.type) {
    case 'LineString': return [geometry.coordinates];
    case 'MultiLineString': return geometry.coordinates;
    case 'Polygon': return geometry.coordinates;
    case 'MultiPolygon': return geometry.coordinates.flat();
    default: return [];
  }
}
