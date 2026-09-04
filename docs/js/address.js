/**
 * AI address resolution (browser build).
 *
 * Same four signals as the Node backend - EXIF GPS, device GPS, OCR over the
 * photo, and the citizen's description - fused into one street address. The
 * parsing rules live in address-core.js, shared verbatim with the server.
 *
 * Tesseract runs in a WebAssembly worker loaded from a CDN and is only fetched
 * the first time a citizen submits photos, so visitors who just browse the map
 * never pay for the download.
 */
import { tidyLines, parseAddressHints, compose, addressConfidence } from './address-core.js?v=20260905c';

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js';

let worker = null;
let loading = null;
let failed = null;
const listeners = new Set();

export function onOcrProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const report = (info) => { for (const fn of listeners) { try { fn(info); } catch { /* ignore */ } } };

export const ocrState = () => ({ engine: 'tesseract-eng', ready: Boolean(worker), loading: Boolean(loading), error: failed });

async function getWorker() {
  if (worker) return worker;
  if (failed) return null;
  if (loading) return loading;

  loading = (async () => {
    try {
      report({ status: 'loading-ocr' });
      const T = await import(/* @vite-ignore */ CDN);
      const createWorker = T.createWorker || T.default?.createWorker;
      const w = await createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') report({ status: 'reading', progress: Math.round((m.progress || 0) * 100) });
        }
      });
      await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse scene text
      worker = w;
      report({ status: 'ocr-ready' });
      return w;
    } catch (err) {
      failed = err.message;
      report({ status: 'ocr-error', error: err.message });
      console.warn('[CivicPulse] OCR unavailable, address will use GPS only:', err);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Greyscale + contrast stretch + upscale.
 * Signboards photographed from the street are small and low contrast; this
 * roughly doubles the number of legible lines Tesseract returns.
 */
function preprocess(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(3, Math.max(1, Math.round(1600 / Math.max(img.naturalWidth, img.naturalHeight))));
        const W = img.naturalWidth * scale, H = img.naturalHeight * scale;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, W, H);
        const px = g.getImageData(0, 0, W, H);
        const d = px.data;

        const hist = new Uint32Array(256);
        for (let i = 0; i < d.length; i += 4) {
          const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
          d[i] = d[i + 1] = d[i + 2] = v;
          hist[v]++;
        }
        const total = d.length / 4;
        let acc = 0, lo = 0, hi = 255;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.05) { lo = v; break; } }
        acc = 0;
        for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.05) { hi = v; break; } }
        const span = Math.max(1, hi - lo);
        for (let i = 0; i < d.length; i += 4) {
          let v = ((d[i] - lo) / span) * 255;
          v = v < 0 ? 0 : v > 255 ? 255 : v;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        g.putImageData(px, 0, 0);
        resolve(c.toDataURL('image/jpeg', 0.92));
      } catch { resolve(src); }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

/** Read any text visible in the photos - signboards, plates, house numbers. */
export async function readSignage(sources) {
  const w = await getWorker();
  if (!w) return { ok: false, lines: [], text: '' };

  const lines = [];
  for (const src of sources.slice(0, 2)) {
    try {
      const prepped = await preprocess(src);
      const { data } = await w.recognize(prepped, {}, { blocks: true, text: true });
      const found = (data.blocks || []).flatMap((b) => b.paragraphs || []).flatMap((p) => p.lines || []);
      for (const line of found) {
        lines.push({ text: String(line.text || ''), confidence: Math.round(line.confidence || 0) });
      }
    } catch { /* skip an unreadable angle */ }
  }

  const unique = tidyLines(lines);
  return { ok: true, lines: unique, text: unique.map((l) => l.text).join(' | ') };
}

/* ------------------------------------------------------------- geocoding */

const haversine = (a, b) => {
  if (!a || !b) return Infinity;
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

async function searchNear(query, point) {
  if (!query) return null;
  let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
  if (point) {
    const d = 0.02;
    url += `&viewbox=${point.lng - d},${point.lat + d},${point.lng + d},${point.lat - d}&bounded=1`;
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .map((r) => ({ ...r, distanceM: point ? Math.round(haversine(point, { lat: +r.lat, lng: +r.lon })) : null }))
      .sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9))[0];
  } catch { return null; }
}

/* ------------------------------------------------------------------ public */

export async function resolveAddress({ sources, point, description = '', place = null }) {
  const started = performance.now();
  const signals = [];

  const ocr = await readSignage(sources);
  if (ocr.ok && ocr.lines.length) signals.push(`OCR read ${ocr.lines.length} text line(s) from the photo`);

  const hints = parseAddressHints(ocr.lines || [], description);
  const ocrHints = parseAddressHints(ocr.lines || [], '');
  const photoGaveText = Boolean(
    ocrHints.roadNames.length || ocrHints.placeNames.length || ocrHints.houseNumbers.length || ocrHints.pincode
  );

  const fromPhoto = [ocrHints.houseNumbers[0], ocrHints.placeNames[0], ocrHints.roadNames[0]].filter(Boolean);
  const fromText = [hints.houseNumbers[0], hints.placeNames[0], hints.roadNames[0]].filter(Boolean);
  const fromGps = [place?.wardName, place?.city].filter(Boolean);
  const specific = fromPhoto.length ? fromPhoto : fromText;
  const queryParts = [...specific, ...fromGps];

  let matched = null;
  if (queryParts.length >= 2 || (queryParts.length === 1 && !point)) {
    matched = await searchNear(queryParts.join(', '), point);
    if (matched) {
      const head = matched.display_name.split(',')[0];
      const near = matched.distanceM !== null ? `, ${matched.distanceM} m from the GPS fix` : '';
      if (fromPhoto.length) signals.push(`Text read from the photo ("${fromPhoto.join(', ')}") matched "${head}" in OpenStreetMap${near}`);
      else if (fromText.length) signals.push(`Landmark from your description matched "${head}" in OpenStreetMap${near}`);
      else signals.push(`Locality from the GPS fix resolved to "${head}" in OpenStreetMap${near}`);
    }
  }
  if (!photoGaveText && ocr.ok) signals.push('No legible signage in the photo - address derived from GPS and reverse geocoding');
  if (point) signals.push(point.source === 'exif' ? 'GPS coordinates embedded in the photo by the camera' : 'GPS fix supplied by the device');

  const base = place ? { ...place, addressDetail: place.addressDetail || {} } : null;
  const snap = Boolean(photoGaveText && matched && matched.distanceM !== null && matched.distanceM <= 300);
  const photoRoad = photoGaveText ? (ocrHints.roadNames[0] || null) : null;

  const formatted = compose(base, hints, matched, photoRoad)
    || matched?.display_name || place?.address
    || (point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : 'Location unknown');

  return {
    formatted,
    confidence: addressConfidence({ point, place, matched, snapped: snap, photoGaveText, pincode: hints.pincode }),
    point: snap ? { lat: +matched.lat, lng: +matched.lon, source: 'ocr+osm' } : point,
    snapped: snap,
    source: photoGaveText ? 'photo-text + gps' : (point ? 'gps + reverse geocoding' : 'description only'),
    photoContributed: photoGaveText,
    landmark: matched?.display_name?.split(',')[0] || hints.placeNames[0] || null,
    road: photoRoad || base?.addressDetail?.road || hints.roadNames[0] || null,
    ward: place?.wardName || null,
    pincode: base?.addressDetail?.postcode || hints.pincode || null,
    ocr: { available: ocr.ok, lines: ocr.lines || [], text: ocr.text || '' },
    hints: { houseNumbers: hints.houseNumbers, roadNames: hints.roadNames, placeNames: hints.placeNames },
    osmMatch: matched ? { name: matched.display_name, osmId: `${matched.osm_type}/${matched.osm_id}`, distanceM: matched.distanceM } : null,
    signals,
    ms: Math.round(performance.now() - started)
  };
}
