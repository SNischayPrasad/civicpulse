/**
 * Contractor accountability service.
 *
 * Answers "who built this, and are they still liable?" using OPEN data:
 *
 *  1. OpenStreetMap / Overpass API - live query for construction works,
 *     roadworks and utility sites near the issue, reading the open `operator`,
 *     `contractor` and `construction` tags contributed by mappers.
 *  2. A local open-contracts registry (data/contractors.json) shaped like the
 *     public works disclosure published by Indian ULBs / eProcurement portals:
 *     licence number, agency, work order, ward, value, dates and the defect
 *     liability period (DLP).
 *
 * If an issue falls inside a contractor's ward, matches their scope of work and
 * lands inside the defect liability period, CivicPulse marks them accountable
 * and attaches that finding to the issue's audit trail.
 */
import config from '../config.js';
import db from '../db.js';
import { haversine } from './geo.js';
import { categoryMeta } from './ai/taxonomy.js';

const osmCache = new Map();

/* ------------------------------------------------------- OpenStreetMap feed */

export async function queryOsmWorks(point, radiusM = 400) {
  if (!config.geo.osmContractors || !point) return [];
  const k = `${point.lat.toFixed(3)},${point.lng.toFixed(3)},${radiusM}`;
  if (osmCache.has(k)) return osmCache.get(k);

  const q = `[out:json][timeout:12];
(
  node(around:${radiusM},${point.lat},${point.lng})["construction"];
  way(around:${radiusM},${point.lat},${point.lng})["construction"];
  way(around:${radiusM},${point.lat},${point.lng})["highway"="construction"];
  way(around:${radiusM},${point.lat},${point.lng})["building"="construction"];
  node(around:${radiusM},${point.lat},${point.lng})["office"="construction_company"];
  way(around:${radiusM},${point.lat},${point.lng})["landuse"="construction"];
);
out tags center 25;`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 13000);
    const res = await fetch(config.geo.overpass, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.geo.userAgent },
      body: `data=${encodeURIComponent(q)}`,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const j = await res.json();

    const out = (j.elements || []).map((el) => {
      const t = el.tags || {};
      const loc = el.center || (el.lat ? { lat: el.lat, lon: el.lon } : null);
      return {
        source: 'OpenStreetMap',
        osmId: `${el.type}/${el.id}`,
        name: t.name || t.operator || t['construction:operator'] || t.contractor || 'Unnamed works',
        operator: t.operator || t.contractor || t['construction:operator'] || null,
        work: t.construction || t.highway || t.building || t.landuse || null,
        startDate: t['start_date'] || null,
        website: t.website || null,
        location: loc ? { lat: loc.lat, lng: loc.lon ?? loc.lng } : null,
        distanceM: loc ? Math.round(haversine(point, { lat: loc.lat, lng: loc.lon ?? loc.lng })) : null,
        link: `https://www.openstreetmap.org/${el.type}/${el.id}`
      };
    })
      .filter((x) => x.operator || x.work)
      .sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9))
      .slice(0, 10);

    osmCache.set(k, out);
    return out;
  } catch {
    osmCache.set(k, []);
    return [];
  }
}

/* --------------------------------------------------- local open-data registry */

function scopeMatches(contractor, category) {
  const scopes = categoryMeta(category).contractorWork || [];
  const hay = `${contractor.workType} ${contractor.workDescription}`.toLowerCase();
  return scopes.some((s) => hay.includes(s));
}

function withinDlp(contractor, when = new Date()) {
  if (!contractor.defectLiabilityUntil) return false;
  return new Date(contractor.defectLiabilityUntil).getTime() >= when.getTime();
}

export function searchRegistry({ point, ward, category, radiusM = 1200 }) {
  const all = db.contractors.all();
  return all
    .map((c) => {
      const distance = c.location && point ? haversine(point, c.location) : null;
      const wardMatch = ward && c.ward
        ? String(c.ward).toUpperCase() === String(ward).toUpperCase() || c.wardAliases?.some((a) => String(a).toUpperCase() === String(ward).toUpperCase())
        : false;
      const geoMatch = distance !== null && distance <= (c.workRadiusM || radiusM);
      const scope = category ? scopeMatches(c, category) : false;
      const dlp = withinDlp(c);

      let score = 0;
      if (geoMatch) score += 0.4;
      if (wardMatch) score += 0.25;
      if (scope) score += 0.25;
      if (dlp) score += 0.1;

      return {
        ...c,
        distanceM: distance === null ? null : Math.round(distance),
        match: { geoMatch, wardMatch, scope, withinDlp: dlp },
        score: +score.toFixed(2)
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/* --------------------------------------------------------- accountability */

/**
 * Registry-only accountability. Runs synchronously with no network access, so
 * the citizen sees who is responsible in the same response as the AI verdict.
 */
export function accountableFromRegistry({ point, ward, category }) {
  const registry = searchRegistry({ point, ward, category });
  const candidate = registry.find((c) => c.match.scope && (c.match.geoMatch || c.match.wardMatch));
  const reasoning = [];
  let accountable = null;

  if (candidate) {
    reasoning.push(`Matched open-contract record ${candidate.workOrderNo} (${candidate.agency}).`);
    if (candidate.match.geoMatch) reasoning.push(`Issue is ${candidate.distanceM} m from the recorded work site, inside the ${candidate.workRadiusM} m contract zone.`);
    if (candidate.match.wardMatch) reasoning.push(`Ward ${candidate.ward} is inside this contractor's jurisdiction.`);
    reasoning.push(`Scope of work "${candidate.workType}" covers this issue category.`);
    if (candidate.match.withinDlp) {
      reasoning.push(`Defect Liability Period is active until ${candidate.defectLiabilityUntil} - rectification is at contractor cost.`);
    } else {
      reasoning.push(`Defect Liability Period expired on ${candidate.defectLiabilityUntil || 'unknown date'} - contractor is informational only, cost falls on the department.`);
    }
    if (candidate.blacklisted) reasoning.push(`This contractor is currently blacklisted: ${candidate.blacklistReason || 'repeat defects'}.`);

    accountable = {
      contractorId: candidate.id,
      name: candidate.name,
      agency: candidate.agency,
      licenceNo: candidate.licenceNo,
      workOrderNo: candidate.workOrderNo,
      contact: candidate.contact,
      liable: candidate.match.withinDlp,
      confidence: candidate.score,
      source: candidate.source
    };
  }

  return { accountable, reasoning, registry: registry.slice(0, 6) };
}

/** Registry match first, then OpenStreetMap works as a live fallback. */
export async function findAccountable({ point, ward, category }) {
  const base = accountableFromRegistry({ point, ward, category });
  const osm = await queryOsmWorks(point, 500);

  if (!base.accountable) {
    if (osm.length && osm[0].operator) {
      base.reasoning.push(`No contract record matched, but OpenStreetMap records active works by "${osm[0].operator}" ${osm[0].distanceM} m away (${osm[0].osmId}).`);
      base.accountable = {
        contractorId: null,
        name: osm[0].operator,
        agency: 'Unregistered / OSM-sourced',
        licenceNo: null,
        workOrderNo: null,
        contact: osm[0].website,
        liable: false,
        confidence: 0.35,
        source: 'OpenStreetMap'
      };
    } else {
      base.reasoning.push('No contractor works found in open datasets near this location. Responsibility stays with the assigned department.');
    }
  } else if (osm.length) {
    base.reasoning.push(`OpenStreetMap also shows ${osm.length} recorded work site(s) within 500 m.`);
  }

  return { ...base, osm };
}

export default { findAccountable, accountableFromRegistry, queryOsmWorks, searchRegistry };
