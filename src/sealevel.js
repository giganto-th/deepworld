// Global mean sea level (GMSL) by year: observations to today, then IPCC AR6 projections.
// Heights are metres relative to the 1995–2014 average (≈ the SRTM era of the terrain data,
// so 0 here is the coastline drawn on the map).
//
// Sources
// - Observed: IPCC AR6 WG1 — +0.20 m from 1901 to 2018; 1.3 mm/yr (1901–1971),
//   1.9 mm/yr (1971–2006), 3.7 mm/yr (2006–2018); ~4.5 mm/yr in recent years (satellite).
// - Projections: IPCC AR6 WG1 Table 9.9 (median and likely range; for the low-confidence
//   SSP5-8.5 case, the 17th–83rd percentiles), as tabulated by the Hong Kong Observatory.

export const OBSERVED = [ // [year, metres]
  [1901, -0.156], [1971, -0.065], [2005, 0], [2018, 0.048], [2024, 0.075],
];
export const NOW = 2024;

// [year, median, low, high]
export const SCENARIOS = [
  { id: 'ssp119', name: 'SSP1-1.9', th: 'ปล่อยก๊าซต่ำมาก', en: 'Very low emissions', color: '#5fd3a8',
    points: [[2030, 0.09, 0.08, 0.12], [2050, 0.18, 0.15, 0.23], [2090, 0.35, 0.26, 0.49], [2100, 0.38, 0.28, 0.55], [2150, 0.57, 0.37, 0.86]] },
  { id: 'ssp126', name: 'SSP1-2.6', th: 'ปล่อยก๊าซต่ำ', en: 'Low emissions', color: '#9be27a',
    points: [[2030, 0.09, 0.08, 0.12], [2050, 0.19, 0.16, 0.25], [2090, 0.39, 0.30, 0.54], [2100, 0.44, 0.32, 0.62], [2150, 0.68, 0.46, 0.99]] },
  { id: 'ssp245', name: 'SSP2-4.5', th: 'ปานกลาง', en: 'Intermediate', color: '#ffd166',
    points: [[2030, 0.09, 0.08, 0.12], [2050, 0.20, 0.17, 0.26], [2090, 0.48, 0.38, 0.65], [2100, 0.56, 0.44, 0.76], [2150, 0.92, 0.66, 1.33]] },
  { id: 'ssp370', name: 'SSP3-7.0', th: 'สูง', en: 'High emissions', color: '#ff9f5a',
    points: [[2030, 0.10, 0.08, 0.12], [2050, 0.22, 0.18, 0.27], [2090, 0.56, 0.46, 0.74], [2100, 0.68, 0.55, 0.90], [2150, 1.19, 0.89, 1.65]] },
  { id: 'ssp585', name: 'SSP5-8.5', th: 'สูงมาก', en: 'Very high emissions', color: '#ff6b6b',
    points: [[2030, 0.10, 0.09, 0.12], [2050, 0.23, 0.20, 0.29], [2090, 0.63, 0.52, 0.83], [2100, 0.77, 0.63, 1.01], [2150, 1.32, 0.98, 1.88]] },
  { id: 'ssp585lc', name: 'SSP5-8.5 LC', th: 'สูงมาก + แผ่นน้ำแข็งละลายเร็ว', en: 'Very high + fast ice-sheet loss', color: '#d58cff', lowConfidence: true,
    points: [[2030, 0.10, 0.09, 0.15], [2050, 0.24, 0.20, 0.40], [2090, 0.71, 0.52, 1.30], [2100, 0.88, 0.63, 1.60], [2150, 1.98, 0.98, 4.82]] },
];
export const FIRST_YEAR = 1901;
export const LAST_YEAR = 2150;

const lerp = (a, b, t) => a + (b - a) * t;
function interp(points, year, col) {
  if (year <= points[0][0]) return points[0][col];
  for (let i = 1; i < points.length; i++) {
    const [y1] = points[i];
    if (year <= y1) {
      const [y0] = points[i - 1];
      return lerp(points[i - 1][col], points[i][col], (year - y0) / (y1 - y0));
    }
  }
  return points[points.length - 1][col];
}

// { median, low, high } in metres for a scenario at a year (observations up to NOW).
export function seaLevelAt(scenarioId, year) {
  if (year <= NOW) {
    const v = interp(OBSERVED, year, 1);
    return { median: v, low: v, high: v, observed: true };
  }
  const sc = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[2];
  // Join today's observed value to the projection points.
  const now = interp(OBSERVED, NOW, 1);
  const pts = [[NOW, now, now, now], ...sc.points];
  return { median: interp(pts, year, 1), low: interp(pts, year, 2), high: interp(pts, year, 3), observed: false };
}

// SVG chart: observed line, every scenario's median, the selected scenario's likely range,
// and a marker at the selected year. `lang` picks the axis labels' era (th: B.E.).
export function renderChart(svg, { scenarioId, year, lang }) {
  const W = 268, H = 150, L = 30, R = 8, T = 10, B = 22;
  const sel = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[2];
  const top = Math.max(1.0, Math.ceil(sel.points[sel.points.length - 1][3] * 2) / 2);
  const bottom = -0.25;
  const x = (yr) => L + ((yr - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR)) * (W - L - R);
  const y = (m) => T + ((top - Math.min(top, m)) / (top - bottom)) * (H - T - B);
  const path = (pts) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join('');
  const nowV = interp(OBSERVED, NOW, 1);
  const parts = [];
  // grid + y labels
  for (let m = 0; m <= top + 1e-6; m += top > 2 ? 1 : 0.5) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}" class="g"/>`);
    parts.push(`<text x="${L - 4}" y="${y(m) + 3}" text-anchor="end">${m === 0 ? '0' : `+${m}`}</text>`);
  }
  // x labels: 1950, 2000, 2050, 2100, 2150 (B.E. in Thai)
  for (const yr of [1950, 2000, 2050, 2100, 2150]) {
    parts.push(`<text x="${x(yr)}" y="${H - 6}" text-anchor="middle">${lang === 'th' ? yr + 543 : yr}</text>`);
  }
  // selected range band
  const band = [[NOW, nowV, nowV], ...sel.points.map((p) => [p[0], p[2], p[3]])];
  const bandPath = `M${band.map(([a, lo]) => `${x(a).toFixed(1)},${y(lo).toFixed(1)}`).join('L')}L${[...band].reverse().map(([a, , hi]) => `${x(a).toFixed(1)},${y(hi).toFixed(1)}`).join('L')}Z`;
  parts.push(`<path d="${bandPath}" fill="${sel.color}" opacity="0.18"/>`);
  for (const s of SCENARIOS) {
    if (s.lowConfidence && s !== sel) continue;
    const pts = [[NOW, nowV], ...s.points.map((p) => [p[0], p[1]])];
    parts.push(`<path d="${path(pts)}" fill="none" stroke="${s.color}" stroke-width="${s === sel ? 2.4 : 1.2}" opacity="${s === sel ? 1 : 0.45}"/>`);
  }
  parts.push(`<path d="${path(OBSERVED)}" fill="none" stroke="#e8edf7" stroke-width="2"/>`);
  // year marker
  const v = seaLevelAt(scenarioId, year).median;
  parts.push(`<line x1="${x(year)}" x2="${x(year)}" y1="${T}" y2="${H - B}" class="m"/>`);
  parts.push(`<circle cx="${x(year)}" cy="${y(v)}" r="4" fill="#ffd166" stroke="#0b0f19" stroke-width="1.5"/>`);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
}

// ---------- long timescales ----------
// Past ~26,000 years, metres vs. today, by years before present (BP).
// Global (ice-volume) curve: approximate, after Lambeck et al. 2014 (PNAS): ~-134 m at the
// Last Glacial Maximum (~21 ka), main rise 16.5–8.2 ka (~12 m per 1,000 yr) including
// Meltwater Pulse 1A (~18 m in ~500 yr, ~14.6 ka), near today's level by ~7 ka.
// Gulf of Thailand (relative): the same rise, then a mid-Holocene highstand of ~+2.5 to
// +4 m around 6.5–7 ka that flooded the lower Chao Phraya plain (Thai coastal studies).
export const PAST = {
  global: [[26000, -125], [21000, -134], [16500, -125], [14700, -105], [14200, -86], [12900, -66],
    [11700, -58], [11000, -50], [10000, -40], [9000, -27], [8200, -15], [7000, -4], [6000, -1.5],
    [4000, -0.5], [2000, -0.2], [0, 0]],
  gulf: [[26000, -125], [21000, -134], [16500, -125], [14700, -105], [14200, -86], [12900, -66],
    [11700, -58], [11000, -50], [10000, -40], [9000, -22], [8000, -5], [7000, 2.5], [6500, 4],
    [5000, 3], [3000, 1.5], [1000, 0.5], [0, 0]],
};
export const PAST_MAX = 26000;

// Committed rise over the next 10,000 years by peak warming (IPCC AR6 WG1 Box 9.4):
// 2,000-year and 10,000-year ranges; 2150 from the SSP closest to each warming level.
export const FUTURE = [
  { id: 'w15', label: '1.5°C', color: '#5fd3a8', y2150: [0.37, 0.86], y2k: [2, 3], y10k: [6, 7] },
  { id: 'w2', label: '2°C', color: '#9be27a', y2150: [0.46, 0.99], y2k: [2, 6], y10k: [8, 13] },
  { id: 'w3', label: '3°C', color: '#ffd166', y2150: [0.66, 1.33], y2k: [4, 10], y10k: [10, 24] },
  { id: 'w4', label: '4°C', color: '#ff9f5a', y2150: [0.89, 1.65], y2k: [12, 16], y10k: [19, 33] },
  { id: 'w5', label: '5°C', color: '#ff6b6b', y2150: [0.98, 1.88], y2k: [19, 22], y10k: [28, 37] },
];
export const FUTURE_FROM = 2150;
export const FUTURE_TO = 12000; // ~10,000 years from now

export function pastLevel(curve, yearsBP) {
  // Points run from oldest to now; as negative years they ascend, as interp() needs.
  return interp(PAST[curve].map(([a, m]) => [-a, m]), -yearsBP, 1);
}

// { low, mid, high } for a warming level at a calendar year (2150 … 12000).
export function futureLevel(id, year) {
  const w = FUTURE.find((f) => f.id === id) ?? FUTURE[1];
  const pts = [[FUTURE_FROM, ...w.y2150], [4000, ...w.y2k], [FUTURE_TO, ...w.y10k]];
  const low = interp(pts.map(([y, lo]) => [y, lo]), year, 1);
  const high = interp(pts.map(([y, , hi]) => [y, hi]), year, 1);
  return { low, high, mid: (low + high) / 2 };
}

// Generic line chart: series [{ pts: [[x, y]], color, width, opacity }], optional band
// { lo: [[x, y]], hi: [[x, y]], color }, axis ticks [[value, label]], and a marker [x, y].
export function renderSeries(svg, { series, band, x: [x0, x1], y: [y0, y1], xTicks, yTicks, marker }) {
  const W = 268, H = 150, L = 34, R = 8, T = 10, B = 22;
  const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const sy = (v) => T + ((y1 - Math.max(y0, Math.min(y1, v))) / (y1 - y0)) * (H - T - B);
  const d = (pts) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join('');
  const out = [];
  for (const [v, label] of yTicks) {
    out.push(`<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="g"/>`);
    out.push(`<text x="${L - 4}" y="${sy(v) + 3}" text-anchor="end">${label}</text>`);
  }
  for (const [v, label] of xTicks) out.push(`<text x="${sx(v)}" y="${H - 6}" text-anchor="middle">${label}</text>`);
  if (band) out.push(`<path d="${d(band.lo)}L${d([...band.hi].reverse()).slice(1)}Z" fill="${band.color}" opacity="0.18"/>`);
  for (const s of series) out.push(`<path d="${d(s.pts)}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}" opacity="${s.opacity ?? 1}"/>`);
  if (marker) {
    out.push(`<line x1="${sx(marker[0])}" x2="${sx(marker[0])}" y1="${T}" y2="${H - B}" class="m"/>`);
    out.push(`<circle cx="${sx(marker[0])}" cy="${sy(marker[1])}" r="4" fill="#ffd166" stroke="#0b0f19" stroke-width="1.5"/>`);
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out.join('');
}
