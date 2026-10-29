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
