/**
 * CivicPulse AI decision layer.
 *
 * Fuses up to four independent signals into one auditable verdict:
 *   1. CLIP zero-shot vision  (clip.js)       - primary, a real trained model
 *   2. hosted vision model    (remote.js)     - optional, if an API key is set
 *   3. CivicVision colour/texture engine      - fallback + closure metrics
 *   4. citizen text NLP       (nlp.js)
 *
 * Output drives: category, severity, department routing, SLA, duplicate keys,
 * human-review flags and the alert pushed to the owning department.
 */
import config from '../../config.js';
import { CATEGORIES, categoryMeta, SEVERITY_LABELS } from './taxonomy.js';
import { analyseBuffers, decodeImage, describe, perceptualHash, phashDistance } from './heuristic.js';
import { classifyText, urgencyScore } from './nlp.js';
import { remoteAnalyse, remoteStatus } from './remote.js';
import { clipClassify, categoryScore, clipStatus, warmup } from './clip.js';
import { ocrStatus, warmupOcr } from './address.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Weighted fusion over any number of ranked signals.
 * @param {{ranked: {category, probability|score}[], weight: number}[]} signals
 */
function fuse(signals) {
  const combined = {};
  for (const { ranked, weight } of signals) {
    if (!ranked || !weight) continue;
    for (const r of ranked) {
      const p = r.probability ?? r.score ?? 0;
      combined[r.category] = (combined[r.category] || 0) + p * weight;
    }
  }
  const total = Object.values(combined).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(combined)
    .map(([category, s]) => ({ category, score: +(s / total).toFixed(4) }))
    .sort((a, b) => b.score - a.score);
}

function severityModel({ category, features, urgency, remote, duplicateCount }) {
  const meta = categoryMeta(category);
  let sev = remote?.severity ?? meta.baseSeverity;

  if (features) {
    if (category === 'POTHOLE' && features.darkPatchRatio > 0.45) sev += 1;
    if (category === 'MANHOLE' && features.darkPatchRatio > 0.35) sev += 1;
    if (category === 'GARBAGE' && features.textureChaos > 0.7) sev += 1;
    if (category === 'STREETLIGHT' && features.nightRatio > 0.5) sev += 1;
    if ((category === 'SEWAGE' || category === 'STAGNANT_WATER') && features.specularRatio > 0.4) sev += 1;
  }
  sev += urgency.score >= 0.6 ? 1 : 0;
  if (duplicateCount >= 3) sev += 1;
  if (duplicateCount >= 8) sev += 1;
  return clamp(Math.round(sev), 1, 5);
}

function narrate(category, features, severity, angles, clip) {
  const meta = categoryMeta(category);
  if (clip) {
    const pct = Math.round((clip.ranked[0]?.probability || 0) * 100);
    return `The vision model recognised ${meta.label.toLowerCase()} in ${angles} photo angle${angles > 1 ? 's' : ''} (${pct}% match against the civic issue prompt set). Assessed severity: ${SEVERITY_LABELS[severity]}.`;
  }
  const cues = [];
  if (features.darkPatchRatio > 0.3) cues.push('a distinct dark cavity in the surface');
  if (features.asphaltRatio > 0.4) cues.push('road/asphalt surroundings');
  if (features.textureChaos > 0.6) cues.push('scattered heterogeneous material');
  if (features.greenRatio > 0.45) cues.push('heavy vegetation coverage');
  if (features.specularRatio > 0.35) cues.push('standing/reflective water');
  if (features.verticalStructure > 0.4) cues.push('a tall vertical pole structure');
  if (features.nightRatio > 0.45) cues.push('a low-light scene');
  const detail = cues.length ? cues.slice(0, 3).join(', ') : 'the dominant colour and texture profile';
  return `Detected ${meta.label.toLowerCase()} across ${angles} photo angle${angles > 1 ? 's' : ''} from ${detail}. Assessed severity: ${SEVERITY_LABELS[severity]}.`;
}

/**
 * Main entry point used by the report pipeline.
 * @param {Buffer[]} buffers  1..4 photos of the same issue
 * @param {string}   description citizen text (optional)
 * @param {object}   context  { duplicateCount }
 */
export async function analyseIssue(buffers, description = '', context = {}) {
  const started = Date.now();

  // colour/texture engine: always runs, supplies severity cues + hashes
  const vision = analyseBuffers(buffers);
  if (!vision.ok) return { ok: false, error: vision.error || 'Unable to read the uploaded photos.' };

  const text = classifyText(description);
  const urgency = urgencyScore(description);

  const [clip, remote] = await Promise.all([
    clipClassify(buffers).catch(() => null),
    remoteAnalyse(buffers, description).catch(() => null)
  ]);

  // CLIP is the primary signal when available; the colour engine drops to a
  // supporting role because it is unreliable on real-world photography.
  const signals = [];
  if (clip) {
    signals.push({ ranked: clip.ranked, weight: remote ? 0.42 : 0.62 });
    signals.push({ ranked: vision.ranked, weight: 0.10 });
  } else {
    signals.push({ ranked: vision.ranked, weight: remote ? 0.34 : 0.62 });
  }
  if (remote) {
    signals.push({ ranked: [{ category: remote.category, probability: remote.confidence }], weight: clip ? 0.32 : 0.50 });
    if (remote.alternate) signals.push({ ranked: [{ category: remote.alternate, probability: remote.confidence * 0.25 }], weight: clip ? 0.32 : 0.50 });
  }
  if (text.hasSignal) {
    signals.push({ ranked: text.ranked, weight: clip ? 0.26 : 0.38 });
  }

  const fused = fuse(signals);
  const category = fused[0].category;
  const meta = categoryMeta(category);

  const margin = fused[0].score - (fused[1]?.score ?? 0);
  const textAgrees = text.hasSignal && text.ranked[0]?.category === category;
  const clipAgrees = clip && clip.ranked[0]?.category === category;
  const remoteAgrees = remote && remote.category === category;

  let confidence = clamp(
    fused[0].score * 0.55 + margin * 1.2 +
    (clip ? clip.agreement * 0.15 : vision.agreement * 0.15) +
    (textAgrees ? 0.10 : 0) + (clipAgrees ? 0.15 : 0) + (remoteAgrees ? 0.18 : 0),
    0.05, 0.99
  );
  if (remote) confidence = Math.max(confidence, remote.confidence * 0.85);

  // Does this even look like a civic issue? _NONE winning means "probably not".
  const civicScore = clip ? 1 - clamp(clip.nonCivic, 0, 1) : null;
  const looksNonCivic = clip ? clip.nonCivicWins : false;
  if (looksNonCivic) confidence *= 0.6;

  const severity = severityModel({
    category, features: vision.features, urgency, remote,
    duplicateCount: context.duplicateCount || 0
  });

  const engine = clip
    ? (remote ? 'CLIP vision model + hosted model + text NLP' : 'CLIP zero-shot vision model + text NLP')
    : (remote ? 'hosted model + CivicVision cross-check' : 'CivicVision colour engine (CLIP unavailable)');

  return {
    ok: true,
    engine,
    provider: clip ? 'clip-local' : remote?.provider || 'onboard',
    model: clip?.model || remote?.model || 'civicvision-v1',
    category,
    categoryLabel: meta.label,
    icon: meta.icon,
    confidence: +confidence.toFixed(3),
    severity,
    severityLabel: SEVERITY_LABELS[severity],
    departmentId: meta.department,
    slaHours: meta.slaHours,
    summary: remote?.summary || narrate(category, vision.features, severity, vision.angles, clip),
    objects: remote?.objects || [],
    hazards: remote?.hazards || [],
    evidence: vision.ranked.find((r) => r.category === category)?.evidence || [],
    visionModel: clip ? {
      name: clip.model,
      topMatches: clip.ranked.slice(0, 4).map((r) => ({ category: r.category, label: categoryMeta(r.category).label, probability: r.probability })),
      civicScore: +(civicScore ?? 0).toFixed(3),
      agreement: clip.agreement,
      ms: clip.ms
    } : null,
    alternates: fused.slice(1, 4).map((f) => ({
      category: f.category, label: categoryMeta(f.category).label, score: f.score
    })),
    textSignal: { matched: text.ranked[0]?.matched || [], agrees: textAgrees, strength: +text.strength.toFixed(2) },
    urgencyCues: urgency.cues,
    angles: vision.angles,
    agreement: clip?.agreement ?? vision.agreement,
    features: vision.features,
    hashes: vision.perImage.filter((p) => p.ok).map((p) => p.hashes),
    looksNonCivic,
    civicMargin: clip ? clip.civicMargin : null,
    nonCivicScore: clip ? clip.nonCivic : null,
    needsHumanReview: confidence < config.ai.confidenceThreshold || looksNonCivic || (remote && !remote.isCivicIssue),
    processingMs: Date.now() - started
  };
}

/** Are these photos genuinely different viewpoints of the same subject? */
export function angleDiversity(hashes) {
  if (hashes.length < 2) return { distinct: hashes.length, minDistance: null, ok: true, note: 'Single angle submitted.' };
  let min = Infinity;
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) min = Math.min(min, phashDistance(hashes[i], hashes[j]));
  }
  const ok = min >= config.policy.minAngleDistance;
  return {
    distinct: hashes.length,
    minDistance: min === Infinity ? null : min,
    ok,
    note: ok
      ? `${hashes.length} genuinely distinct viewpoints (min perceptual distance ${min}).`
      : `Photos look near-identical (distance ${min}). Capture the issue from a different angle.`
  };
}

/**
 * Resolution verification.
 * Three independent checks on the worker's closure evidence:
 *   a) recycled evidence - is an "after" photo the same frame as a "before" one?
 *   b) does the vision model still SEE the defect in the after photos?
 *   c) category-aware pixel metrics (cavity area, clutter, standing water ...)
 */
export async function verifyResolution({ beforeBuffers, afterBuffers, category }) {
  const decode = (b) => {
    const img = decodeImage(b);
    return { features: describe(img), hashes: perceptualHash(img) };
  };
  const before = beforeBuffers.map(decode);
  const after = afterBuffers.map(decode);
  const mean = (arr, key) => arr.reduce((a, x) => a + x.features[key], 0) / arr.length;

  let minCross = Infinity;
  for (const a of after) {
    for (const b of before) minCross = Math.min(minCross, phashDistance(a.hashes, b.hashes));
  }
  const recycled = minCross <= 5;
  const diversity = angleDiversity(after.map((a) => a.hashes));

  const metrics = [];
  const push = (label, beforeVal, afterVal, betterWhen) => {
    const delta = afterVal - beforeVal;
    const improved = betterWhen === 'lower' ? delta < -0.04 : delta > 0.04;
    metrics.push({ label, before: +beforeVal.toFixed(3), after: +afterVal.toFixed(3), delta: +delta.toFixed(3), improved });
    return improved;
  };
  let checks = 0, improvements = 0;
  const track = (ok) => { checks++; if (ok) improvements++; };

  // (b) the strongest signal: has the defect stopped being recognisable?
  let defectGone = null;
  try {
    const beforeScores = await Promise.all(beforeBuffers.slice(0, 2).map((b) => categoryScore(b, category)));
    const afterScores = await Promise.all(afterBuffers.slice(0, 2).map((b) => categoryScore(b, category)));
    const valid = (arr) => arr.filter((n) => typeof n === 'number');
    const bv = valid(beforeScores), av = valid(afterScores);
    if (bv.length && av.length) {
      const b = bv.reduce((x, y) => x + y, 0) / bv.length;
      const a = av.reduce((x, y) => x + y, 0) / av.length;
      defectGone = { before: +b.toFixed(3), after: +a.toFixed(3), drop: +(b - a).toFixed(3) };
      const improved = a < b * 0.6;
      metrics.push({
        label: `Vision model still sees "${categoryMeta(category).label}"`,
        before: defectGone.before, after: defectGone.after, delta: -defectGone.drop, improved
      });
      track(improved);
      track(improved); // weighted double: this is the most meaningful check
    }
  } catch { /* model unavailable - fall back to pixel metrics alone */ }

  // (c) pixel metrics
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
  if (recycled) notes.push('REJECTED: an "after" photo is a near-duplicate of a "before" photo (recycled evidence).');
  if (!diversity.ok) notes.push(`WARNING: ${diversity.note}`);
  if (defectGone && defectGone.after >= defectGone.before * 0.6) {
    notes.push(`The vision model still recognises the original defect in the "after" photos (${defectGone.before} → ${defectGone.after}).`);
  }
  if (improvementScore === 0) notes.push('No measurable visual improvement detected between before and after evidence.');
  if (improvementScore >= 0.5 && !recycled) notes.push('Measurable visual improvement confirmed by CivicPulse.');

  return {
    verified: !recycled && improvementScore >= 0.5,
    recycledEvidence: recycled,
    crossDistance: minCross === Infinity ? null : minCross,
    improvementScore: +improvementScore.toFixed(2),
    defectGone,
    angleDiversity: diversity,
    metrics,
    notes,
    afterHashes: after.map((a) => a.hashes)
  };
}

export function aiStatus() {
  return {
    vision: clipStatus(),
    ocr: ocrStatus(),
    onboard: { engine: 'civicvision-v1', categories: Object.keys(CATEGORIES).length, available: true },
    remote: remoteStatus(),
    confidenceThreshold: config.ai.confidenceThreshold
  };
}

export function warmupAll() {
  warmup();
  warmupOcr();
}

export { warmup as warmupVision };
export default { analyseIssue, verifyResolution, angleDiversity, aiStatus };
