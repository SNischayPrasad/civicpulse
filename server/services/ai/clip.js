/**
 * CLIP zero-shot classifier (server build).
 *
 * This is the primary vision engine. It runs a real trained vision-language
 * model (CLIP ViT-B/32) locally through Transformers.js + ONNX Runtime - no API
 * key, no network calls after the first model download, no training data.
 *
 * The colour-statistics engine in heuristic.js is kept as a fallback for when
 * the model cannot be loaded, and its descriptors still power the before/after
 * closure verification.
 */
import { PROMPTS, buildLabelSet, aggregate, MODEL_ID } from './prompts.js';

const { labels, owner } = buildLabelSet();

let pipe = null;
let loading = null;
let failed = null;

/** Load once, share across requests. Safe to call repeatedly. */
export async function loadModel() {
  if (pipe) return pipe;
  if (failed) return null;
  if (loading) return loading;

  loading = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      const p = await pipeline('zero-shot-image-classification', MODEL_ID);
      pipe = p;
      return p;
    } catch (err) {
      failed = err.message;
      console.warn(`[CivicPulse] CLIP unavailable (${err.message}). Falling back to the on-board colour engine.`);
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** Warm the model up in the background so the first citizen report is fast. */
export function warmup() {
  loadModel().then((p) => {
    if (p) console.log(`[CivicPulse] CLIP vision model ready (${MODEL_ID})`);
  });
}

async function toImage(buffer) {
  const { RawImage } = await import('@huggingface/transformers');
  return RawImage.fromBlob(new Blob([buffer]));
}

/**
 * Classify one or more photos of the same issue.
 * Returns per-category probabilities averaged across the supplied angles.
 */
export async function clipClassify(buffers) {
  const model = await loadModel();
  if (!model) return null;

  const started = Date.now();
  const perImage = [];

  for (const buf of buffers) {
    try {
      const image = await toImage(buf);
      const out = await model(image, labels);
      perImage.push(aggregate(out, owner));
    } catch (err) {
      // one unreadable angle should not sink the whole report
    }
  }
  if (!perImage.length) return null;

  const categories = Object.keys(PROMPTS);
  const scores = {};
  for (const c of categories) {
    scores[c] = perImage.reduce((a, s) => a + (s[c] || 0), 0) / perImage.length;
  }

  const nonCivic = scores._NONE || 0;
  delete scores._NONE;

  // renormalise across civic categories only
  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const ranked = Object.entries(scores)
    .map(([category, s]) => ({ category, probability: +(s / total).toFixed(4) }))
    .sort((a, b) => b.probability - a.probability);

  // do the angles independently agree on the winner?
  const votes = perImage.map((s) => {
    const civic = Object.entries(s).filter(([k]) => k !== '_NONE');
    return civic.sort((a, b) => b[1] - a[1])[0]?.[0];
  });
  const agreement = votes.filter((v) => v === ranked[0].category).length / votes.length;

  return {
    ok: true,
    model: MODEL_ID,
    ranked,
    scores,
    nonCivic: +nonCivic.toFixed(4),
    agreement: +agreement.toFixed(2),
    angles: perImage.length,
    ms: Date.now() - started
  };
}

/**
 * How strongly does one image still look like the given category?
 * Used to check that a repair actually removed the defect.
 */
export async function categoryScore(buffer, category) {
  const model = await loadModel();
  if (!model || !PROMPTS[category]) return null;
  try {
    const image = await toImage(buffer);
    const out = await model(image, labels);
    const scores = aggregate(out, owner);
    return scores[category] ?? 0;
  } catch {
    return null;
  }
}

export const clipStatus = () => ({
  model: MODEL_ID,
  loaded: Boolean(pipe),
  error: failed
});

export default { clipClassify, categoryScore, loadModel, warmup, clipStatus };
