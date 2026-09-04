/**
 * CLIP zero-shot classifier (browser build).
 *
 * Loads the same CLIP ViT-B/32 model the Node backend uses, straight into the
 * browser via Transformers.js + ONNX Runtime Web. No server, no API key: the
 * model is downloaded once (~40 MB, quantised) and cached by the browser, then
 * every classification runs locally on the visitor's own machine.
 *
 * Prompts come from the SAME prompts.js file the backend uses.
 */
import { PROMPTS, buildLabelSet, aggregate, MODEL_ID, MIN_CIVIC_SHARE } from './prompts.js?v=20260905d';

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const { labels, owner } = buildLabelSet();

let pipe = null;
let loading = null;
let failed = null;
const progressListeners = new Set();

export function onModelProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); }
const report = (info) => { for (const fn of progressListeners) { try { fn(info); } catch { /* ignore */ } } };

export function modelState() {
  return { model: MODEL_ID, loaded: Boolean(pipe), loading: Boolean(loading), error: failed };
}

/** Kick off the download. Safe to call repeatedly; resolves to null on failure. */
export function loadModel() {
  if (pipe) return Promise.resolve(pipe);
  if (failed) return Promise.resolve(null);
  if (loading) return loading;

  loading = (async () => {
    try {
      report({ status: 'starting', progress: 0 });
      const { pipeline, env } = await import(/* @vite-ignore */ CDN);
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const p = await pipeline('zero-shot-image-classification', MODEL_ID, {
        progress_callback: (info) => {
          if (info.status === 'progress' && info.total) {
            report({ status: 'downloading', progress: Math.round((info.loaded / info.total) * 100), file: info.file });
          } else if (info.status === 'ready' || info.status === 'done') {
            report({ status: 'ready', progress: 100 });
          }
        }
      });
      pipe = p;
      report({ status: 'ready', progress: 100 });
      return p;
    } catch (err) {
      failed = err.message;
      report({ status: 'error', error: err.message });
      console.warn('[CivicPulse] CLIP unavailable, falling back to the colour engine:', err);
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/**
 * Classify one or more photos (data URLs) of the same issue.
 * Returns per-category probabilities averaged over the supplied angles.
 */
export async function clipClassify(sources) {
  const model = await loadModel();
  if (!model) return null;

  const started = performance.now();
  const perImage = [];
  for (const src of sources) {
    try {
      const out = await model(src, labels);
      perImage.push(aggregate(out, owner));
    } catch { /* skip an unreadable angle */ }
  }
  if (!perImage.length) return null;

  const scores = {};
  for (const c of Object.keys(PROMPTS)) {
    scores[c] = perImage.reduce((a, s) => a + (s[c] || 0), 0) / perImage.length;
  }
  const nonCivic = scores._NONE || 0;
  delete scores._NONE;

  // Before renormalising, ask the question that actually matters for a random
  // photo: did the "not a civic issue" prompts outscore every civic category?
  const topCivicRaw = Math.max(...Object.values(scores), 0);
  const belowFloor = topCivicRaw < MIN_CIVIC_SHARE;
  const nonCivicWins = nonCivic > topCivicRaw || belowFloor;
  const civicMargin = +(topCivicRaw - nonCivic).toFixed(4);

  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const ranked = Object.entries(scores)
    .map(([category, s]) => ({ category, probability: +(s / total).toFixed(4) }))
    .sort((a, b) => b.probability - a.probability);

  const votes = perImage.map((s) => Object.entries(s).filter(([k]) => k !== '_NONE').sort((a, b) => b[1] - a[1])[0]?.[0]);
  const agreement = votes.filter((v) => v === ranked[0].category).length / votes.length;

  return {
    ok: true, model: MODEL_ID, ranked, scores,
    nonCivic: +nonCivic.toFixed(4),
    nonCivicWins,
    belowFloor,
    minCivicShare: MIN_CIVIC_SHARE,
    civicMargin,
    topCivicRaw: +topCivicRaw.toFixed(4),
    agreement: +agreement.toFixed(2),
    angles: perImage.length,
    ms: Math.round(performance.now() - started)
  };
}

/** How strongly does this image still look like the given category? */
export async function categoryScore(src, category) {
  const model = await loadModel();
  if (!model || !PROMPTS[category]) return null;
  try {
    const out = await model(src, labels);
    return aggregate(out, owner)[category] ?? 0;
  } catch { return null; }
}
