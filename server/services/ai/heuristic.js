/**
 * CivicVision - the on-board computer-vision engine.
 *
 * A dependency-light image understanding pipeline that runs entirely on the
 * server with no internet access, so the platform never stops classifying if a
 * hosted model is unreachable. Pipeline:
 *
 *   decode (JPEG/PNG) -> 96x96 luma+HSV sampling grid
 *   -> 18 normalised scene descriptors (colour, texture, structure, specular)
 *   -> weighted evidence scoring against the CivicPulse taxonomy
 *   -> softmax -> ranked categories + confidence + human-readable evidence
 *
 * It also emits perceptual hashes (aHash + dHash) used elsewhere for
 * duplicate detection, "different angle" enforcement and fake-closure checks.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { CATEGORIES, CATEGORY_KEYS } from './taxonomy.js';

const GRID = 96;

/* ------------------------------------------------------------------ decode */

export function decodeImage(buffer) {
  if (!buffer || buffer.length < 8) throw new Error('Empty image buffer');
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8;

  if (isPng) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data, channels: 4 };
  }
  if (isJpg) {
    const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512, tolerantDecoding: true });
    return { width: img.width, height: img.height, data: img.data, channels: 4 };
  }
  throw new Error('Unsupported image format (use JPEG or PNG)');
}

/* --------------------------------------------------------------- colour ops */

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Resample any image onto a fixed GRIDxGRID lattice of RGB/HSV/luma samples. */
function sample(image) {
  const { width, height, data, channels } = image;
  const px = new Array(GRID * GRID);
  const luma = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const sx = Math.min(width - 1, Math.floor((gx + 0.5) * width / GRID));
      const sy = Math.min(height - 1, Math.floor((gy + 0.5) * height / GRID));
      const o = (sy * width + sx) * channels;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const hsv = rgbToHsv(r, g, b);
      const i = gy * GRID + gx;
      px[i] = { r, g, b, ...hsv };
      luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
  }
  return { px, luma };
}

/* ------------------------------------------------------------- descriptors */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function largestDarkBlob(luma, px) {
  const seen = new Uint8Array(GRID * GRID);
  const isDark = (i) => luma[i] < 0.30 && px[i].s < 0.45;
  let best = { area: 0, w: 1, h: 1, cy: 0 };
  const stack = [];
  for (let start = 0; start < GRID * GRID; start++) {
    if (seen[start] || !isDark(start)) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let area = 0, minX = GRID, maxX = 0, minY = GRID, maxY = 0, sumY = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % GRID, y = (i / GRID) | 0;
      area++; sumY += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const nbrs = [i - 1, i + 1, i - GRID, i + GRID];
      for (const n of nbrs) {
        if (n < 0 || n >= GRID * GRID || seen[n]) continue;
        if (Math.abs((n % GRID) - x) > 1) continue;
        if (!isDark(n)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (area > best.area) {
      best = { area, w: maxX - minX + 1, h: maxY - minY + 1, cy: sumY / area };
    }
  }
  const total = GRID * GRID;
  const bbox = best.w * best.h;
  const fill = bbox ? best.area / bbox : 0;
  const aspect = best.w && best.h ? Math.min(best.w / best.h, best.h / best.w) : 0;
  const areaRatio = best.area / total;

  // A blob covering most of the frame is ambient darkness (a night scene or a
  // shadowed wall), not a cavity in a surface. Counting it as a "pothole void"
  // is exactly how naive classifiers mistake night photos for potholes.
  const ambientDark = areaRatio > 0.5;
  return {
    darkPatchRatio: ambientDark ? clamp01((1 - areaRatio) * 0.7) : clamp01(areaRatio * 3.2),
    circularity: ambientDark ? 0 : clamp01(fill * aspect * 1.35),
    blobLowInFrame: clamp01(best.cy / GRID)
  };
}

export function describe(image) {
  const { px, luma } = sample(image);
  const N = GRID * GRID;

  let green = 0, blue = 0, brown = 0, grey = 0, asphalt = 0, sky = 0, spec = 0;
  let sumV = 0, sumS = 0, sumR = 0, sumG = 0, sumB = 0;
  const hueHist = new Float64Array(12);

  for (let i = 0; i < N; i++) {
    const p = px[i];
    const y = (i / GRID) | 0;
    sumV += p.v; sumS += p.s; sumR += p.r; sumG += p.g; sumB += p.b;
    if (p.s > 0.12) hueHist[Math.min(11, Math.floor(p.h / 30))] += 1;

    if (p.h >= 70 && p.h <= 168 && p.s > 0.18 && p.v > 0.12) green++;
    if (p.h >= 180 && p.h <= 260 && p.s > 0.15) blue++;
    if (p.h >= 12 && p.h <= 48 && p.s > 0.20 && p.v < 0.65) brown++;
    if (p.s < 0.15 && p.v > 0.35 && p.v < 0.82) grey++;
    if (p.s < 0.18 && p.v > 0.12 && p.v < 0.52) asphalt++;
    if (y < GRID * 0.35 && p.v > 0.62 && (p.h >= 180 && p.h <= 250 ? p.s > 0.05 : p.s < 0.18)) sky++;
    if (p.v > 0.88 && p.s < 0.22) spec++;
  }

  // edge / texture energy via central differences on the luma lattice
  let edgeSum = 0, edgeSq = 0, edgeN = 0;
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const i = y * GRID + x;
      const gx = Math.abs(luma[i + 1] - luma[i - 1]);
      const gy = Math.abs(luma[i + GRID] - luma[i - GRID]);
      const m = gx + gy;
      edgeSum += m; edgeSq += m * m; edgeN++;
    }
  }
  const edgeMean = edgeSum / edgeN;
  const edgeStd = Math.sqrt(Math.max(0, edgeSq / edgeN - edgeMean * edgeMean));

  // hue entropy -> how visually "chaotic" the scene is (garbage piles score high)
  const hueTotal = hueHist.reduce((a, b) => a + b, 0) || 1;
  let entropy = 0;
  for (const c of hueHist) {
    const p = c / hueTotal;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  // vertical structure: thin high-contrast columns => poles, signals, lamp posts
  let poleCols = 0;
  for (let x = 3; x < GRID - 3; x++) {
    let hits = 0;
    for (let y = 0; y < GRID * 0.75; y++) {
      const i = ((y | 0) * GRID) + x;
      const c = luma[i];
      if (Math.abs(c - luma[i - 3]) > 0.13 && Math.abs(c - luma[i + 3]) > 0.13) hits++;
    }
    if (hits > GRID * 0.34) poleCols++;
  }

  const chanMean = [sumR / N, sumG / N, sumB / N];
  let chanVar = 0;
  for (let i = 0; i < N; i++) {
    chanVar += ((px[i].r - chanMean[0]) ** 2 + (px[i].g - chanMean[1]) ** 2 + (px[i].b - chanMean[2]) ** 2) / 3;
  }

  const blob = largestDarkBlob(luma, px);
  const brightness = sumV / N;

  const f = {
    brightness: clamp01(brightness),
    saturation: clamp01((sumS / N) * 1.9),
    greenRatio: clamp01((green / N) * 2.6),
    blueRatio: clamp01((blue / N) * 3.0),
    brownRatio: clamp01((brown / N) * 3.4),
    greyRatio: clamp01((grey / N) * 2.4),
    asphaltRatio: clamp01((asphalt / N) * 2.3),
    skyRatio: clamp01((sky / N) * 3.6),
    specularRatio: clamp01((spec / N) * 6.0),
    nightRatio: clamp01((0.42 - brightness) * 3.2),
    edgeEnergy: clamp01(edgeMean * 7.5),
    textureChaos: clamp01((entropy / Math.log2(12)) * 0.55 + clamp01(edgeStd * 8) * 0.45),
    colourVariance: clamp01(Math.sqrt(chanVar / N) / 74),
    verticalStructure: clamp01((poleCols / GRID) * 5.5),
    flatSurface: clamp01(1 - edgeMean * 9),
    ...blob
  };
  return f;
}

/* -------------------------------------------------------- perceptual hashes */

export function perceptualHash(image) {
  const { luma } = sample(image);
  const S = 8;
  const cell = new Float64Array(S * S);
  const step = GRID / S;
  for (let by = 0; by < S; by++) {
    for (let bx = 0; bx < S; bx++) {
      let sum = 0, n = 0;
      for (let y = by * step; y < (by + 1) * step; y++) {
        for (let x = bx * step; x < (bx + 1) * step; x++) {
          sum += luma[(y | 0) * GRID + (x | 0)]; n++;
        }
      }
      cell[by * S + bx] = sum / n;
    }
  }
  const mean = cell.reduce((a, b) => a + b, 0) / cell.length;
  let aHash = '', dHash = '';
  for (let i = 0; i < cell.length; i++) aHash += cell[i] > mean ? '1' : '0';
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S - 1; x++) dHash += cell[y * S + x] > cell[y * S + x + 1] ? '1' : '0';
  }
  return { aHash, dHash };
}

/**
 * Perceptual distance between two images.
 * aHash (global brightness pattern) is stable on low-contrast scenes, dHash
 * (local gradients) is stable on textured ones - taking the minimum keeps the
 * measure conservative: two photos are "the same view" if EITHER agrees.
 */
export function phashDistance(a, b) {
  if (!a || !b) return 999;
  return Math.min(hamming(a.aHash, b.aHash), hamming(a.dHash, b.dHash));
}

export function hamming(a = '', b = '') {
  const n = Math.min(a.length, b.length);
  if (!n) return 999;
  let d = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d + Math.abs(a.length - b.length);
}

/* -------------------------------------------------------------- classifier */

const FEATURE_LABELS = {
  asphaltRatio: 'road/asphalt surface',
  darkPatchRatio: 'dark cavity region',
  circularity: 'circular void shape',
  greenRatio: 'dense vegetation',
  brownRatio: 'mud/sludge tones',
  blueRatio: 'water tones',
  greyRatio: 'concrete/grey material',
  skyRatio: 'open sky in frame',
  specularRatio: 'wet/reflective surface',
  nightRatio: 'low-light scene',
  edgeEnergy: 'high edge density',
  textureChaos: 'chaotic scattered texture',
  colourVariance: 'mixed multi-colour objects',
  verticalStructure: 'tall vertical pole structure',
  flatSurface: 'flat uniform surface',
  saturation: 'strong colour saturation',
  brightness: 'bright scene'
};

function softmax(scores, temperature = 1.35) {
  const vals = Object.values(scores);
  const max = Math.max(...vals);
  const exps = {};
  let sum = 0;
  for (const [k, v] of Object.entries(scores)) {
    const e = Math.exp((v - max) / temperature);
    exps[k] = e; sum += e;
  }
  const out = {};
  for (const k of Object.keys(exps)) out[k] = exps[k] / sum;
  return out;
}

/** Score one decoded image against every taxonomy category. */
export function classifyFeatures(features) {
  const raw = {};
  const evidence = {};
  for (const key of CATEGORY_KEYS) {
    const weights = CATEGORIES[key].visual;
    let score = 0;
    const contributions = [];
    for (const [feat, w] of Object.entries(weights)) {
      const v = features[feat] ?? 0;
      const c = v * w;
      score += c;
      if (c > 0.25) contributions.push({ feature: feat, label: FEATURE_LABELS[feat] || feat, value: +v.toFixed(2), impact: +c.toFixed(2) });
    }
    raw[key] = score;
    evidence[key] = contributions.sort((a, b) => b.impact - a.impact).slice(0, 4);
  }
  const probs = softmax(raw);
  const ranked = Object.entries(probs)
    .map(([key, p]) => ({ category: key, probability: +p.toFixed(4), evidence: evidence[key] }))
    .sort((a, b) => b.probability - a.probability);
  return ranked;
}

/**
 * Full multi-image analysis. Averages descriptors across every angle the
 * citizen submitted, then boosts confidence when independent angles agree.
 */
export function analyseBuffers(buffers) {
  const perImage = [];
  for (const buf of buffers) {
    try {
      const image = decodeImage(buf);
      const features = describe(image);
      const ranked = classifyFeatures(features);
      perImage.push({
        ok: true,
        width: image.width,
        height: image.height,
        features,
        top: ranked[0],
        ranked: ranked.slice(0, 4),
        hashes: perceptualHash(image)
      });
    } catch (err) {
      perImage.push({ ok: false, error: err.message });
    }
  }

  const good = perImage.filter((p) => p.ok);
  if (!good.length) {
    return { ok: false, error: 'No decodable images', perImage };
  }

  // average descriptors across angles
  const avg = {};
  for (const key of Object.keys(good[0].features)) {
    avg[key] = good.reduce((a, p) => a + p.features[key], 0) / good.length;
  }
  const ranked = classifyFeatures(avg);

  // agreement bonus: independent angles converging on the same class
  const votes = {};
  for (const p of good) votes[p.top.category] = (votes[p.top.category] || 0) + 1;
  const agreement = (votes[ranked[0].category] || 0) / good.length;

  const margin = ranked[0].probability - (ranked[1]?.probability ?? 0);
  const visionConfidence = clamp01(
    ranked[0].probability * 0.55 + margin * 1.5 + agreement * 0.25
  );

  return {
    ok: true,
    features: avg,
    ranked,
    agreement: +agreement.toFixed(2),
    angles: good.length,
    visionConfidence: +visionConfidence.toFixed(3),
    perImage
  };
}

export default { analyseBuffers, decodeImage, describe, classifyFeatures, perceptualHash, hamming, phashDistance };
