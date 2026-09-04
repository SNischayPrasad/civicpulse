/**
 * CivicPulse issue taxonomy.
 * Each category carries: the owning department, an SLA, NLP keywords, and a
 * visual signature used by the on-board CivicVision engine.
 *
 * `visual` weights are applied to normalised image features (0..1) produced by
 * heuristic.js. Positive weight = evidence for, negative = evidence against.
 */

export const DEPARTMENTS = [
  { id: 'dept_roads',    code: 'ROADS',    name: 'Roads & Infrastructure',       email: 'roads@city.gov.in',    phone: '+91-80-2222-1001', color: '#f59e0b' },
  { id: 'dept_sanit',    code: 'SANIT',    name: 'Sanitation & Solid Waste',     email: 'swm@city.gov.in',      phone: '+91-80-2222-1002', color: '#22c55e' },
  { id: 'dept_water',    code: 'WATER',    name: 'Water Supply & Sewerage',      email: 'water@city.gov.in',    phone: '+91-80-2222-1003', color: '#38bdf8' },
  { id: 'dept_power',    code: 'POWER',    name: 'Electrical & Street Lighting', email: 'power@city.gov.in',    phone: '+91-80-2222-1004', color: '#eab308' },
  { id: 'dept_parks',    code: 'PARKS',    name: 'Parks & Horticulture',         email: 'parks@city.gov.in',    phone: '+91-80-2222-1005', color: '#10b981' },
  { id: 'dept_traffic',  code: 'TRAFFIC',  name: 'Traffic & Transport',          email: 'traffic@city.gov.in',  phone: '+91-80-2222-1006', color: '#a78bfa' },
  { id: 'dept_health',   code: 'HEALTH',   name: 'Public Health',                email: 'health@city.gov.in',   phone: '+91-80-2222-1007', color: '#f472b6' },
  { id: 'dept_planning', code: 'PLANNING', name: 'Building & Town Planning',     email: 'planning@city.gov.in', phone: '+91-80-2222-1008', color: '#94a3b8' }
];

export const CATEGORIES = {
  POTHOLE: {
    label: 'Pothole / Road Surface Damage',
    department: 'dept_roads', slaHours: 48, baseSeverity: 3, icon: 'pothole',
    keywords: ['pothole', 'gaddha', 'road damage', 'crater', 'broken road', 'bumpy', 'asphalt', 'tar', 'road surface', 'pit', 'hole in road'],
    visual: { asphaltRatio: 2.4, darkPatchRatio: 2.2, edgeEnergy: 1.1, greenRatio: -1.4, skyRatio: -0.9, saturation: -1.0, verticalStructure: -0.7, nightRatio: -1.0 },
    contractorWork: ['road', 'asphalt', 'resurfacing', 'highway']
  },
  GARBAGE: {
    label: 'Garbage Dump / Uncollected Waste',
    department: 'dept_sanit', slaHours: 24, baseSeverity: 3, icon: 'garbage',
    keywords: ['garbage', 'trash', 'waste', 'kachra', 'dump', 'litter', 'rubbish', 'bin overflow', 'dustbin', 'smell', 'stink', 'plastic'],
    visual: { colourVariance: 2.6, edgeEnergy: 1.9, saturation: 1.1, textureChaos: 2.2, asphaltRatio: -0.6, skyRatio: -0.8 },
    contractorWork: ['waste', 'sanitation', 'cleaning']
  },
  SEWAGE: {
    label: 'Sewage Overflow / Blocked Drain',
    department: 'dept_water', slaHours: 12, baseSeverity: 4, icon: 'sewage',
    keywords: ['sewage', 'drain', 'drainage', 'manhole overflow', 'gutter', 'blocked', 'stagnant', 'sewer', 'dirty water', 'foul'],
    visual: { darkPatchRatio: 1.6, brownRatio: 2.4, specularRatio: 1.5, saturation: -0.5, greenRatio: -0.5, textureChaos: 0.8 },
    contractorWork: ['sewer', 'drain', 'sewerage', 'pipeline']
  },
  WATER_LEAK: {
    label: 'Water Pipeline Leak / Burst',
    department: 'dept_water', slaHours: 8, baseSeverity: 4, icon: 'water',
    keywords: ['leak', 'water leak', 'pipeline burst', 'pipe burst', 'water wastage', 'flowing water', 'tap', 'valve', 'seepage'],
    visual: { specularRatio: 2.6, blueRatio: 1.6, brightness: 1.0, asphaltRatio: 0.6, brownRatio: -0.6, textureChaos: -0.5 },
    contractorWork: ['water', 'pipeline', 'plumbing']
  },
  STREETLIGHT: {
    label: 'Street Light Not Working / Damaged Pole',
    department: 'dept_power', slaHours: 36, baseSeverity: 2, icon: 'light',
    keywords: ['street light', 'streetlight', 'lamp', 'pole', 'dark street', 'no light', 'bulb', 'lighting', 'night'],
    visual: { verticalStructure: 2.6, skyRatio: 1.7, nightRatio: 1.5, edgeEnergy: -0.4, textureChaos: -1.0, asphaltRatio: -0.4 },
    contractorWork: ['electrical', 'lighting', 'power']
  },
  FALLEN_TREE: {
    label: 'Fallen Tree / Overgrown Branches',
    department: 'dept_parks', slaHours: 24, baseSeverity: 3, icon: 'tree',
    keywords: ['tree', 'branch', 'fallen', 'overgrown', 'bush', 'foliage', 'trimming', 'uprooted', 'plantation'],
    visual: { greenRatio: 3.0, textureChaos: 1.4, brownRatio: 0.9, asphaltRatio: -1.0, verticalStructure: 0.5 },
    contractorWork: ['horticulture', 'landscaping', 'tree']
  },
  MANHOLE: {
    label: 'Open / Damaged Manhole',
    department: 'dept_water', slaHours: 6, baseSeverity: 5, icon: 'manhole',
    keywords: ['manhole', 'open cover', 'missing cover', 'chamber', 'shaft', 'uncovered', 'circular hole'],
    visual: { darkPatchRatio: 2.8, circularity: 2.4, asphaltRatio: 1.4, greenRatio: -1.0, saturation: -0.9, nightRatio: -1.6, verticalStructure: -0.8 },
    contractorWork: ['sewer', 'drain', 'road']
  },
  DEBRIS: {
    label: 'Construction Debris / Malba on Road',
    department: 'dept_planning', slaHours: 36, baseSeverity: 3, icon: 'debris',
    keywords: ['debris', 'malba', 'construction waste', 'sand', 'gravel', 'cement', 'bricks', 'rubble', 'building material'],
    visual: { greyRatio: 2.1, textureChaos: 1.7, brownRatio: 1.2, saturation: -1.0, greenRatio: -0.8 },
    contractorWork: ['construction', 'building', 'civil']
  },
  TRAFFIC_SIGNAL: {
    label: 'Traffic Signal / Signage Fault',
    department: 'dept_traffic', slaHours: 12, baseSeverity: 4, icon: 'signal',
    keywords: ['signal', 'traffic light', 'signage', 'zebra crossing', 'divider', 'road marking', 'junction', 'sign board'],
    visual: { verticalStructure: 2.2, saturation: 1.4, skyRatio: 1.2, colourVariance: 1.0, greenRatio: -0.5 },
    contractorWork: ['traffic', 'signage', 'electrical']
  },
  STAGNANT_WATER: {
    label: 'Stagnant Water / Mosquito Breeding',
    department: 'dept_health', slaHours: 24, baseSeverity: 4, icon: 'mosquito',
    keywords: ['stagnant', 'mosquito', 'dengue', 'breeding', 'still water', 'puddle', 'waterlogged', 'water logging', 'algae'],
    visual: { specularRatio: 1.8, greenRatio: 1.2, brownRatio: 1.0, blueRatio: 0.9, textureChaos: -0.6 },
    contractorWork: ['sanitation', 'health', 'drain']
  },
  GRAFFITI: {
    label: 'Defacement / Illegal Posters',
    department: 'dept_planning', slaHours: 72, baseSeverity: 1, icon: 'graffiti',
    keywords: ['graffiti', 'poster', 'defaced', 'wall writing', 'banner', 'hoarding', 'illegal advertisement', 'paint'],
    visual: { saturation: 2.2, colourVariance: 1.7, flatSurface: 1.6, greenRatio: -0.6, asphaltRatio: -0.6 },
    contractorWork: ['maintenance', 'painting']
  },
  FOOTPATH: {
    label: 'Damaged Footpath / Kerb',
    department: 'dept_roads', slaHours: 72, baseSeverity: 2, icon: 'footpath',
    keywords: ['footpath', 'sidewalk', 'pavement', 'kerb', 'curb', 'paver', 'tile broken', 'walkway'],
    visual: { greyRatio: 1.9, edgeEnergy: 1.5, flatSurface: 1.1, greenRatio: -0.7, skyRatio: -0.5 },
    contractorWork: ['road', 'civil', 'construction']
  }
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

export const SEVERITY_LABELS = {
  1: 'Cosmetic', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Critical'
};

export function categoryMeta(key) {
  return CATEGORIES[key] || {
    label: 'Unclassified Civic Issue',
    department: 'dept_planning',
    slaHours: 72,
    baseSeverity: 2,
    icon: 'unknown',
    keywords: [],
    visual: {},
    contractorWork: []
  };
}

export function departmentFor(categoryKey) {
  return categoryMeta(categoryKey).department;
}

export default { DEPARTMENTS, CATEGORIES, CATEGORY_KEYS, categoryMeta, departmentFor, SEVERITY_LABELS };
