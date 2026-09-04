/**
 * Lightweight NLP layer for the citizen's description.
 * Token overlap + phrase matching against taxonomy keywords, plus urgency and
 * hazard cue detection that feeds the severity model.
 */
import { CATEGORIES, CATEGORY_KEYS } from './taxonomy.js';

const URGENCY_CUES = [
  ['accident', 2], ['injured', 2], ['injury', 2], ['fell', 1.5], ['danger', 1.5], ['dangerous', 1.5],
  ['child', 1.5], ['children', 1.5], ['school', 1], ['hospital', 1.5], ['emergency', 2],
  ['blocked', 1], ['overflow', 1.5], ['flooded', 1.5], ['flooding', 1.5], ['burst', 1.5],
  ['electric', 1.5], ['shock', 2], ['live wire', 2.5], ['fire', 2.5], ['collapse', 2],
  ['week', 0.8], ['month', 1.2], ['months', 1.5], ['repeatedly', 1.2], ['again', 0.8],
  ['many people', 1], ['main road', 1], ['highway', 1], ['night', 0.6], ['deep', 1.2],
  ['huge', 1], ['large', 0.8], ['big', 0.6], ['smell', 0.8], ['stink', 1], ['disease', 1.5],
  ['mosquito', 1], ['dengue', 1.8], ['malaria', 1.8]
];

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'in', 'on', 'at', 'of', 'and', 'to', 'for',
  'this', 'that', 'there', 'here', 'it', 'was', 'were', 'has', 'have', 'been', 'near', 'from',
  'with', 'my', 'our', 'we', 'i', 'please', 'kindly', 'sir', 'madam', 'very', 'so', 'not']);

export function tokenize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** Returns ranked categories from free text, plus matched terms for explainability. */
export function classifyText(text = '') {
  const lower = String(text).toLowerCase();
  const tokens = new Set(tokenize(text));
  const scores = {};
  const matched = {};

  for (const key of CATEGORY_KEYS) {
    let score = 0;
    const hits = [];
    for (const kw of CATEGORIES[key].keywords) {
      if (kw.includes(' ')) {
        if (lower.includes(kw)) { score += 2.4; hits.push(kw); }
      } else if (tokens.has(kw)) {
        score += 1.6; hits.push(kw);
      } else if (lower.includes(kw)) {
        score += 0.9; hits.push(kw);
      }
    }
    scores[key] = score;
    matched[key] = hits;
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const ranked = CATEGORY_KEYS
    .map((key) => ({
      category: key,
      probability: total > 0 ? +(scores[key] / total).toFixed(4) : 0,
      matched: matched[key]
    }))
    .sort((a, b) => b.probability - a.probability);

  return { ranked, strength: Math.min(1, total / 5), hasSignal: total > 0 };
}

/** Urgency multiplier (0..1) derived from hazard cues in the description. */
export function urgencyScore(text = '') {
  const lower = String(text).toLowerCase();
  let score = 0;
  const cues = [];
  for (const [cue, weight] of URGENCY_CUES) {
    if (lower.includes(cue)) { score += weight; cues.push(cue); }
  }
  return { score: Math.min(1, score / 6), cues };
}

export default { classifyText, urgencyScore, tokenize };
