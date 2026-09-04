/**
 * Geospatial services: distance maths, ward resolution and reverse geocoding.
 * Reverse geocoding uses OpenStreetMap Nominatim (open data). If the network is
 * unavailable the platform degrades to a deterministic grid-cell ward code so
 * routing never blocks.
 */
import config from '../config.js';

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  if (!a || !b) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** ~1.1 km grid cell - a stable offline fallback ward identifier. */
export function gridCell({ lat, lng }) {
  const y = Math.floor(lat * 100);
  const x = Math.floor(lng * 100);
  return `GRID-${y}-${x}`;
}

const cache = new Map();
const key = ({ lat, lng }) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

export async function reverseGeocode(point) {
  if (!point) return null;
  const k = key(point);
  if (cache.has(k)) return cache.get(k);

  const fallback = {
    address: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`,
    ward: gridCell(point),
    wardName: `Grid Sector ${gridCell(point).slice(5)}`,
    city: null, state: null, postcode: null, source: 'offline-grid'
  };

  if (!config.geo.reverseGeocode) {
    cache.set(k, fallback);
    return fallback;
  }

  try {
    const url = `${config.geo.nominatim}/reverse?format=jsonv2&lat=${point.lat}&lon=${point.lng}&zoom=17&addressdetails=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      headers: { 'User-Agent': config.geo.userAgent, 'Accept-Language': 'en' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const a = j.address || {};
    const wardName = a.suburb || a.neighbourhood || a.city_district || a.village || a.town || a.county || null;
    const out = {
      address: j.display_name || fallback.address,
      ward: wardName ? wardName.toUpperCase().replace(/\s+/g, '-') : gridCell(point),
      wardName: wardName || fallback.wardName,
      road: a.road || null,
      city: a.city || a.town || a.village || a.state_district || null,
      state: a.state || null,
      postcode: a.postcode || null,
      addressDetail: a,
      source: 'nominatim'
    };
    cache.set(k, out);
    return out;
  } catch {
    cache.set(k, fallback);
    return fallback;
  }
}

/** Nearby open issues of the same category = crowd cluster / duplicate. */
export function findNearby(issues, point, category, radiusM) {
  return issues
    .filter((i) => i.location && ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED'].includes(i.status))
    .map((i) => ({ issue: i, distance: haversine(point, i.location) }))
    .filter((x) => x.distance <= radiusM && (!category || x.issue.category === category))
    .sort((a, b) => a.distance - b.distance);
}

/** Hotspot detection: grid-bucket issues and rank the densest cells. */
export function hotspots(issues, minCount = 3) {
  const buckets = new Map();
  for (const i of issues) {
    if (!i.location) continue;
    const cell = gridCell(i.location);
    if (!buckets.has(cell)) buckets.set(cell, { cell, count: 0, issues: [], lat: 0, lng: 0, categories: {} });
    const b = buckets.get(cell);
    b.count++;
    b.lat += i.location.lat;
    b.lng += i.location.lng;
    b.categories[i.category] = (b.categories[i.category] || 0) + 1;
    b.issues.push(i.id);
  }
  return [...buckets.values()]
    .filter((b) => b.count >= minCount)
    .map((b) => ({
      ...b,
      lat: b.lat / b.count,
      lng: b.lng / b.count,
      dominant: Object.entries(b.categories).sort((x, y) => y[1] - x[1])[0]?.[0] || null
    }))
    .sort((a, b) => b.count - a.count);
}

export default { haversine, reverseGeocode, findNearby, hotspots, gridCell };
