import * as THREE from 'three';
import { heightAt } from './elevation.js';

export const EARTH_RADIUS = 6371000;

// Hypsometric + bathymetric color ramp (meters → color).
export const RAMP_MIN = -11000;
export const RAMP_MAX = 9000;
export const RAMP_STOPS = [
  [-11000, '#06122b'],
  [-7000, '#0c2659'],
  [-5000, '#173f80'],
  [-3000, '#25609f'],
  [-1000, '#3f86c0'],
  [-200, '#6cb2dd'],
  [-1, '#a9d8f0'],
  [0, '#3f7f3e'],
  [300, '#7fa85a'],
  [800, '#c9c27d'],
  [1600, '#b98d52'],
  [2800, '#8a5b3b'],
  [4200, '#9b928b'],
  [5500, '#e9e6e2'],
  [9000, '#ffffff'],
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

function buildHeightTexture(grid) {
  const half = new Uint16Array(grid.data.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(grid.data[i]);
  const tex = new THREE.DataTexture(half, grid.width, grid.height, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const COMMON = /* glsl */ `
  const float PI = 3.141592653589793;
  vec3 dirFromUv(vec2 uv) {
    float lon = (uv.x * 2.0 - 1.0) * PI;
    float lat = (uv.y - 0.5) * PI;
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }
`;

const vertexShader = /* glsl */ `
  uniform sampler2D uHeight;
  uniform float uScale;
  uniform float uSea;
  uniform bool uWater;
  varying vec2 vUv;
  ${COMMON}
  void main() {
    vUv = uv;
    float h = texture2D(uHeight, uv).r;
    float hd = uWater ? max(h, uSea) : h;
    vec3 p = dirFromUv(uv) * (1.0 + hd * uScale);
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
  varying vec2 vUv;
  ${COMMON}
  void main() {
    float lat = (vUv.y - 0.5) * PI;
    float lon = (vUv.x * 2.0 - 1.0) * PI;
    float h  = texture2D(uHeight, vUv).r;
    float hE = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
    float hW = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
    float hN = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
    float hS = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;

    const float R = 6371000.0;
    float dx = 2.0 * uTexel.x * 2.0 * PI * R * max(cos(lat), 0.02);
    float dy = 2.0 * uTexel.y * PI * R;
    float gx = (hE - hW) / dx * uRelief;
    float gy = (hN - hS) / dy * uRelief;

    bool underwater = uWater && h < uSea;
    if (underwater) { gx = 0.0; gy = 0.0; }

    vec3 up = dirFromUv(vUv);
    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
    vec3 north = vec3(-sin(lat) * sin(lon), cos(lat), -sin(lat) * cos(lon));
    vec3 n = normalize(up - gx * east - gy * north);

    vec3 color;
    if (underwater) {
      float depth = uSea - h;
      color = mix(vec3(0.33, 0.62, 0.82), vec3(0.03, 0.12, 0.30), smoothstep(0.0, 6000.0, depth));
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

export function createGlobe(grid, segments) {
  const heightTex = buildHeightTexture(grid);
  const uniforms = {
    uHeight: { value: heightTex },
    uRamp: { value: buildRampTexture() },
    uTexel: { value: new THREE.Vector2(1 / grid.width, 1 / grid.height) },
    uScale: { value: 30 / EARTH_RADIUS },
    uRelief: { value: 8 },
    uSea: { value: 0 },
    uWater: { value: false },
    uSun: { value: new THREE.Vector3(0, 0, 1) },
    uRampMin: { value: RAMP_MIN },
    uRampMax: { value: RAMP_MAX },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  const geometry = new THREE.SphereGeometry(1, segments, segments / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // displaced vertices exceed the unit-sphere bounds
  return {
    mesh,
    uniforms,
    dispose() {
      geometry.dispose();
      material.dispose();
      heightTex.dispose();
      uniforms.uRamp.value.dispose();
    },
  };
}

export function createAtmosphere() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float rim = pow(1.0 - abs(dot(vNormal, vView)), 3.0);
        gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim, rim);
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.12, 96, 48), material);
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

// Plate boundaries as line segments draped just above the displaced surface.
export function createPlateBoundaries(geojson) {
  const coords = [];
  for (const f of geojson.features) {
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const [lon0, lat0] = line[i];
        const [lon1, lat1] = line[i + 1];
        if (Math.abs(lon1 - lon0) > 180) continue; // antimeridian jump
        coords.push(lat0, lon0, lat1, lon1);
      }
    }
  }
  const segs = coords.length / 4;
  const positions = new Float32Array(segs * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.9 });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;

  function update(grid, scale, water, sea) {
    const v = new THREE.Vector3();
    for (let s = 0; s < segs; s++) {
      for (let e = 0; e < 2; e++) {
        const lat = coords[s * 4 + e * 2];
        const lon = coords[s * 4 + e * 2 + 1];
        let h = heightAt(grid, lat, lon);
        if (water) h = Math.max(h, sea);
        v.copy(latLonToVec3(lat, lon, 1 + h * scale + 0.0015));
        positions.set([v.x, v.y, v.z], (s * 2 + e) * 3);
      }
    }
    geometry.attributes.position.needsUpdate = true;
  }
  return { lines, update };
}
