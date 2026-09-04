/**
 * Address parsing primitives - pure functions, no I/O.
 *
 * Shared verbatim between the Node backend (server/services/ai/address.js) and
 * the browser build (docs/js/address.js) so both produce identical addresses
 * from the same OCR text.
 */

export const ROAD_WORDS = /\b(road|rd|street|st|cross|main|lane|marg|nagar|layout|colony|block|sector|phase|avenue|ave|circle|junction|chowk|gali|extension|extn|hill|gardens|grove|close|way|terrace|row|square|bridge|path|walk|drive|court|crescent)\b/i;

export const PLACE_WORDS = /\b(school|college|hospital|clinic|temple|church|mosque|masjid|bank|atm|park|market|store|stores|mall|hotel|restaurant|bakery|pharmacy|medicals|petrol|bunk|station|office|complex|apartments|towers|society)\b/i;

/**
 * Tesseract reliably mangles the last word of a street sign ("ROAD" -> "ROY",
 * "R0AD", "RQAD"). Repairing the suffix turns an unusable OCR line into a
 * geocodable one, so it is worth the handful of substitutions.
 */
const OCR_FIXES = [
  [/\bR[O0Q][YAV]D?\b/gi, 'ROAD'],
  [/\bR0AD\b/gi, 'ROAD'],
  [/\bSTREEI\b/gi, 'STREET'],
  [/\bCR[O0]SS\b/gi, 'CROSS'],
  [/\bMA1N\b/gi, 'MAIN'],
  [/\bNACAR\b/gi, 'NAGAR'],
  [/\bLAYQUT\b/gi, 'LAYOUT']
];

export const repairOcr = (text) => OCR_FIXES.reduce((acc, [re, to]) => acc.replace(re, to), text);

/** Keep only confident, word-shaped OCR lines; join split sign lines; repair. */
export function tidyLines(lines) {
  const kept = lines.filter((l) => {
    const t = String(l.text || '').replace(/\s+/g, ' ').trim();
    if (t.length < 3) return false;
    if (l.confidence < 55) return false;
    if (!/[a-z]{3}|\d{2}/i.test(t)) return false;
    if (!/^[\w\s'&.,#/()-]+$/.test(t)) return false;
    l.text = t;
    return true;
  });

  // A single physical sign often comes back as two lines ("SHOOT-UP" /
  // "HILL NW 2"); join confident neighbours so the geocoder sees the whole name.
  const joined = [];
  for (let i = 0; i < kept.length - 1; i++) {
    const a = kept[i], b = kept[i + 1];
    if (a.confidence >= 55 && b.confidence >= 55 && (a.text + ' ' + b.text).length <= 44) {
      joined.push({ text: `${a.text} ${b.text}`, confidence: Math.round((a.confidence + b.confidence) / 2) });
    }
  }
  const all = [...kept, ...joined];
  for (const l of all) l.text = repairOcr(l.text);

  all.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set();
  return all.filter((l) => {
    const k = l.text.toLowerCase().replace(/\s+/g, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
}

/** Pull address-shaped fragments out of noisy OCR text. */
export function parseAddressHints(lines, description = '') {
  const all = [...lines.map((l) => l.text), ...String(description).split(/[.,\n]/)]
    .map((s) => s.trim()).filter(Boolean);

  const hints = { pincode: null, houseNumbers: [], roadNames: [], placeNames: [], raw: [] };

  for (const s of all) {
    const pin = s.match(/\b([1-9]\d{5})\b/);
    if (pin && !hints.pincode) hints.pincode = pin[1];

    const house = s.match(/\b(?:no\.?|#|plot|door|d\.?no\.?)\s*([0-9]+[a-z]?(?:[/-][0-9a-z]+)?)\b/i);
    if (house) hints.houseNumbers.push(house[0].replace(/\s+/g, ' ').trim());

    if (ROAD_WORDS.test(s)) hints.roadNames.push(s);
    else if (PLACE_WORDS.test(s)) hints.placeNames.push(s);
    else if (/^[A-Z][A-Za-z'&.\- ]{4,40}$/.test(s)) hints.placeNames.push(s);

    hints.raw.push(s);
  }

  // Trim OCR crumbs off the ends of a name ("CROSS ROAD FAS" -> "CROSS ROAD").
  const trimCrumbs = (name) => {
    const t = name.split(/\s+/);
    const junk = (w) => w.length <= 3 && !/^\d+$/.test(w) && !ROAD_WORDS.test(w);
    while (t.length > 1 && junk(t[t.length - 1])) t.pop();
    while (t.length > 1 && junk(t[0]) && !/^\d/.test(t[0])) t.shift();
    return t.join(' ');
  };
  const dedupe = (a) => [...new Set(a.map((x) => trimCrumbs(x.replace(/\s+/g, ' ').trim())))].slice(0, 5);

  hints.roadNames = dedupe(hints.roadNames);
  hints.placeNames = dedupe(hints.placeNames);
  hints.houseNumbers = dedupe(hints.houseNumbers);
  return hints;
}

/** Assemble a human-readable address from every available component. */
export function compose(base, hints, matched, photoRoad = null) {
  const parts = [];
  if (hints.houseNumbers[0]) parts.push(hints.houseNumbers[0]);

  // A road name physically painted on a sign at the site beats the road the
  // reverse geocoder guessed from a GPS dot that may be 200 m off.
  const a = base?.addressDetail || {};
  const road = photoRoad || a.road || hints.roadNames[0];

  const named = matched?.name || hints.placeNames[0];
  const redundant = named && road && road.toLowerCase().includes(String(named).toLowerCase());
  if (named && !redundant && !parts.includes(named)) parts.push(named);

  if (road) parts.push(road);
  const area = a.suburb || a.neighbourhood || a.city_district;
  if (area) parts.push(area);
  const city = a.city || a.town || a.village || a.state_district;
  if (city) parts.push(city);
  if (a.state) parts.push(a.state);
  const pin = a.postcode || hints.pincode;
  if (pin) parts.push(pin);

  // Drop any component contained in another ("CROSS ROAD" inside "3rd Cross
  // Road"), which happens when OCR reads part of a name the geocoder also knows.
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const keep = parts.filter((p, i) =>
    !parts.some((q, j) => j !== i && norm(q).length > norm(p).length && norm(q).includes(norm(p))));

  const seen = new Set();
  return keep.filter((p) => {
    const k = norm(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join(', ');
}

/** Confidence in the resolved address, given which signals actually fired. */
export function addressConfidence({ point, place, matched, snapped, photoGaveText, pincode }) {
  let c = 0.25;
  if (point) c += point.source === 'exif' ? 0.35 : 0.25;
  if (place && place.source === 'nominatim') c += 0.15;
  if (matched) c += photoGaveText ? 0.15 : 0.08;
  if (snapped && photoGaveText) c += 0.10;
  if (pincode) c += 0.05;
  return +Math.min(0.99, c).toFixed(2);
}
