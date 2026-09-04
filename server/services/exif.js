/**
 * Minimal EXIF reader (no dependencies).
 * Extracts GPS coordinates, capture timestamp and camera make/model straight
 * from the JPEG the citizen uploaded - this is the trust anchor for location:
 * a photo carrying its own GPS tag is far harder to fake than a typed address.
 */

const TAG = {
  GPS_IFD: 0x8825,
  EXIF_IFD: 0x8769,
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  DATETIME: 0x0132,
  DATETIME_ORIGINAL: 0x9003
};

const GPS = {
  LAT_REF: 1, LAT: 2, LON_REF: 3, LON: 4, ALT_REF: 5, ALT: 6, TIMESTAMP: 7, DATESTAMP: 29
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readValue(buf, offset, type, count, tiffStart, le) {
  const size = TYPE_SIZE[type] || 1;
  const total = size * count;
  let ptr = offset;
  if (total > 4) {
    ptr = tiffStart + (le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset));
  }
  if (ptr + total > buf.length) return null;

  const rd = {
    1: (o) => buf.readUInt8(o),
    3: (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    4: (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
    9: (o) => (le ? buf.readInt32LE(o) : buf.readInt32BE(o))
  };

  if (type === 2) {
    return buf.toString('ascii', ptr, ptr + total).replace(/\0.*$/, '').trim();
  }
  if (type === 5 || type === 10) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = ptr + i * 8;
      const n = type === 5
        ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
        : (le ? buf.readInt32LE(o) : buf.readInt32BE(o));
      const d = type === 5
        ? (le ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o + 4))
        : (le ? buf.readInt32LE(o + 4) : buf.readInt32BE(o + 4));
      out.push(d === 0 ? 0 : n / d);
    }
    return count === 1 ? out[0] : out;
  }
  const reader = rd[type];
  if (!reader) return null;
  const out = [];
  for (let i = 0; i < count; i++) out.push(reader(ptr + i * size));
  return count === 1 ? out[0] : out;
}

function readIfd(buf, tiffStart, ifdOffset, le) {
  const entries = {};
  const base = tiffStart + ifdOffset;
  if (base + 2 > buf.length) return entries;
  const n = le ? buf.readUInt16LE(base) : buf.readUInt16BE(base);
  for (let i = 0; i < n; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > buf.length) break;
    const tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
    const type = le ? buf.readUInt16LE(e + 2) : buf.readUInt16BE(e + 2);
    const count = le ? buf.readUInt32LE(e + 4) : buf.readUInt32BE(e + 4);
    entries[tag] = readValue(buf, e + 8, type, count, tiffStart, le);
  }
  return entries;
}

const dms = (parts, ref) => {
  if (!Array.isArray(parts) || parts.length < 3) return null;
  const val = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return (ref === 'S' || ref === 'W') ? -val : val;
};

export function readExif(buffer) {
  const empty = { hasExif: false, gps: null, capturedAt: null, camera: null };
  try {
    if (!buffer || buffer.length < 12) return empty;
    if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) return empty; // JPEG only

    // locate APP1/Exif
    let off = 2, tiffStart = -1;
    while (off < buffer.length - 4) {
      if (buffer[off] !== 0xff) { off++; continue; }
      const marker = buffer[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xda) break;
      const len = buffer.readUInt16BE(off + 2);
      if (marker === 0xe1 && buffer.toString('ascii', off + 4, off + 10) === 'Exif\0\0') {
        tiffStart = off + 10;
        break;
      }
      off += 2 + len;
    }
    if (tiffStart < 0 || tiffStart + 8 > buffer.length) return empty;

    const le = buffer.toString('ascii', tiffStart, tiffStart + 2) === 'II';
    const ifd0Offset = le ? buffer.readUInt32LE(tiffStart + 4) : buffer.readUInt32BE(tiffStart + 4);
    const ifd0 = readIfd(buffer, tiffStart, ifd0Offset, le);

    let gps = null;
    if (ifd0[TAG.GPS_IFD]) {
      const g = readIfd(buffer, tiffStart, ifd0[TAG.GPS_IFD], le);
      const lat = dms(g[GPS.LAT], g[GPS.LAT_REF]);
      const lon = dms(g[GPS.LON], g[GPS.LON_REF]);
      if (lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon)) {
        gps = {
          lat: +lat.toFixed(7),
          lng: +lon.toFixed(7),
          altitude: typeof g[GPS.ALT] === 'number' ? +g[GPS.ALT].toFixed(1) : null,
          source: 'exif'
        };
      }
    }

    let capturedAt = null;
    if (ifd0[TAG.EXIF_IFD]) {
      const ex = readIfd(buffer, tiffStart, ifd0[TAG.EXIF_IFD], le);
      capturedAt = ex[TAG.DATETIME_ORIGINAL] || null;
    }
    capturedAt = capturedAt || ifd0[TAG.DATETIME] || null;
    if (typeof capturedAt === 'string') {
      const m = capturedAt.match(/^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/);
      if (m) capturedAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }

    const camera = [ifd0[TAG.MAKE], ifd0[TAG.MODEL]].filter(Boolean).join(' ').trim() || null;
    return { hasExif: true, gps, capturedAt: capturedAt || null, camera, orientation: ifd0[TAG.ORIENTATION] ?? null };
  } catch {
    return empty;
  }
}

export default { readExif };
