/**
 * CivicPulse AI decision layer.
 *
 * Fuses three independent signals into one auditable verdict:
 *   1. hosted vision model   (remote.js, optional)
 *   2. on-board CivicVision  (heuristic.js, always available)
 *   3. citizen text NLP      (nlp.js)
 *
 * Output drives: category, severity, department routing, SLA, duplicate keys,
 * human-review flags and the alert that is pushed to the owning department.
 */
import config from '../../config.js';
import { CATEGORIES, categoryMeta, SEVERITY_LABELS } from './taxonomy.js';
import { analyseBuffers, decodeImage, describe, perceptualHash, phashDistance } from './heuristic.js';
import { classifyText, urgencyScore } from './nlp.js';
import { remoteAnalyse, remoteStatus } from './remote.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fuse(visionRanked, textRanked, textStrength, remote) {
  const combined = {};
  const wVision = remote ? 0.34 : 0.62;
  const wText = textStrength > 0 ? (remote ? 0.16 : 0.38) : 0;
  const wRemote = remote ? 0.5 : 0;

  for (const v of visionRanked) combined[v.category] = (combined[v.category] || 0) + v.probability * wVision;
  if (wText) for (const t of textRanked) combined[t.category] = (combined[t.category] || 0) + t.probability * wText;
  if (remote) {
    combined[remote.category] = (combined[remote.category] || 0) + remote.confidence * wRemote;
    if (remote.alternate) combined[remote.alternate] = (combined[remote.alternate] || 0) + remote.confidence * wRemote * 0.25;
  }

  const total = Object.values(combined).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(combined)
    .map(([category, s]) => ({ category, score: +(s / total).toFixed(4) }))
    .sort((a, b) => b.score - a.score);
}

function severityModel({ category, features, urgency, remote, duplicateCount }) {
  const meta = categoryMeta(category);
  let sev = remote?.severity ?? meta.baseSeverity;

  // visual aggravators
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

function narrate(category, features, severity, angles) {
  const meta = categoryMeta(category);
  const cues = [];
  if (features.darkPatchRatio > 0.3) cues.push('a distinct dark cavity in the surface');
  if (features.asphaltRatio > 0.4) cues.push('road/asphalt surroundings');
  if (features.textureChaos > 0.6) cues.push('scattered heterogeneous material');
  if (features.greenRatio > 0.45) cues.push('heavy vegetation coverage');
  if (features.specularRatio > 0.35) cues.push('standing/reflective water');
  if (features.verticalStructure > 0.4) cues.push('a tall vertical pole structure');
  if (features.nightRatio > 0.45) cues.push('a low-light scene');
  if (features.brownRatio > 0.45) cues.push('mud or sludge tones');
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

  const vision = analyseBuffers(buffers);
  if (!vision.ok) {
    return { ok: false, error: vision.error || 'Unable to read the uploaded photos.' };
  }

  const text = classifyText(description);
  const urgency = urgencyScore(description);

  let remote = null;
  try { remote = await remoteAnalyse(buffers, description); } catch { remote = null; }

  const fused = fuse(vision.ranked, text.ranked, text.strength, remote);
  const category = fused[0].category;
  const meta = categoryMeta(category);

  // confidence: fused margin, boosted by cross-signal agreement
  const margin = fused[0].score - (fused[1]?.score ?? 0);
  const textAgrees = text.hasSignal && text.ranked[0]?.category === category;
  const remoteAgrees = remote && remote.category === category;
  let confidence = clamp(
    fused[0].score * 0.55 + margin * 1.2 + vision.agreement * 0.15 +
    (textAgrees ? 0.12 : 0) + (remoteAgrees ? 0.22 : 0),
    0.05, 0.99
  );
  if (remote) confidence = Math.max(confidence, remote.confidence * 0.85);

  const severity = severityModel({
    category, features: vision.features, urgency, remote,
    duplicateCount: context.duplicateCount || 0
  });

  const evidence = vision.ranked[0]?.evidence?.length
    ? vision.ranked.find((r) => r.category === category)?.evidence || vision.ranked[0].evidence
    : [];

  return {
    ok: true,
    engine: remote ? (remoteAgrees ? 'hybrid (hosted + CivicVision)' : 'hosted model + CivicVision cross-check') : 'CivicVision on-board engine',
    provider: remote?.provider || 'onboard',
    model: remote?.model || 'civicvision-v1',
    category,
    categoryLabel: meta.label,
    icon: meta.icon,
    confidence: +confidence.toFixed(3),
    severity,
    severityLabel: SEVERITY_LABELS[severity],
    departmentId: meta.department,
    slaHours: meta.slaHours,
    summary: remote?.summary || narrate(category, vision.features, severity, vision.angles),
    objects: remote?.objects || [],
    hazards: remote?.hazards || [],
    evidence,
    alternates: fused.slice(1, 4).map((f) => ({
      category: f.category, label: categoryMeta(f.category).label, score: f.score
    })),
    textSignal: {
      matched: text.ranked[0]?.matched || [],
      agrees: textAgrees,
      strength: +text.strength.toFixed(2)
    },
    urgencyCues: urgency.cues,
    angles: vision.angles,
    agreement: vision.agreement,
    features: vision.features,
    hashes: vision.perImage.filter((p) => p.ok).map((p) => p.hashes),
    needsHumanReview: confidence < config.ai.confidenceThreshold || (remote && !remote.isCivicIssue),
    processingMs: Date.now() - started
  };
}

/** Are these photos genuinely different viewpoints of the same subject? */
export function angleDiversity(hashes) {
  if (hashes.length < 2) return { distinct: hashes.length, minDistance: null, ok: true, note: 'Single angle submitted.' };
  let min = Infinity;
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      min = Math.min(min, phashDistance(hashes[i], hashes[j]));
    }
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
 * Compares the worker's "after" photos with the "before" evidence to detect
 * (a) real improvement and (b) fake closure via re-uploaded / recycled images.
 */
export function verifyResolution({ beforeBuffers, afterBuffers, category }) {
  const decode = (b) => {
    const img = decodeImage(b);
    return { features: describe(img), hashes: perceptualHash(img) };
  };
  const before = beforeBuffers.map(decode);
  const after = afterBuffers.map(decode);

  const mean = (arr, key) => arr.reduce((a, x) => a + x.features[key], 0) / arr.length;

  // recycled-evidence check: an "after" photo nearly identical to a "before" one
  let minCross = Infinity;
  for (const a of after) {
    for (const b of before) {
      minCross = Math.min(minCross, phashDistance(a.hashes, b.hashes));
    }
  }
  // <= 5 bits apart means the "after" frame shows the same scene state as the
  // "before" frame: either the photo was recycled, or nothing actually changed.
  const recycled = minCross <= 5;

  const diversity = angleDiversity(after.map((a) => a.hashes));

  // category-aware improvement metrics
  const metrics = [];
  const push = (label, beforeVal, afterVal, betterWhen) => {
    const delta = afterVal - beforeVal;
    const improved = betterWhen === 'lower' ? delta < -0.04 : delta > 0.04;
    metrics.push({ label, before: +beforeVal.toFixed(3), after: +afterVal.toFixed(3), delta: +delta.toFixed(3), improved });
    return improved;
  };

  let improvements = 0, checks = 0;
  const track = (ok) => { checks++; if (ok) improvements++; };

  switch (category) {
    case 'POTHOLE':
    case 'MANHOLE':
    case 'FOOTPATH':
      track(push('Dark cavity area', mean(before, 'darkPatchRatio'), mean(after, 'darkPatchRatio'), 'lower'));
      track(push('Surface uniformity', mean(before, 'flatSurface'), mean(after, 'flatSurface'), 'higher'));
      break;
    case 'GARBAGE':
    case 'DEBRIS':
      track(push('Scattered clutter', mean(before, 'textureChaos'), mean(after, 'textureChaos'), 'lower'));
      track(push('Colour dispersion', mean(before, 'colourVariance'), mean(after, 'colourVariance'), 'lower'));
      break;
    case 'SEWAGE':
    case 'STAGNANT_WATER':
    case 'WATER_LEAK':
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
  if (improvementScore === 0) notes.push('No measurable visual improvement detected between before and after evidence.');
  if (improvementScore >= 0.5 && !recycled) notes.push('Measurable visual improvement confirmed by CivicVision.');

  const verified = !recycled && improvementScore >= 0.5;
  return {
    verified,
    recycledEvidence: recycled,
    crossDistance: minCross === Infinity ? null : minCross,
    improvementScore: +improvementScore.toFixed(2),
    angleDiversity: diversity,
    metrics,
    notes,
    afterHashes: after.map((a) => a.hashes)
  };
}

export function aiStatus() {
  return {
    onboard: { engine: 'civicvision-v1', categories: Object.keys(CATEGORIES).length, available: true },
    remote: remoteStatus(),
    confidenceThreshold: config.ai.confidenceThreshold
  };
}

export default { analyseIssue, verifyResolution, angleDiversity, aiStatus };
