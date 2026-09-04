/**
 * Zero-dependency JSON document store.
 * Chosen so the prototype runs with `npm install && npm start` on any machine -
 * no Mongo/Postgres daemon required. The access surface (find / insert / update)
 * mirrors a document DB so swapping in MongoDB later is a drop-in change.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

const COLLECTIONS = [
  'users', 'departments', 'issues', 'reports', 'contractors',
  'alerts', 'audit', 'notifications', 'evidence'
];

const cache = new Map();
const queue = new Map();

function fileFor(name) {
  return path.join(config.paths.data, `${name}.json`);
}

function ensureDirs() {
  for (const dir of [config.paths.data, config.paths.uploads]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function load(name) {
  if (cache.has(name)) return cache.get(name);
  ensureDirs();
  const file = fileFor(name);
  let rows = [];
  if (fs.existsSync(file)) {
    try {
      rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rows)) rows = [];
    } catch {
      rows = [];
    }
  }
  cache.set(name, rows);
  return rows;
}

/** Debounced atomic write - keeps the API synchronous but disk-cheap. */
function persist(name) {
  if (queue.has(name)) return;
  queue.set(name, setTimeout(() => {
    queue.delete(name);
    flush(name);
  }, 40));
}

function flush(name) {
  ensureDirs();
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name) || [], null, 2));
  fs.renameSync(tmp, file);
}

export function flushAll() {
  for (const [name, t] of queue) { clearTimeout(t); queue.delete(name); }
  for (const name of cache.keys()) flush(name);
}

export const id = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

function matches(row, query) {
  return Object.entries(query).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.includes(row[k]);
      if ('$ne' in v) return row[k] !== v.$ne;
    }
    return row[k] === v;
  });
}

export function collection(name) {
  if (!COLLECTIONS.includes(name)) COLLECTIONS.push(name);
  return {
    all: () => [...load(name)],
    find(query = {}) { return load(name).filter((r) => matches(r, query)); },
    findOne(query = {}) { return load(name).find((r) => matches(r, query)) || null; },
    byId(rowId) { return load(name).find((r) => r.id === rowId) || null; },
    insert(doc) {
      const rows = load(name);
      const row = { id: doc.id || id(name.slice(0, 3)), createdAt: new Date().toISOString(), ...doc };
      rows.push(row);
      persist(name);
      return row;
    },
    insertMany(docs) { return docs.map((d) => this.insert(d)); },
    update(rowId, patch) {
      const rows = load(name);
      const i = rows.findIndex((r) => r.id === rowId);
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
      persist(name);
      return rows[i];
    },
    remove(rowId) {
      const rows = load(name);
      const i = rows.findIndex((r) => r.id === rowId);
      if (i === -1) return false;
      rows.splice(i, 1);
      persist(name);
      return true;
    },
    replaceAll(rows) { cache.set(name, rows); persist(name); return rows; },
    count(query = {}) { return this.find(query).length; }
  };
}

export const db = {
  users: collection('users'),
  departments: collection('departments'),
  issues: collection('issues'),
  contractors: collection('contractors'),
  alerts: collection('alerts'),
  audit: collection('audit'),
  notifications: collection('notifications'),
  evidence: collection('evidence')
};

process.on('exit', flushAll);
process.on('SIGINT', () => { flushAll(); process.exit(0); });

export default db;
