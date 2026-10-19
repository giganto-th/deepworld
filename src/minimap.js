// 2D companion map (Leaflet + OpenStreetMap tiles, darkened with a CSS filter): a corner
// mini-map that follows the 3D view, and a full-screen 2D mode. Leaflet loads on first use.
// CARTO's dark basemap now needs an API key, so the standard OSM tiles are used instead
// (low-volume use with attribution, per the OSM tile usage policy).

const LEAFLET_URL = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet-src.esm.js';
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export async function createMiniMap(container, { onClick, onHover, onLeave }) {
  const L = await import(LEAFLET_URL);
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 18,
  }).setView([13.2, 101], 5);
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION, className: 'osm-dark' }).addTo(map);
  map.attributionControl.setPrefix(false);
  const zoom = L.control.zoom({ position: 'bottomright' });

  // The 3D view's center (cross) and the point under the 3D cursor (yellow dot).
  const center = L.circleMarker([0, 0], { radius: 5, color: '#7dd3fc', weight: 2, fill: false, interactive: false }).addTo(map);
  const cursor = L.circleMarker([0, 0], { radius: 5, color: '#0b0f19', weight: 1.5, fillColor: '#ffd166', fillOpacity: 1, interactive: false });
  let highlight = null;
  const pois = L.layerGroup().addTo(map);

  let userUntil = 0; // after the viewer drags/zooms the 2D map, stop following the 3D view briefly
  const touched = () => { userUntil = performance.now() + 4000; };
  map.on('dragstart zoomstart', (e) => { if (e.originalEvent || e.hard) touched(); });
  map.on('mousedown touchstart wheel', touched);
  map.on('click', (e) => onClick?.(e.latlng.lat, wrapLon(e.latlng.lng)));
  map.on('mousemove', (e) => onHover?.(e.latlng.lat, wrapLon(e.latlng.lng)));
  map.on('mouseout', () => onLeave?.());

  let expanded = false;
  return {
    map,
    // Follow the 3D view: center on its ground point at a zoom showing roughly the same width.
    follow(lat, lon, metersPerPixel) {
      center.setLatLng([lat, lon]);
      if (expanded || performance.now() < userUntil || !metersPerPixel) return;
      const z = Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / metersPerPixel);
      const target = Math.max(2, Math.min(17, Math.round(z * 2) / 2));
      const c = map.getCenter();
      const moved = Math.abs(c.lat - lat) + Math.abs(wrapLon(c.lng - lon)) > 0.001 * 2 ** (17 - target);
      if (moved || Math.abs(map.getZoom() - target) >= 0.5) map.setView([lat, lon], target, { animate: false });
    },
    cursor(lat, lon) {
      if (lat == null) { cursor.remove(); return; }
      cursor.setLatLng([lat, lon]).addTo(map);
    },
    // Outline (e.g. the province in the 3D view) as [lon, lat] rings.
    highlight(lines, fit = false) {
      highlight?.remove();
      highlight = null;
      if (!lines) return;
      highlight = L.polyline(lines.map((r) => r.map(([lo, la]) => [la, lo])), { color: '#ffd34d', weight: 2, interactive: false }).addTo(map);
      if (fit) map.fitBounds(highlight.getBounds(), { padding: [20, 20] });
    },
    // World top-10 markers; onPick(p) when one is clicked.
    setPois(list, onPick) {
      pois.clearLayers();
      for (const p of list) {
        const color = p.kind === 'high' ? '#ff8a70' : '#b79cff';
        const m = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#0b0f19', weight: 1.5, fillColor: color, fillOpacity: 1 });
        m.bindTooltip(`${p.kind === 'high' ? '▲' : '▼'}${p.rank} ${p.label}`, { direction: 'top', offset: [0, -6] });
        m.on('click', (e) => { L.DomEvent.stopPropagation(e); onPick?.(p); });
        pois.addLayer(m);
      }
    },
    fitBounds(b) {
      map.fitBounds([[b.latMin, b.lonMin], [b.latMax, b.lonMax]], { padding: [24, 24] });
    },
    flyTo(lat, lon, z) { map.flyTo([lat, lon], z ?? Math.max(map.getZoom(), 9)); },
    center: () => { const c = map.getCenter(); return { lat: c.lat, lon: wrapLon(c.lng), zoom: map.getZoom() }; },
    setExpanded(on) {
      expanded = on;
      if (on) zoom.addTo(map); else zoom.remove();
      // The container changes size with the CSS class; let Leaflet re-measure next frame.
      requestAnimationFrame(() => map.invalidateSize());
    },
    invalidate: () => map.invalidateSize(),
  };
}

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
