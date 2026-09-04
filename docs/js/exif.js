/**
 * EXIF reader (browser build) - same logic as server/services/exif.js, using a
 * DataView over the File's ArrayBuffer instead of a Node Buffer.
 * A photo that carries its own GPS tag is the strongest location evidence we
 * can get from a citizen, so it takes priority over the browser's own fix.
 */

const TAG = { GPS_IFD: 0x8825, EXIF_IFD: 0x8769, MAKE: 0x010f, MODEL: 0x0110, DATETIME: 0x0132, DATETIME_ORIGINAL: 0x9003 };
const GPS = { LAT_REF: 1, LAT: 2, LON_REF: 3, LON: 4, ALT: 6 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readValue(v, offset, type, count, tiffStart, le) {
  const size = TYPE_SIZE[type] || 1;
  const total = size * count;
  let ptr = offset;
  if (total > 4) ptr = tiffStart + v.getUint32(offset, le);
  if (ptr + total > v.byteLength) return null;

  if (type === 2) {
    let s = '';
    for (let i = 0; i < total; i++) {
      const c = v.getUint8(ptr + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  if (type === 5 || type === 10) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = ptr + i * 8;
      const n = type === 5 ? v.getUint32(o, le) : v.getInt32(o, le);
      const d = type === 5 ? v.getUint32(o + 4, le) : v.getInt32(o + 4, le);
      out.push(d === 0 ? 0 : n / d);
    }
    return count === 1 ? out[0] : out;
  }
  const rd = { 1: (o) => v.getUint8(o), 3: (o) => v.getUint16(o, le), 4: (o) => v.getUint32(o, le), 9: (o) => v.getInt32(o, le) }[type];
  if (!rd) return null;
  const out = [];
  for (let i = 0; i < count; i++) out.push(rd(ptr + i * size));
  return count === 1 ? out[0] : out;
}

function readIfd(v, tiffStart, ifdOffset, le) {
  const entries = {};
  const base = tiffStart + ifdOffset;
  if (base + 2 > v.byteLength) return entries;
  const n = v.getUint16(base, le);
  for (let i = 0; i < n; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > v.byteLength) break;
    entries[v.getUint16(e, le)] = readValue(v, e + 8, v.getUint16(e + 2, le), v.getUint32(e + 4, le), tiffStart, le);
  }
  return entries;
}

const dms = (parts, ref) => {
  if (!Array.isArray(parts) || parts.length < 3) return null;
  const val = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return (ref === 'S' || ref === 'W') ? -val : val;
};

export async function readExif(file) {
  const empty = { hasExif: false, gps: null, capturedAt: null, camera: null };
  try {
    const buf = await file.arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 12 || v.getUint8(0) !== 0xff || v.getUint8(1) !== 0xd8) return empty;

    let off = 2, tiffStart = -1;
    while (off < v.byteLength - 4) {
      if (v.getUint8(off) !== 0xff) { off++; continue; }
      const marker = v.getUint8(off + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xda) break;
      const len = v.getUint16(off + 2);
      let tag = '';
      for (let i = 0; i < 4; i++) tag += String.fromCharCode(v.getUint8(off + 4 + i));
      if (marker === 0xe1 && tag === 'Exif') { tiffStart = off + 10; break; }
      off += 2 + len;
    }
    if (tiffStart < 0 || tiffStart + 8 > v.byteLength) return empty;

    const le = String.fromCharCode(v.getUint8(tiffStart), v.getUint8(tiffStart + 1)) === 'II';
    const ifd0 = readIfd(v, tiffStart, v.getUint32(tiffStart + 4, le), le);

    let gps = null;
    if (ifd0[TAG.GPS_IFD]) {
      const g = readIfd(v, tiffStart, ifd0[TAG.GPS_IFD], le);
      const lat = dms(g[GPS.LAT], g[GPS.LAT_REF]);
      const lon = dms(g[GPS.LON], g[GPS.LON_REF]);
      if (lat !== null && lon !== null && isFinite(lat) && isFinite(lon)) {
        gps = { lat: +lat.toFixed(7), lng: +lon.toFixed(7), source: 'exif' };
      }
    }

    let capturedAt = null;
    if (ifd0[TAG.EXIF_IFD]) capturedAt = readIfd(v, tiffStart, ifd0[TAG.EXIF_IFD], le)[TAG.DATETIME_ORIGINAL] || null;
    capturedAt = capturedAt || ifd0[TAG.DATETIME] || null;
    if (typeof capturedAt === 'string') {
      const m = capturedAt.match(/^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/);
      if (m) capturedAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }

    const camera = [ifd0[TAG.MAKE], ifd0[TAG.MODEL]].filter(Boolean).join(' ').trim() || null;
    return { hasExif: true, gps, capturedAt: capturedAt || null, camera };
  } catch {
    return empty;
  }
}

/** Downscale + re-encode so photos fit comfortably in browser storage. */
export function compressImage(file, maxSide = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}
