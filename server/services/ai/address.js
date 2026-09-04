/**
 * AI address resolution.
 *
 * "Where exactly is this?" is answered by reading the photograph, not just by
 * trusting a GPS dot. Four signals are combined:
 *
 *   1. EXIF GPS embedded in the photo   - strongest, hard to fake
 *   2. Device GPS from the browser      - good, but drifts indoors/among towers
 *   3. OCR over the photo (Tesseract)   - reads street name boards, shop names,
 *                                         house/plot numbers and PIN codes that
 *                                         are physically present at the site
 *   4. The citizen's own description    - landmarks they typed
 *
 * The OCR text and description are then geocoded against OpenStreetMap
 * (Nominatim), biased to a box around the GPS fix when we have one. That turns
 * "12.9352, 77.6245" into "5th Cross Road, Koramangala 3rd Block, Bengaluru
 * 560034" and, when a signboard is legible, pins the actual premises.
 *
 * Every component records which signal produced it, so a municipal officer can
 * see why the platform believes the address - and OCR never silently overrides
 * a GPS fix, it only refines or corroborates it.
 */
import jpeg from 'jpeg-js';
import config from '../../config.js';
import { haversine } from '../geo.js';
import { decodeImage } from './heuristic.js';
import { tidyLines, parseAddressHints, compose, addressConfidence } from './address-core.js';

/* --------------------------------------------------------------------- OCR */

let worker = null;
let workerLoading = null;
let ocrFailed = null;

async function getWorker() {
  if (worker) return worker;
  if (ocrFailed) return null;
  if (workerLoading) return workerLoading;

  workerLoading = (async () => {
    try {
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng');
      worker = w;
      return w;
    } catch (err) {
      ocrFailed = err.message;
      console.warn(`[CivicPulse] OCR unavailable (${err.message}). Addresses will use GPS only.`);
      return null;
    } finally {
      workerLoading = null;
    }
  })();
  return workerLoading;
}

export function warmupOcr() {
  getWorker().then((w) => { if (w) console.log('[CivicPulse] OCR engine ready (tesseract eng)'); });
}

/**
 * Scene text preprocessing.
 * Tesseract is built for scanned documents; a signboard photographed from the
 * street is small, low-contrast and off-white. Converting to greyscale,
 * stretching the contrast between the 5th and 95th percentile and upscaling
 * roughly doubles the number of legible lines we get back.
 */
function preprocess(buffer) {
  try {
    const img = decodeImage(buffer);
    const { width, height, data, channels } = img;

    const grey = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * channels;
      grey[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) | 0;
    }

    // contrast stretch on the 5th..95th percentile
    const hist = new Uint32Array(256);
    for (const v of grey) hist[v]++;
    const total = grey.length;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.05) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.05) { hi = v; break; } }
    const span = Math.max(1, hi - lo);

    // upscale so small lettering clears Tesseract's minimum x-height
    const scale = Math.min(3, Math.max(1, Math.round(1600 / Math.max(width, height))));
    const W = width * scale, H = height * scale;
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      const sy = (y / scale) | 0;
      for (let x = 0; x < W; x++) {
        const sx = (x / scale) | 0;
        let v = ((grey[sy * width + sx] - lo) / span) * 255;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        const o = (y * W + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return Buffer.from(jpeg.encode({ data: out, width: W, height: H }, 92).data);
  } catch {
    return buffer;
  }
}

/** Read any text visible in the photos - signboards, plates, house numbers. */
export async function readSignage(buffers) {
  const w = await getWorker();
  if (!w) return { ok: false, lines: [], text: '' };

  const lines = [];
  for (const buf of buffers.slice(0, 3)) {
    try {
      // PSM 11 = sparse text: the right mode for scattered signage in a scene.
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await w.recognize(preprocess(buf), {}, { blocks: true, text: true });

      const found = (data.blocks || [])
        .flatMap((b) => b.paragraphs || [])
        .flatMap((p) => p.lines || []);

      for (const line of found) {
        lines.push({ text: String(line.text || ''), confidence: Math.round(line.confidence || 0) });
      }
    } catch { /* skip an unreadable angle */ }
  }

  const unique = tidyLines(lines);

  return { ok: true, lines: unique, text: unique.map((l) => l.text).join(' · ') };
}

/* ------------------------------------------------------------- geocoding */

async function nominatim(pathAndQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(`${config.geo.nominatim}${pathAndQuery}`, {
      headers: { 'User-Agent': config.geo.userAgent, 'Accept-Language': 'en' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Forward-geocode a signboard/landmark phrase, biased near the GPS fix. */
async function searchNear(query, point) {
  if (!query || !config.geo.reverseGeocode) return null;
  let q = `/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
  if (point) {
    const d = 0.02; // ~2 km box
    q += `&viewbox=${point.lng - d},${point.lat + d},${point.lng + d},${point.lat - d}&bounded=1`;
  }
  try {
    const rows = await nominatim(q);
    if (!Array.isArray(rows) || !rows.length) return null;
    const scored = rows.map((r) => ({
      ...r,
      distanceM: point ? Math.round(haversine(point, { lat: +r.lat, lng: +r.lon })) : null
    })).sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
    return scored[0];
  } catch { return null; }
}

/* ------------------------------------------------------------------ public */

/**
 * @param {Buffer[]} buffers  the citizen's photos
 * @param {{lat,lng,source}} point  best available GPS fix (may be null)
 * @param {string} description  citizen text
 * @param {object} place  the reverse-geocode result already computed for `point`
 */
export async function resolveAddress({ buffers, point, description = '', place = null }) {
  const started = Date.now();
  const signals = [];

  const ocr = await readSignage(buffers);
  if (ocr.ok && ocr.lines.length) {
    signals.push(`OCR read ${ocr.lines.length} text line(s) from the photo`);
  }

  const hints = parseAddressHints(ocr.lines || [], description);

  // Which of the hints actually came from the photograph (vs the typed text)?
  const ocrHints = parseAddressHints(ocr.lines || [], '');
  const photoGaveText = Boolean(
    ocrHints.roadNames.length || ocrHints.placeNames.length ||
    ocrHints.houseNumbers.length || ocrHints.pincode
  );

  // Build the most specific query available, and remember where it came from.
  const fromPhoto = [ocrHints.houseNumbers[0], ocrHints.placeNames[0], ocrHints.roadNames[0]].filter(Boolean);
  const fromText = [hints.houseNumbers[0], hints.placeNames[0], hints.roadNames[0]].filter(Boolean);
  const fromGps = [place?.wardName, place?.city].filter(Boolean);

  const specific = fromPhoto.length ? fromPhoto : fromText;
  const queryParts = [...specific, ...fromGps];
  const query = queryParts.join(', ');

  let matched = null;
  if (queryParts.length >= 2 || (queryParts.length === 1 && !point)) {
    matched = await searchNear(query, point);
    if (matched) {
      const head = matched.display_name.split(',')[0];
      const near = matched.distanceM !== null ? `, ${matched.distanceM} m from the GPS fix` : '';
      if (fromPhoto.length) {
        signals.push(`Text read from the photo ("${fromPhoto.join(', ')}") matched "${head}" in OpenStreetMap${near}`);
      } else if (fromText.length) {
        signals.push(`Landmark from your description matched "${head}" in OpenStreetMap${near}`);
      } else {
        signals.push(`Locality from the GPS fix resolved to "${head}" in OpenStreetMap${near}`);
      }
    }
  }
  if (!photoGaveText && ocr.ok) {
    signals.push('No legible signage in the photo - address derived from GPS and reverse geocoding');
  }

  // Base address from the GPS fix (already reverse-geocoded upstream).
  const base = place ? { ...place, addressDetail: place.addressDetail || place.raw || {} } : null;
  if (point) {
    signals.push(point.source === 'exif'
      ? 'GPS coordinates embedded in the photo by the camera'
      : 'GPS fix supplied by the device');
  }

  // If OCR found a plausible premises within 300 m, trust it as the precise pin.
  const snap = Boolean(photoGaveText && matched && matched.distanceM !== null && matched.distanceM <= 300);
  const resolvedPoint = snap ? { lat: +matched.lat, lng: +matched.lon, source: 'ocr+osm' } : point;

  const photoRoad = photoGaveText ? (ocrHints.roadNames[0] || null) : null;
  const formatted = compose(base, hints, matched, photoRoad)
    || matched?.display_name
    || place?.address
    || (point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : 'Location unknown');

  const confidence = addressConfidence({
    point, place, matched, snapped: snap, photoGaveText, pincode: hints.pincode
  });

  return {
    formatted,
    confidence: +Math.min(0.99, confidence).toFixed(2),
    point: resolvedPoint,
    snapped: snap,
    landmark: matched?.display_name?.split(',')[0] || hints.placeNames[0] || null,
    road: photoRoad || base?.addressDetail?.road || hints.roadNames[0] || null,
    ward: place?.wardName || null,
    pincode: base?.addressDetail?.postcode || hints.pincode || null,
    source: photoGaveText ? 'photo-text + gps' : (point ? 'gps + reverse geocoding' : 'description only'),
    photoContributed: photoGaveText,
    ocr: { available: ocr.ok, lines: ocr.lines || [], text: ocr.text || '' },
    hints: { houseNumbers: hints.houseNumbers, roadNames: hints.roadNames, placeNames: hints.placeNames },
    osmMatch: matched ? {
      name: matched.display_name, osmId: `${matched.osm_type}/${matched.osm_id}`,
      distanceM: matched.distanceM, category: matched.category, type: matched.type
    } : null,
    signals,
    ms: Date.now() - started
  };
}

export const ocrStatus = () => ({ engine: 'tesseract-eng', ready: Boolean(worker), error: ocrFailed });

export default { resolveAddress, readSignage, parseAddressHints, warmupOcr, ocrStatus };
