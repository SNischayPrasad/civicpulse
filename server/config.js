import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

export const config = {
  port: num(process.env.PORT, 4000),
  env: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'civicpulse-dev-secret',
  jwtExpiry: '12h',

  paths: {
    root: ROOT,
    data: path.join(ROOT, 'data'),
    uploads: path.join(ROOT, 'uploads'),
    public: path.join(ROOT, 'public')
  },

  ai: {
    provider: (process.env.AI_PROVIDER || 'auto').toLowerCase(),
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: (process.env.AI_BASE_URL || '').replace(/\/$/, ''),
    model: process.env.AI_MODEL || '',
    confidenceThreshold: num(process.env.AI_CONFIDENCE_THRESHOLD, 0.55),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 25000)
  },

  geo: {
    reverseGeocode: bool(process.env.ENABLE_REVERSE_GEOCODE, true),
    osmContractors: bool(process.env.ENABLE_OSM_CONTRACTORS, true),
    nominatim: (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    overpass: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
    userAgent: 'CivicPulse/1.0 (SIH25031 prototype)'
  },

  policy: {
    minPhotos: num(process.env.MIN_PHOTOS, 1),
    maxPhotos: num(process.env.MAX_PHOTOS, 4),
    duplicateRadiusM: num(process.env.DUPLICATE_RADIUS_M, 70),
    slaTickMs: num(process.env.SLA_TICK_MS, 60000),
    minAngleDistance: num(process.env.MIN_ANGLE_DISTANCE, 6),
    maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 12 * 1024 * 1024)
  }
};

export default config;
