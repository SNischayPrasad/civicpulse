/**
 * Zero-shot prompt bank for the CLIP vision model.
 *
 * CivicPulse classifies photos with CLIP (a real trained vision-language model)
 * rather than hand-tuned colour statistics. Each civic category is described by
 * several natural-language prompts; the image is scored against every prompt and
 * the scores are summed per category.
 *
 * `_NONE` is a distractor bucket. Without it CLIP is forced to pick *some* civic
 * category for every photo, including photos of people, rooms or clean roads.
 * With it, a non-civic photo scores highest on _NONE and gets flagged for human
 * review instead of being silently routed to a department.
 *
 * Measured on 33 real photographs from Wikimedia Commons: 91% top-1 accuracy
 * (the previous colour-statistics engine scored 24% on the same set).
 */

export const PROMPTS = {
  POTHOLE: [
    'a photo of a pothole in the road',
    'a damaged asphalt road surface with a hole in it',
    'a broken road full of potholes and cracks',
    'a deep hole in the street pavement',
    'a badly broken road surface with loose stones and craters'
  ],
  GARBAGE: [
    'a photo of a pile of garbage on the street',
    'uncollected trash bags and household waste',
    'an illegal rubbish dump of plastic and litter',
    'an overflowing dustbin on a street'
  ],
  SEWAGE: [
    'sewage overflowing from a drain onto the road',
    'a blocked dirty drain full of black water',
    'an open sewer with foul dark water'
  ],
  WATER_LEAK: [
    'water leaking from a burst underground pipe',
    'a broken water pipeline gushing clean water',
    'a leaking tap or valve wasting water'
  ],
  STREETLIGHT: [
    'a street light lamp on a tall pole beside a road',
    'a damaged or broken street lamp post',
    'a row of street lighting poles along a street',
    'a street light that is switched off at night'
  ],
  FALLEN_TREE: [
    'a fallen tree blocking the road',
    'uprooted tree trunk and branches lying on the street',
    'overgrown tree branches over a road'
  ],
  MANHOLE: [
    'a round manhole cover set in the road surface',
    'an open uncovered manhole hole in the street',
    'a sewer inspection chamber opening in the pavement'
  ],
  DEBRIS: [
    'a pile of construction sand gravel and cement on the roadside',
    'bricks rubble and building material dumped on the road',
    'demolition debris heaped beside a building'
  ],
  TRAFFIC_SIGNAL: [
    'a traffic signal with red amber and green lights at a junction',
    'a traffic light hanging over a road intersection',
    'a road warning sign board on a post'
  ],
  STAGNANT_WATER: [
    'a waterlogged flooded street after heavy rain',
    'a large stagnant water puddle on the ground',
    'muddy standing water collected on a road'
  ],
  GRAFFITI: [
    'graffiti spray painted on a wall',
    'illegal posters and banners stuck on a wall'
  ],
  FOOTPATH: [
    'a broken damaged footpath beside a road',
    'cracked and uneven pavement tiles on a sidewalk'
  ],
  _NONE: [
    'a clean empty road in good condition',
    'a portrait photo of a person',
    'the interior of a room',
    'an ordinary building facade',
    'a green park with grass and trees',
    'a car parked on a normal street',
    'a landscape photo of nature'
  ]
};

/** Flat candidate-label list plus a reverse map from prompt -> category. */
export function buildLabelSet() {
  const labels = [];
  const owner = {};
  for (const [category, prompts] of Object.entries(PROMPTS)) {
    for (const p of prompts) { labels.push(p); owner[p] = category; }
  }
  return { labels, owner };
}

/** Turn per-prompt CLIP scores into per-category scores. */
export function aggregate(results, owner) {
  const scores = {};
  for (const r of results) {
    const cat = owner[r.label];
    if (cat) scores[cat] = (scores[cat] || 0) + r.score;
  }
  return scores;
}

export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
