/**
 * CivicPulse static build - the whole platform running in the browser.
 *
 * GitHub Pages can only serve files, so this build replaces the Express server
 * with an equivalent in-page engine:
 *
 *   Express routes   -> the functions below
 *   JSON file store  -> localStorage
 *   Socket.IO        -> BroadcastChannel (live across browser tabs)
 *   Node CivicVision -> canvas CivicVision (vision.js, same maths)
 *   Nominatim/Overpass -> called directly from the browser (both allow CORS)
 *
 * The classification taxonomy and NLP layer are the SAME source files the
 * Node backend uses, so the AI behaviour matches the full-stack build.
 */
import { DEPARTMENTS, CATEGORIES, categoryMeta, SEVERITY_LABELS } from './taxonomy.js';
import { classifyText, urgencyScore } from './nlp.js';
import { analyseImages, loadImage, sampleImage, describe, perceptualHash, phashDistance } from './vision.js';
import { clipClassify, categoryScore, loadModel, modelState, onModelProgress } from './clip.js';
import { resolveAddress, ocrState, onOcrProgress } from './address.js';

export { ocrState, onOcrProgress };

export { loadModel as warmupVision, modelState, onModelProgress };

export const CONFIG = {
  minPhotos: 1,
  maxPhotos: 4,
  duplicateRadiusM: 70,
  confidenceThreshold: 0.55,
  minAngleDistance: 6,
  reverseGeocode: true,
  overpass: true
};

/* ------------------------------------------------------------------ store */

const KEY = 'civicpulse.v1';
const bus = 'BroadcastChannel' in window ? new BroadcastChannel('civicpulse') : null;
const listeners = new Set();

const blank = () => ({ users: [], departments: [], contractors: [], issues: [], evidence: [], alerts: [], audit: [], notifications: [], session: null });

let cache = null;

function read() {
  if (cache) return cache;
  try { cache = { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { cache = blank(); }
  return cache;
}

function write(silent = false) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (err) {
    // Photos are the only heavy payload - drop the oldest issue's images first.
    pruneOldestPhotos();
    try { localStorage.setItem(KEY, JSON.stringify(cache)); }
    catch { throw new Error('Browser storage is full. Use "Reset demo data" to clear it.'); }
  }
  if (!silent) emit('changed');
}

function pruneOldestPhotos() {
  const withPhotos = cache.evidence.filter((e) => e.url && e.url.startsWith('data:'));
  for (const e of withPhotos.slice(0, Math.ceil(withPhotos.length / 3))) e.url = '';
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit(event, payload) {
  for (const fn of listeners) { try { fn(event, payload); } catch { /* listener error */ } }
  if (bus) bus.postMessage({ event, payload });
}

if (bus) {
  bus.onmessage = (m) => {
    cache = null; // another tab wrote - reload from storage
    read();
    for (const fn of listeners) { try { fn(m.data.event, m.data.payload); } catch { /* ignore */ } }
  };
}

const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
const now = () => new Date().toISOString();

export const db = {
  get state() { return read(); },
  find(coll, q = {}) { return read()[coll].filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)); },
  byId(coll, id) { return read()[coll].find((r) => r.id === id) || null; },
  insert(coll, doc) {
    const row = { id: doc.id || uid(coll.slice(0, 3)), createdAt: now(), ...doc };
    read()[coll].push(row);
    return row;
  },
  update(coll, id, patch) {
    const rows = read()[coll];
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) return null;
    rows[i] = { ...rows[i], ...patch, updatedAt: now() };
    return rows[i];
  },
  save: write
};

/* ------------------------------------------------------------------- seed */

const CONTRACTORS = [
  { id: 'con_srinivasa', name: 'Srinivasa Infra Works Pvt Ltd', agency: 'BBMP Road Infrastructure Wing', licenceNo: 'KA/CL-I/2019/04412', workOrderNo: 'BBMP/RD/2025-26/0871', workType: 'Road asphalt resurfacing', workDescription: 'Asphalting and road resurfacing of ward arterial roads including kerb and footpath restoration', ward: 'KORAMANGALA', wardAliases: ['KORAMANGALA-3-BLOCK', 'KORAMANGALA-5-BLOCK'], location: { lat: 12.9352, lng: 77.6245 }, workRadiusM: 1500, contractValue: 48200000, startDate: '2025-06-15', endDate: '2026-03-31', defectLiabilityUntil: '2027-03-31', contact: 'srinivasa.infra@example.in / +91-80-4111-2201', rating: 3.4, blacklisted: false, source: 'Municipal open-contracts disclosure' },
  { id: 'con_greenearth', name: 'Green Earth Sanitation Services', agency: 'BBMP Solid Waste Management', licenceNo: 'KA/SWM/2021/00981', workOrderNo: 'BBMP/SWM/2025-26/0233', workType: 'Solid waste collection and sanitation', workDescription: 'Door-to-door waste collection, black spot clearing and street cleaning for the ward', ward: 'INDIRANAGAR', wardAliases: ['INDIRA-NAGAR'], location: { lat: 12.9719, lng: 77.6412 }, workRadiusM: 2000, contractValue: 22750000, startDate: '2025-04-01', endDate: '2027-03-31', defectLiabilityUntil: '2027-09-30', contact: 'ops@greenearth.example.in', rating: 4.1, blacklisted: false, source: 'Municipal open-contracts disclosure' },
  { id: 'con_aquapipe', name: 'AquaPipe Engineering Co.', agency: 'BWSSB Pipeline Division', licenceNo: 'KA/WS/2020/07734', workOrderNo: 'BWSSB/PL/2025-26/0119', workType: 'Water pipeline and sewerage laying', workDescription: 'Laying of 300mm water pipeline, sewer line rehabilitation and manhole chamber construction', ward: 'JAYANAGAR', wardAliases: ['JAYANAGAR-4-BLOCK'], location: { lat: 12.9250, lng: 77.5938 }, workRadiusM: 1800, contractValue: 91500000, startDate: '2024-11-01', endDate: '2026-06-30', defectLiabilityUntil: '2028-06-30', contact: 'projects@aquapipe.example.in', rating: 2.8, blacklisted: false, source: 'State eProcurement portal' },
  { id: 'con_voltline', name: 'VoltLine Electricals', agency: 'BESCOM Street Lighting Cell', licenceNo: 'KA/EL/2022/03310', workOrderNo: 'BESCOM/SL/2025-26/0442', workType: 'Street lighting electrical maintenance', workDescription: 'LED street light installation, pole erection and electrical fault maintenance', ward: 'HSR-LAYOUT', wardAliases: ['HSR'], location: { lat: 12.9116, lng: 77.6389 }, workRadiusM: 2500, contractValue: 15600000, startDate: '2025-08-01', endDate: '2026-07-31', defectLiabilityUntil: '2027-07-31', contact: 'support@voltline.example.in', rating: 3.9, blacklisted: false, source: 'Municipal open-contracts disclosure' },
  { id: 'con_shakti', name: 'Shakti Constructions', agency: 'BBMP Civil Works', licenceNo: 'KA/CL-II/2018/01187', workOrderNo: 'BBMP/CW/2024-25/0655', workType: 'Civil construction, footpath and drain', workDescription: 'Storm water drain construction, footpath paver work and civil restoration', ward: 'WHITEFIELD', wardAliases: [], location: { lat: 12.9698, lng: 77.7500 }, workRadiusM: 3000, contractValue: 63400000, startDate: '2024-02-01', endDate: '2025-08-31', defectLiabilityUntil: '2026-08-31', contact: 'admin@shakticon.example.in', rating: 2.2, blacklisted: true, blacklistReason: 'Repeated DLP defect notices - 11 recurring potholes on completed stretches', source: 'Municipal open-contracts disclosure' },
  { id: 'con_urbanleaf', name: 'UrbanLeaf Horticulture LLP', agency: 'BBMP Horticulture Wing', licenceNo: 'KA/HT/2023/00520', workOrderNo: 'BBMP/HT/2025-26/0087', workType: 'Horticulture, tree maintenance and landscaping', workDescription: 'Tree trimming, park maintenance, avenue plantation and green waste clearance', ward: 'KORAMANGALA', wardAliases: ['EJIPURA'], location: { lat: 12.9310, lng: 77.6280 }, workRadiusM: 2200, contractValue: 8900000, startDate: '2025-05-01', endDate: '2027-04-30', defectLiabilityUntil: '2027-10-31', contact: 'care@urbanleaf.example.in', rating: 4.4, blacklisted: false, source: 'Municipal open-contracts disclosure' }
];

export const DEMO_ACCOUNTS = [
  { name: 'Ananya Rao', email: 'citizen@demo.in', password: 'Citizen@123', role: 'citizen' },
  { name: 'Rahul Verma', email: 'citizen2@demo.in', password: 'Citizen@123', role: 'citizen' },
  { name: 'Suresh Kumar', email: 'worker.roads@city.gov.in', password: 'Worker@123', role: 'worker', departmentId: 'dept_roads', employeeId: 'BBMP-RD-4471' },
  { name: 'Lakshmi Devi', email: 'worker.sanit@city.gov.in', password: 'Worker@123', role: 'worker', departmentId: 'dept_sanit', employeeId: 'BBMP-SW-2210' },
  { name: 'Imran Shaikh', email: 'worker.water@city.gov.in', password: 'Worker@123', role: 'worker', departmentId: 'dept_water', employeeId: 'BWSSB-9013' },
  { name: 'Deepak Nair', email: 'worker.power@city.gov.in', password: 'Worker@123', role: 'worker', departmentId: 'dept_power', employeeId: 'BESCOM-3388' },
  { name: 'Meera Iyer', email: 'supervisor.roads@city.gov.in', password: 'Super@123', role: 'supervisor', departmentId: 'dept_roads', employeeId: 'BBMP-EE-102' },
  { name: 'Vikram Singh', email: 'supervisor.sanit@city.gov.in', password: 'Super@123', role: 'supervisor', departmentId: 'dept_sanit', employeeId: 'BBMP-EE-118' },
  { name: 'Control Room', email: 'admin@city.gov.in', password: 'Admin@123', role: 'admin' }
];

export function ensureSeed() {
  const s = read();
  if (!s.departments.length) s.departments = DEPARTMENTS.map((d) => ({ ...d, active: true }));
  if (!s.contractors.length) s.contractors = CONTRACTORS.map((c) => ({ ...c, createdAt: now() }));
  if (!s.users.length) {
    s.users = DEMO_ACCOUNTS.map((a) => ({
      id: uid('usr'), createdAt: now(), ...a,
      trustScore: a.role === 'citizen' ? 0.7 : 1, reportsFiled: 0, verifiedReports: 0, isDemo: true
    }));
  }
  write(true);
}

export function resetDemo() {
  localStorage.removeItem(KEY);
  cache = null;
  ensureSeed();
  emit('changed');
}

/* ------------------------------------------------------------------- auth */

export function register({ name, email, password, phone }) {
  if (!name || name.trim().length < 2) throw new Error('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw new Error('Please enter a valid email address.');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
  if (read().users.some((u) => u.email === email.toLowerCase())) throw new Error('An account with this email already exists.');

  const user = db.insert('users', {
    name: name.trim(), email: email.toLowerCase(), phone: phone || null, password,
    role: 'citizen', trustScore: 0.6, reportsFiled: 0, verifiedReports: 0
  });
  read().session = user.id;
  write();
  return user;
}

export function login(email, password) {
  const user = read().users.find((u) => u.email === String(email || '').toLowerCase());
  if (!user || user.password !== password) throw new Error('Incorrect email or password.');
  read().session = user.id;
  write();
  return user;
}

export function logout() { read().session = null; write(); }
export function currentUser() { const s = read(); return s.session ? db.byId('users', s.session) : null; }

/* -------------------------------------------------------------------- geo */

const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
export function haversine(a, b) {
  if (!a || !b) return Infinity;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const gridCell = ({ lat, lng }) => `GRID-${Math.floor(lat * 100)}-${Math.floor(lng * 100)}`;

const geoCache = new Map();
export async function reverseGeocode(p) {
  const k = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  if (geoCache.has(k)) return geoCache.get(k);
  const fallback = {
    address: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
    ward: gridCell(p), wardName: `Grid Sector ${gridCell(p).slice(5)}`, source: 'offline-grid'
  };
  if (!CONFIG.reverseGeocode) return fallback;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lng}&zoom=17&addressdetails=1`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json();
    const a = j.address || {};
    const wardName = a.suburb || a.neighbourhood || a.city_district || a.town || a.village || null;
    const out = {
      address: j.display_name || fallback.address,
      ward: wardName ? wardName.toUpperCase().replace(/\s+/g, '-') : gridCell(p),
      wardName: wardName || fallback.wardName,
      city: a.city || a.town || null, state: a.state || null, addressDetail: a, source: 'nominatim'
    };
    geoCache.set(k, out);
    return out;
  } catch { return fallback; }
}

export function hotspots(issues, min = 2) {
  const buckets = new Map();
  for (const i of issues) {
    if (!i.location) continue;
    const cell = gridCell(i.location);
    if (!buckets.has(cell)) buckets.set(cell, { cell, count: 0, lat: 0, lng: 0, categories: {} });
    const b = buckets.get(cell);
    b.count++; b.lat += i.location.lat; b.lng += i.location.lng;
    b.categories[i.category] = (b.categories[i.category] || 0) + 1;
  }
  return [...buckets.values()].filter((b) => b.count >= min).map((b) => ({
    ...b, lat: b.lat / b.count, lng: b.lng / b.count,
    dominant: Object.entries(b.categories).sort((x, y) => y[1] - x[1])[0]?.[0] || null
  })).sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------ contractors */

function scopeMatches(c, category) {
  const scopes = categoryMeta(category).contractorWork || [];
  const hay = `${c.workType} ${c.workDescription}`.toLowerCase();
  return scopes.some((s) => hay.includes(s));
}

export function searchRegistry({ point, ward, category }) {
  return read().contractors.map((c) => {
    const distance = point && c.location ? haversine(point, c.location) : null;
    const wardMatch = !!(ward && c.ward && (String(c.ward).toUpperCase() === String(ward).toUpperCase()
      || (c.wardAliases || []).some((a) => a.toUpperCase() === String(ward).toUpperCase())));
    const geoMatch = distance !== null && distance <= (c.workRadiusM || 1200);
    const scope = category ? scopeMatches(c, category) : false;
    const dlp = c.defectLiabilityUntil ? new Date(c.defectLiabilityUntil) >= new Date() : false;
    let score = 0;
    if (geoMatch) score += 0.4; if (wardMatch) score += 0.25; if (scope) score += 0.25; if (dlp) score += 0.1;
    return { ...c, distanceM: distance === null ? null : Math.round(distance), match: { geoMatch, wardMatch, scope, withinDlp: dlp }, score: +score.toFixed(2) };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
}

export function accountableFromRegistry({ point, ward, category }) {
  const registry = searchRegistry({ point, ward, category });
  const c = registry.find((x) => x.match.scope && (x.match.geoMatch || x.match.wardMatch));
  const reasoning = [];
  if (!c) return { accountable: null, reasoning, registry };

  reasoning.push(`Matched open-contract record ${c.workOrderNo} (${c.agency}).`);
  if (c.match.geoMatch) reasoning.push(`Issue is ${c.distanceM} m from the recorded work site, inside the ${c.workRadiusM} m contract zone.`);
  if (c.match.wardMatch) reasoning.push(`Ward ${c.ward} is inside this contractor's jurisdiction.`);
  reasoning.push(`Scope of work "${c.workType}" covers this issue category.`);
  reasoning.push(c.match.withinDlp
    ? `Defect Liability Period is active until ${c.defectLiabilityUntil} - rectification is at contractor cost.`
    : `Defect Liability Period expired on ${c.defectLiabilityUntil} - contractor is informational only.`);
  if (c.blacklisted) reasoning.push(`This contractor is currently blacklisted: ${c.blacklistReason}.`);

  return {
    accountable: {
      contractorId: c.id, name: c.name, agency: c.agency, licenceNo: c.licenceNo,
      workOrderNo: c.workOrderNo, contact: c.contact, liable: c.match.withinDlp,
      confidence: c.score, source: c.source
    },
    reasoning, registry
  };
}

/** Live OpenStreetMap works lookup - Overpass allows browser CORS. */
export async function queryOsmWorks(point, radiusM = 500) {
  if (!CONFIG.overpass || !point) return [];
  const q = `[out:json][timeout:12];(node(around:${radiusM},${point.lat},${point.lng})["construction"];way(around:${radiusM},${point.lat},${point.lng})["construction"];way(around:${radiusM},${point.lat},${point.lng})["highway"="construction"];way(around:${radiusM},${point.lat},${point.lng})["landuse"="construction"];);out tags center 20;`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: `data=${encodeURIComponent(q)}`, signal: ctl.signal
    });
    clearTimeout(t);
    const j = await res.json();
    return (j.elements || []).map((el) => {
      const tg = el.tags || {};
      const loc = el.center || (el.lat ? { lat: el.lat, lng: el.lon } : null);
      return {
        osmId: `${el.type}/${el.id}`,
        name: tg.name || tg.operator || 'Unnamed works',
        operator: tg.operator || tg.contractor || tg['construction:operator'] || null,
        work: tg.construction || tg.highway || tg.landuse || null,
        distanceM: loc ? Math.round(haversine(point, loc)) : null,
        link: `https://www.openstreetmap.org/${el.type}/${el.id}`
      };
    }).filter((x) => x.operator || x.work).sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9)).slice(0, 8);
  } catch { return []; }
}

/* ------------------------------------------------------------- AI verdict */

function fuse(signals) {
  const combined = {};
  for (const { ranked, weight } of signals) {
    if (!ranked || !weight) continue;
    for (const r of ranked) combined[r.category] = (combined[r.category] || 0) + (r.probability ?? r.score ?? 0) * weight;
  }
  const total = Object.values(combined).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(combined)
    .map(([category, s]) => ({ category, score: +(s / total).toFixed(4) }))
    .sort((a, b) => b.score - a.score);
}

function severityModel({ category, features, urgency, duplicateCount }) {
  let sev = categoryMeta(category).baseSeverity;
  if (category === 'POTHOLE' && features.darkPatchRatio > 0.45) sev += 1;
  if (category === 'MANHOLE' && features.darkPatchRatio > 0.35) sev += 1;
  if (category === 'GARBAGE' && features.textureChaos > 0.7) sev += 1;
  if (category === 'STREETLIGHT' && features.nightRatio > 0.5) sev += 1;
  if ((category === 'SEWAGE' || category === 'STAGNANT_WATER') && features.specularRatio > 0.4) sev += 1;
  if (urgency.score >= 0.6) sev += 1;
  if (duplicateCount >= 3) sev += 1;
  return Math.max(1, Math.min(5, Math.round(sev)));
}

function narrate(category, f, severity, angles, clip) {
  const meta = categoryMeta(category);
  if (clip) {
    const pct = Math.round((clip.ranked[0]?.probability || 0) * 100);
    return `The vision model recognised ${meta.label.toLowerCase()} in ${angles} photo angle${angles > 1 ? 's' : ''} (${pct}% match against the civic issue prompt set). Assessed severity: ${SEVERITY_LABELS[severity]}.`;
  }
  const cues = [];
  if (f.darkPatchRatio > 0.3) cues.push('a distinct dark cavity in the surface');
  if (f.asphaltRatio > 0.4) cues.push('road/asphalt surroundings');
  if (f.textureChaos > 0.6) cues.push('scattered heterogeneous material');
  if (f.greenRatio > 0.45) cues.push('heavy vegetation coverage');
  if (f.specularRatio > 0.35) cues.push('standing/reflective water');
  if (f.verticalStructure > 0.4) cues.push('a tall vertical pole structure');
  const detail = cues.length ? cues.slice(0, 3).join(', ') : 'the dominant colour and texture profile';
  return `Detected ${meta.label.toLowerCase()} across ${angles} photo angle${angles > 1 ? 's' : ''} from ${detail}. Assessed severity: ${SEVERITY_LABELS[severity]}.`;
}

export async function analyseIssue(sources, description = '', context = {}) {
  const started = performance.now();

  const vision = await analyseImages(sources);                 // colour engine: severity cues + hashes
  const text = classifyText(description);
  const urgency = urgencyScore(description);
  const clip = await clipClassify(sources).catch(() => null);  // primary signal

  const signals = [];
  if (clip) {
    signals.push({ ranked: clip.ranked, weight: 0.62 });
    signals.push({ ranked: vision.ranked, weight: 0.10 });
  } else {
    signals.push({ ranked: vision.ranked, weight: 0.62 });
  }
  if (text.hasSignal) signals.push({ ranked: text.ranked, weight: clip ? 0.26 : 0.38 });

  const fused = fuse(signals);
  const category = fused[0].category;
  const meta = categoryMeta(category);

  const margin = fused[0].score - (fused[1]?.score ?? 0);
  const textAgrees = text.hasSignal && text.ranked[0]?.category === category;
  const clipAgrees = clip && clip.ranked[0]?.category === category;

  let confidence = Math.max(0.05, Math.min(0.99,
    fused[0].score * 0.55 + margin * 1.2 +
    (clip ? clip.agreement : vision.agreement) * 0.15 +
    (textAgrees ? 0.10 : 0) + (clipAgrees ? 0.15 : 0)));

  const looksNonCivic = clip ? clip.nonCivic > 0.5 : false;
  if (looksNonCivic) confidence *= 0.6;

  const severity = severityModel({ category, features: vision.features, urgency, duplicateCount: context.duplicateCount || 0 });

  return {
    engine: clip ? 'CLIP zero-shot vision model + text NLP' : 'CivicVision colour engine (CLIP unavailable)',
    provider: clip ? 'clip-local' : 'onboard',
    model: clip?.model || 'civicvision-v1',
    category, categoryLabel: meta.label, icon: meta.icon,
    confidence: +confidence.toFixed(3),
    severity, severityLabel: SEVERITY_LABELS[severity],
    departmentId: meta.department, slaHours: meta.slaHours,
    summary: narrate(category, vision.features, severity, vision.angles, clip),
    evidence: vision.ranked.find((r) => r.category === category)?.evidence || [],
    visionModel: clip ? {
      name: clip.model,
      topMatches: clip.ranked.slice(0, 4).map((r) => ({ category: r.category, label: categoryMeta(r.category).label, probability: r.probability })),
      civicScore: +(1 - clip.nonCivic).toFixed(3),
      agreement: clip.agreement, ms: clip.ms
    } : null,
    alternates: fused.slice(1, 4).map((f) => ({ category: f.category, label: categoryMeta(f.category).label, score: f.score })),
    textSignal: { matched: text.ranked[0]?.matched || [], agrees: textAgrees, strength: +text.strength.toFixed(2) },
    urgencyCues: urgency.cues,
    angles: vision.angles, agreement: clip?.agreement ?? vision.agreement,
    features: vision.features, hashes: vision.hashes,
    looksNonCivic,
    needsHumanReview: confidence < CONFIG.confidenceThreshold || looksNonCivic,
    processingMs: Math.round(performance.now() - started)
  };
}

export function angleDiversity(hashes) {
  if (hashes.length < 2) return { distinct: hashes.length, minDistance: null, ok: true, note: 'Single angle submitted.' };
  let min = Infinity;
  for (let i = 0; i < hashes.length; i++) for (let j = i + 1; j < hashes.length; j++) min = Math.min(min, phashDistance(hashes[i], hashes[j]));
  const ok = min >= CONFIG.minAngleDistance;
  return {
    distinct: hashes.length, minDistance: min, ok,
    note: ok ? `${hashes.length} genuinely distinct viewpoints (min perceptual distance ${min}).`
             : `Photos look near-identical (distance ${min}). Capture the issue from a different angle.`
  };
}

export async function verifyResolution({ beforeSources, afterSources, category }) {
  const load = async (src) => {
    const s = sampleImage(await loadImage(src));
    return { features: describe(s), hashes: perceptualHash(s) };
  };
  const before = await Promise.all(beforeSources.map(load));
  const after = await Promise.all(afterSources.map(load));
  const mean = (arr, k) => arr.reduce((a, x) => a + x.features[k], 0) / arr.length;

  let minCross = Infinity;
  for (const a of after) for (const b of before) minCross = Math.min(minCross, phashDistance(a.hashes, b.hashes));
  const recycled = minCross <= 5;
  const diversity = angleDiversity(after.map((a) => a.hashes));

  const metrics = [];
  let defectGone = null;
  const push = (label, b, a, betterWhen) => {
    const delta = a - b;
    const improved = betterWhen === 'lower' ? delta < -0.04 : delta > 0.04;
    metrics.push({ label, before: +b.toFixed(3), after: +a.toFixed(3), delta: +delta.toFixed(3), improved });
    return improved;
  };
  let checks = 0, improvements = 0;
  const track = (ok) => { checks++; if (ok) improvements++; };

  // strongest signal: has the defect stopped being recognisable to the model?
  try {
    const bs = (await Promise.all(beforeSources.slice(0, 2).map((x) => categoryScore(x, category)))).filter((n) => typeof n === 'number');
    const as = (await Promise.all(afterSources.slice(0, 2).map((x) => categoryScore(x, category)))).filter((n) => typeof n === 'number');
    if (bs.length && as.length) {
      const b = bs.reduce((x, y) => x + y, 0) / bs.length;
      const a = as.reduce((x, y) => x + y, 0) / as.length;
      defectGone = { before: +b.toFixed(3), after: +a.toFixed(3), drop: +(b - a).toFixed(3) };
      const improved = a < b * 0.6;
      metrics.push({ label: `Vision model still sees "${categoryMeta(category).label}"`, before: defectGone.before, after: defectGone.after, delta: -defectGone.drop, improved });
      track(improved); track(improved);
    }
  } catch { /* model unavailable */ }

  switch (category) {
    case 'POTHOLE': case 'MANHOLE': case 'FOOTPATH':
      track(push('Dark cavity area', mean(before, 'darkPatchRatio'), mean(after, 'darkPatchRatio'), 'lower'));
      track(push('Surface uniformity', mean(before, 'flatSurface'), mean(after, 'flatSurface'), 'higher'));
      break;
    case 'GARBAGE': case 'DEBRIS':
      track(push('Scattered clutter', mean(before, 'textureChaos'), mean(after, 'textureChaos'), 'lower'));
      track(push('Colour dispersion', mean(before, 'colourVariance'), mean(after, 'colourVariance'), 'lower'));
      break;
    case 'SEWAGE': case 'STAGNANT_WATER': case 'WATER_LEAK':
      track(push('Standing water / reflection', mean(before, 'specularRatio'), mean(after, 'specularRatio'), 'lower'));
      track(push('Sludge tones', mean(before, 'brownRatio'), mean(after, 'brownRatio'), 'lower'));
      break;
    case 'STREETLIGHT':
      track(push('Scene illumination', mean(before, 'brightness'), mean(after, 'brightness'), 'higher'));
      break;
    case 'FALLEN_TREE':
      track(push('Vegetation obstruction', mean(before, 'greenRatio'), mean(after, 'greenRatio'), 'lower'));
      track(push('Clutter', mean(before, 'textureChaos'), mean(after, 'textureChaos'), 'lower'));
      break;
    default:
      track(push('Scene clutter', mean(before, 'textureChaos'), mean(after, 'textureChaos'), 'lower'));
      track(push('Surface uniformity', mean(before, 'flatSurface'), mean(after, 'flatSurface'), 'higher'));
  }

  const improvementScore = checks ? improvements / checks : 0;
  const notes = [];
  if (recycled) notes.push('REJECTED: an "after" photo is a near-duplicate of the original evidence (recycled evidence).');
  if (!diversity.ok) notes.push(`WARNING: ${diversity.note}`);
  if (defectGone && defectGone.after >= defectGone.before * 0.6) notes.push('The vision model still recognises the original defect in the "after" photos.');
  if (improvementScore === 0) notes.push('No measurable visual improvement detected between before and after evidence.');
  if (improvementScore >= 0.5 && !recycled) notes.push('Measurable visual improvement confirmed by CivicVision.');

  return {
    verified: !recycled && improvementScore >= 0.5,
    recycledEvidence: recycled, crossDistance: minCross,
    improvementScore: +improvementScore.toFixed(2), defectGone, angleDiversity: diversity, metrics, notes,
    afterHashes: after.map((a) => a.hashes)
  };
}

/* ------------------------------------------------------- alerts and audit */

export function raiseAlert({ issueId, departmentId, level = 'info', title, message, meta = {} }) {
  const a = db.insert('alerts', { issueId, departmentId, level, title, message, meta, read: false });
  return a;
}
export function audit(issueId, actor, action, detail = {}) {
  return db.insert('audit', {
    issueId, actorId: actor?.id || null, actorName: actor?.name || 'System',
    actorRole: actor?.role || 'system', action, detail
  });
}
export function notifyUser(userId, n) { return db.insert('notifications', { userId, read: false, level: 'info', ...n }); }

/* ---------------------------------------------------------- issue helpers */

const OPEN = ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'];
export { OPEN as OPEN_STATUSES };

export function decorate(issue) {
  if (!issue) return null;
  const dept = db.byId('departments', issue.departmentId);
  const ev = db.find('evidence', { issueId: issue.id });
  const ageH = (Date.now() - new Date(issue.createdAt).getTime()) / 36e5;
  return {
    ...issue,
    priorityScore: Math.round(issue.severity * 20 + Math.min(30, (issue.reportCount || 1) * 6) + Math.min(20, ageH / 6) + (issue.escalated ? 15 : 0)),
    department: dept || null,
    evidence: {
      report: ev.filter((e) => e.kind === 'report'),
      before: ev.filter((e) => e.kind === 'before'),
      after: ev.filter((e) => e.kind === 'after')
    },
    overdue: issue.dueAt ? new Date(issue.dueAt) < new Date() && OPEN.includes(issue.status) : false
  };
}

export const listIssues = () => read().issues.map(decorate)
  .sort((a, b) => b.priorityScore - a.priorityScore || new Date(b.createdAt) - new Date(a.createdAt));

function nextCode() {
  return `CP-${new Date().getFullYear()}-${String(read().issues.length + 1).padStart(4, '0')}`;
}

function saveEvidence(issueId, sources, kind, uploaderId, hashes = [], exifs = []) {
  return sources.map((src, i) => db.insert('evidence', {
    issueId, kind, angle: i + 1, url: src, uploadedBy: uploaderId,
    hashes: hashes[i] || null, exif: exifs[i] || null
  }));
}

/* ------------------------------------------------------ the report pipeline */

export async function reportIssue({ sources, exifs = [], description = '', landmark = '', location }) {
  const user = currentUser();
  if (!user) throw new Error('Please sign in first.');
  if (!sources.length) throw new Error('Please attach at least 1 photo of the issue.');
  if (sources.length > CONFIG.maxPhotos) throw new Error(`Maximum ${CONFIG.maxPhotos} photos per issue.`);

  const exifGps = exifs.map((e) => e?.gps).find(Boolean) || null;
  const point = exifGps || location;
  if (!point) throw new Error('Location required. Allow location access, drop a pin, or upload a photo that carries GPS.');

  const trust = exifGps && location
    ? (haversine(exifGps, location) < 250 ? 'high (photo GPS matches device GPS)' : 'medium (photo GPS differs from device GPS)')
    : exifGps ? 'high (photo carries embedded GPS)' : 'medium (device GPS only)';

  const nearbyAll = read().issues.filter((i) => OPEN.includes(i.status) && haversine(point, i.location) <= CONFIG.duplicateRadiusM);
  const ai = await analyseIssue(sources, description, { duplicateCount: nearbyAll.length });
  const place = await reverseGeocode(point);
  const diversity = angleDiversity(ai.hashes);

  // crowd intelligence: merge into a nearby cluster of the same category
  const existing = nearbyAll.filter((i) => i.category === ai.category)
    .sort((a, b) => haversine(point, a.location) - haversine(point, b.location))[0];

  if (existing) {
    const already = existing.reporterId === user.id || (existing.corroborators || []).includes(user.id);
    if (!already) {
      const reportCount = (existing.reportCount || 1) + 1;
      const severity = Math.min(5, existing.severity + (reportCount % 3 === 0 ? 1 : 0));
      db.update('issues', existing.id, {
        reportCount, severity, severityLabel: SEVERITY_LABELS[severity],
        corroborators: [...(existing.corroborators || []), user.id], lastCorroboratedAt: now()
      });
      saveEvidence(existing.id, sources, 'report', user.id, ai.hashes, exifs);
      audit(existing.id, user, 'CORROBORATED', { reportCount });
      raiseAlert({
        issueId: existing.id, departmentId: existing.departmentId, level: reportCount >= 3 ? 'warning' : 'info',
        title: `${reportCount} citizens now reporting ${categoryMeta(existing.category).label}`,
        message: `${existing.code} at ${existing.wardName} has been confirmed by ${reportCount} independent reports. Priority raised.`
      });
      db.update('users', user.id, { reportsFiled: (user.reportsFiled || 0) + 1 });
      write();
    }
    return {
      duplicate: true, ai,
      message: `We matched your report to an existing issue ${Math.round(haversine(point, existing.location))} m away. Your photos strengthen it.`,
      issue: decorate(db.byId('issues', existing.id))
    };
  }

  const meta = categoryMeta(ai.category);

  // AI address: read signage out of the photo, then geocode it against OSM
  const addressAI = await resolveAddress({ sources, point, description, place }).catch(() => null);

  const liability = accountableFromRegistry({ point, ward: place.ward, category: ai.category });

  const issue = db.insert('issues', {
    code: nextCode(), reporterId: user.id, reporterName: user.name,
    description, landmark,
    category: ai.category, categoryLabel: ai.categoryLabel, icon: ai.icon,
    severity: ai.severity, severityLabel: ai.severityLabel,
    departmentId: ai.departmentId, status: 'ROUTED',
    location: { ...point, trust },
    address: addressAI?.formatted || place.address, addressAI,
    ward: place.ward, wardName: place.wardName, geoSource: place.source,
    reportCount: 1, corroborators: [],
    slaHours: meta.slaHours, dueAt: new Date(Date.now() + meta.slaHours * 36e5).toISOString(),
    escalated: false, humanReview: ai.needsHumanReview, angleCheck: diversity,
    ai: { ...ai, hashes: undefined, classifiedAt: now() },
    contractor: liability.accountable,
    contractorReasoning: liability.reasoning,
    contractorSources: { osm: [], registry: liability.registry.slice(0, 3) },
    contractorLookup: liability.accountable ? 'registry-matched' : 'pending'
  });

  saveEvidence(issue.id, sources, 'report', user.id, ai.hashes, exifs);
  db.update('users', user.id, { reportsFiled: (user.reportsFiled || 0) + 1 });

  audit(issue.id, user, 'REPORTED', { category: ai.category, confidence: ai.confidence, photos: sources.length });
  audit(issue.id, null, 'AI_ROUTED', { department: db.byId('departments', ai.departmentId)?.name, engine: ai.engine, confidence: ai.confidence });
  if (addressAI) {
    audit(issue.id, null, 'ADDRESS_RESOLVED', {
      address: addressAI.formatted, confidence: addressAI.confidence,
      signals: addressAI.signals, ocrLines: addressAI.ocr.lines.length
    });
  }

  const dept = db.byId('departments', ai.departmentId);
  raiseAlert({
    issueId: issue.id, departmentId: ai.departmentId,
    level: ai.severity >= 4 ? 'critical' : ai.severity >= 3 ? 'warning' : 'info',
    title: `New ${ai.categoryLabel} - ${ai.severityLabel}`,
    message: `${issue.code} auto-routed to ${dept?.name} by CivicVision (confidence ${(ai.confidence * 100).toFixed(0)}%). ${ai.summary} Address: ${issue.address}. SLA ${meta.slaHours}h.`,
    meta: { category: ai.category, severity: ai.severity }
  });
  notifyUser(user.id, { issueId: issue.id, title: `${issue.code} routed to ${dept?.name}`, message: `Target resolution within ${meta.slaHours} hours.` });

  if (liability.accountable) {
    audit(issue.id, null, 'CONTRACTOR_IDENTIFIED', { name: liability.accountable.name, liable: liability.accountable.liable });
    if (liability.accountable.liable) {
      raiseAlert({
        issueId: issue.id, departmentId: ai.departmentId, level: 'warning',
        title: `Contractor liability: ${liability.accountable.name}`,
        message: `${issue.code} falls inside an active Defect Liability Period for work order ${liability.accountable.workOrderNo}. Rectification is recoverable from ${liability.accountable.name}.`
      });
    }
  }
  write();

  // Live OpenStreetMap enrichment, after the citizen already has their answer
  queryOsmWorks(point).then((osm) => {
    if (!osm.length) return;
    const cur = db.byId('issues', issue.id);
    if (!cur) return;
    const reasoning = [...(cur.contractorReasoning || []), `OpenStreetMap shows ${osm.length} recorded work site(s) within 500 m.`];
    let accountable = cur.contractor;
    if (!accountable && osm[0].operator) {
      accountable = { contractorId: null, name: osm[0].operator, agency: 'Unregistered / OSM-sourced', liable: false, confidence: 0.35, source: 'OpenStreetMap' };
      reasoning.push(`No contract record matched, but OpenStreetMap records works by "${osm[0].operator}" ${osm[0].distanceM} m away (${osm[0].osmId}).`);
    }
    db.update('issues', issue.id, { contractor: accountable, contractorReasoning: reasoning, contractorSources: { ...cur.contractorSources, osm }, contractorLookup: 'done' });
    write();
  });

  return { duplicate: false, ai, issue: decorate(issue) };
}

/* -------------------------------------------------------------- workflow */

function requireDept(issue) {
  const u = currentUser();
  if (!u) throw new Error('Sign in first.');
  if (u.role === 'admin') return u;
  if (!['worker', 'supervisor'].includes(u.role)) throw new Error('Staff access required.');
  if (u.departmentId !== issue.departmentId) throw new Error('This issue belongs to another department.');
  return u;
}

export function acknowledge(id) {
  const issue = db.byId('issues', id);
  const u = requireDept(issue);
  db.update('issues', id, { status: 'ACKNOWLEDGED', acknowledgedAt: now(), acknowledgedBy: u.id });
  audit(id, u, 'ACKNOWLEDGED', { by: u.name });
  notifyUser(issue.reporterId, { issueId: id, title: `${issue.code} acknowledged`, message: `${db.byId('departments', issue.departmentId)?.name} has acknowledged your report.` });
  write();
  return decorate(db.byId('issues', id));
}

export function assign(id, workerId) {
  const issue = db.byId('issues', id);
  const u = requireDept(issue);
  if (!['supervisor', 'admin'].includes(u.role)) throw new Error('Only a supervisor can assign work.');
  const w = db.byId('users', workerId);
  if (!w) throw new Error('Select a valid field worker.');
  db.update('issues', id, { status: 'ASSIGNED', assignedTo: w.id, assignedToName: w.name, assignedAt: now() });
  audit(id, u, 'ASSIGNED', { worker: w.name });
  notifyUser(w.id, { issueId: id, title: `New field task ${issue.code}`, message: `${issue.categoryLabel} at ${issue.wardName}.` });
  write();
  return decorate(db.byId('issues', id));
}

export function startWork(id) {
  const issue = db.byId('issues', id);
  const u = requireDept(issue);
  db.update('issues', id, { status: 'IN_PROGRESS', startedAt: now(), assignedTo: issue.assignedTo || u.id, assignedToName: issue.assignedToName || u.name });
  audit(id, u, 'WORK_STARTED', { by: u.name });
  notifyUser(issue.reporterId, { issueId: id, title: `Work started on ${issue.code}`, message: 'A field team is now working on your report.' });
  write();
  return decorate(db.byId('issues', id));
}

export async function uploadBefore(id, sources) {
  const issue = db.byId('issues', id);
  const u = requireDept(issue);
  if (sources.length < 2) throw new Error('Upload at least 2 "before" photos from different angles.');
  const hashes = [];
  for (const s of sources) hashes.push(perceptualHash(sampleImage(await loadImage(s))));
  const diversity = angleDiversity(hashes);
  if (!diversity.ok) throw new Error(diversity.note);
  saveEvidence(id, sources, 'before', u.id, hashes);
  db.update('issues', id, { status: issue.status === 'RESOLVED' ? issue.status : 'IN_PROGRESS', beforeCapturedAt: now() });
  audit(id, u, 'BEFORE_EVIDENCE', { photos: sources.length, angleCheck: diversity });
  write();
  return { issue: decorate(db.byId('issues', id)), angleCheck: diversity };
}

export async function resolveIssue(id, sources, notes = '') {
  const issue = db.byId('issues', id);
  const u = requireDept(issue);
  if (sources.length < 2) throw new Error('Upload at least 2 "after" photos from different angles to close this issue.');

  const ev = db.find('evidence', { issueId: id });
  const baseline = (ev.filter((e) => e.kind === 'before').length ? ev.filter((e) => e.kind === 'before') : ev.filter((e) => e.kind === 'report'))
    .map((e) => e.url).filter(Boolean);
  if (!baseline.length) throw new Error('No baseline evidence found for this issue.');

  const verification = await verifyResolution({ beforeSources: baseline, afterSources: sources, category: issue.category });

  if (verification.recycledEvidence) {
    audit(id, u, 'CLOSURE_REJECTED', { reason: 'recycled evidence', crossDistance: verification.crossDistance });
    raiseAlert({
      issueId: id, departmentId: issue.departmentId, level: 'critical',
      title: `Fake closure attempt blocked on ${issue.code}`,
      message: `An "after" photo submitted by ${u.name} is a near-duplicate of the original evidence. Closure rejected by CivicVision.`
    });
    write();
    const e = new Error('Closure rejected: the "after" photos are near-identical to the original evidence. Please capture the completed work.');
    e.verification = verification;
    throw e;
  }

  saveEvidence(id, sources, 'after', u.id, verification.afterHashes);
  db.update('issues', id, {
    status: 'RESOLVED', resolvedAt: now(), resolvedBy: u.id, resolvedByName: u.name,
    resolution: {
      notes, workerId: u.id, workerName: u.name, photos: sources.length,
      verification: {
        verified: verification.verified, improvementScore: verification.improvementScore,
        metrics: verification.metrics, angleDiversity: verification.angleDiversity, notes: verification.notes
      },
      withinSla: Date.now() <= new Date(issue.dueAt).getTime()
    }
  });
  audit(id, u, 'RESOLVED', { verified: verification.verified, improvementScore: verification.improvementScore });
  notifyUser(issue.reporterId, {
    issueId: id, level: verification.verified ? 'info' : 'warning',
    title: `${issue.code} marked resolved`,
    message: verification.verified ? 'CivicVision confirmed visible improvement. Please review and confirm.' : 'Work submitted but improvement could not be confirmed. Your review decides the outcome.'
  });
  raiseAlert({
    issueId: id, departmentId: issue.departmentId, level: verification.verified ? 'success' : 'warning',
    title: `${issue.code} resolved by ${u.name}`,
    message: verification.verified
      ? `CivicVision verified the closure evidence (improvement score ${verification.improvementScore}). Awaiting citizen confirmation.`
      : `Closure evidence submitted but improvement could not be confirmed (score ${verification.improvementScore}).`
  });
  write();
  return { issue: decorate(db.byId('issues', id)), verification };
}

export function citizenVerify(id, { accepted, rating = 4, comment = '' }) {
  const issue = db.byId('issues', id);
  const u = currentUser();
  const owner = issue.reporterId === u.id || (issue.corroborators || []).includes(u.id);
  if (!owner && u.role !== 'admin') throw new Error('Only the citizen who reported this issue can verify it.');
  if (issue.status !== 'RESOLVED') throw new Error('This issue has not been marked resolved yet.');

  if (accepted) {
    db.update('issues', id, { status: 'CLOSED', verifiedAt: now(), closedAt: now(), citizenFeedback: { accepted: true, rating, comment, by: u.name } });
    audit(id, u, 'CITIZEN_VERIFIED', { rating });
    db.update('users', u.id, { trustScore: Math.min(1, (u.trustScore || 0.6) + 0.05), verifiedReports: (u.verifiedReports || 0) + 1 });
    raiseAlert({ issueId: id, departmentId: issue.departmentId, level: 'success', title: `${issue.code} closed and verified by citizen`, message: `${u.name} confirmed the fix with a ${rating}/5 rating.` });
  } else {
    db.update('issues', id, {
      status: 'ESCALATED', escalated: true, reopenedAt: now(),
      citizenFeedback: { accepted: false, rating, comment, by: u.name },
      dueAt: new Date(Date.now() + 24 * 36e5).toISOString()
    });
    audit(id, u, 'CITIZEN_REJECTED', { rating, comment });
    raiseAlert({ issueId: id, departmentId: issue.departmentId, level: 'critical', title: `Closure rejected by citizen on ${issue.code}`, message: `${u.name} rejected the closure: "${comment || 'no comment'}". Re-opened with a 24 hour SLA.` });
  }
  write();
  return decorate(db.byId('issues', id));
}

export function reclassify(id, category, severity, reason = '') {
  const issue = db.byId('issues', id);
  const u = currentUser();
  if (!['supervisor', 'admin'].includes(u.role)) throw new Error('Supervisor access required.');
  const meta = categoryMeta(category);
  db.update('issues', id, {
    category, categoryLabel: meta.label, icon: meta.icon,
    severity, severityLabel: SEVERITY_LABELS[severity],
    departmentId: meta.department, slaHours: meta.slaHours,
    dueAt: new Date(Date.now() + meta.slaHours * 36e5).toISOString(),
    humanReview: false,
    reclassified: { from: issue.category, by: u.name, at: now(), reason }
  });
  audit(id, u, 'RECLASSIFIED', { from: issue.category, to: category });
  raiseAlert({ issueId: id, departmentId: meta.department, level: 'info', title: 'Issue re-routed to your department', message: `${issue.code} was re-classified from ${issue.categoryLabel} to ${meta.label} by ${u.name}.` });
  write();
  return decorate(db.byId('issues', id));
}

export function issueNotice(contractorId, { reason, issueId }) {
  const u = currentUser();
  if (!['supervisor', 'admin'].includes(u.role)) throw new Error('Supervisor access required.');
  const c = db.byId('contractors', contractorId);
  if (!c) throw new Error('Contractor not found.');
  const notices = [...(c.notices || []), { id: uid('ntc'), issueId: issueId || null, reason, issuedBy: u.name, issuedAt: now() }];
  db.update('contractors', contractorId, { notices, rating: Math.max(1, +(c.rating - 0.2).toFixed(1)) });
  if (issueId) audit(issueId, u, 'CONTRACTOR_NOTICE_ISSUED', { contractor: c.name, reason });
  write();
  return db.byId('contractors', contractorId);
}

/* ----------------------------------------------------------- SLA sweeper */

export function slaSweep() {
  let changed = false;
  for (const issue of read().issues) {
    if (!['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS'].includes(issue.status)) continue;
    if (issue.escalated || !issue.dueAt || new Date(issue.dueAt) > new Date()) continue;
    db.update('issues', issue.id, { status: 'ESCALATED', escalated: true, escalatedAt: now() });
    audit(issue.id, null, 'SLA_BREACHED', { slaHours: issue.slaHours });
    raiseAlert({
      issueId: issue.id, departmentId: issue.departmentId, level: 'critical',
      title: `SLA breached on ${issue.code}`,
      message: `${issue.categoryLabel} at ${issue.wardName} has crossed its ${issue.slaHours}h SLA. Escalated to supervisor.`
    });
    changed = true;
  }
  if (changed) write();
}

/* ------------------------------------------------------------- analytics */

export function overview() {
  const issues = read().issues;
  const resolvedish = issues.filter((i) => ['RESOLVED', 'CLOSED'].includes(i.status));
  const durations = resolvedish.filter((i) => i.resolvedAt).map((i) => (new Date(i.resolvedAt) - new Date(i.createdAt)) / 36e5);
  const onTime = resolvedish.filter((i) => i.resolution?.withinSla).length;
  const byCategory = {};
  for (const i of issues) byCategory[i.category] = (byCategory[i.category] || 0) + 1;
  const confs = issues.map((i) => i.ai?.confidence).filter((n) => typeof n === 'number');

  const trend = [];
  for (let d = 13; d >= 0; d--) {
    const key = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    trend.push({
      date: key,
      reported: issues.filter((i) => i.createdAt.slice(0, 10) === key).length,
      closed: issues.filter((i) => i.closedAt && i.closedAt.slice(0, 10) === key).length
    });
  }

  return {
    totals: {
      issues: issues.length,
      open: issues.filter((i) => OPEN.includes(i.status)).length,
      overdue: issues.filter((i) => OPEN.includes(i.status) && new Date(i.dueAt) < new Date()).length,
      resolved: issues.filter((i) => i.status === 'RESOLVED').length,
      closed: issues.filter((i) => i.status === 'CLOSED').length,
      citizens: read().users.filter((u) => u.role === 'citizen').length,
      corroborations: issues.reduce((a, i) => a + Math.max(0, (i.reportCount || 1) - 1), 0),
      contractorLiabilities: issues.filter((i) => i.contractor?.liable).length
    },
    sla: {
      compliance: resolvedish.length ? Math.round((onTime / resolvedish.length) * 100) : null,
      avgResolutionHours: durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1) : null
    },
    ai: {
      model: modelState(),
      categories: Object.keys(CATEGORIES).length,
      avgConfidence: confs.length ? +(confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(3) : null,
      humanReviewQueue: issues.filter((i) => i.humanReview && i.status !== 'CLOSED').length,
      overridden: issues.filter((i) => i.reclassified).length,
      fakeClosuresBlocked: read().audit.filter((a) => a.action === 'CLOSURE_REJECTED').length,
      confidenceThreshold: CONFIG.confidenceThreshold
    },
    byCategory: Object.entries(byCategory).map(([k, v]) => ({ category: k, label: CATEGORIES[k]?.label || k, count: v })).sort((a, b) => b.count - a.count),
    trend,
    hotspots: hotspots(issues, 2).slice(0, 10)
  };
}

export function departmentStats(deptId) {
  const rows = read().issues.filter((i) => i.departmentId === deptId);
  const done = rows.filter((i) => ['RESOLVED', 'CLOSED'].includes(i.status));
  const onTime = done.filter((i) => i.resolution?.withinSla).length;
  return {
    total: rows.length,
    open: rows.filter((i) => OPEN.includes(i.status)).length,
    overdue: rows.filter((i) => OPEN.includes(i.status) && new Date(i.dueAt) < new Date()).length,
    closed: rows.filter((i) => i.status === 'CLOSED').length,
    slaCompliance: done.length ? Math.round((onTime / done.length) * 100) : null
  };
}
