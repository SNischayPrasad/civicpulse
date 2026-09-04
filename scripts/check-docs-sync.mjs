/**
 * Guards the browser build against drifting from the server build.
 *
 * docs/js/ carries verbatim copies of four source files (prompts, taxonomy, nlp,
 * address-core) plus its own modules. Two failure modes have already shipped
 * from this directory:
 *
 *   1. A shared file was edited on the server side only, so the Pages build kept
 *      the old classification prompts.
 *   2. A named import was added to server/.../clip.js but not to docs/js/clip.js,
 *      which only surfaced as a ReferenceError at runtime in the browser.
 *
 * This script catches both statically. Run it before deploying.
 *
 * Usage: node scripts/check-docs-sync.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DOCS = path.join(ROOT, 'docs', 'js');

/** Files that must be byte-identical between the two builds. */
const SHARED = [
  ['server/services/ai/prompts.js', 'docs/js/prompts.js'],
  ['server/services/ai/taxonomy.js', 'docs/js/taxonomy.js'],
  ['server/services/ai/nlp.js', 'docs/js/nlp.js'],
  ['server/services/ai/address-core.js', 'docs/js/address-core.js']
];

/** Strip the cache-busting query so shared files compare equal. */
const normalise = (s) => s.replace(/(\.js)\?v=[\w.-]+/g, '$1').replace(/\r\n/g, '\n').trim();

const errors = [];

for (const [a, b] of SHARED) {
  const pa = path.join(ROOT, a), pb = path.join(ROOT, b);
  if (!fs.existsSync(pb)) { errors.push(`${b} is missing - copy it from ${a}`); continue; }
  if (normalise(fs.readFileSync(pa, 'utf8')) !== normalise(fs.readFileSync(pb, 'utf8'))) {
    errors.push(`${b} has drifted from ${a} - re-copy it`);
  }
}

/** Every named import in docs/js must exist as a named export in its target. */
const exportsOf = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // `export { a, b as c }` — the exported name is what follows `as`, else the identifier.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const halves = part.split(/\s+as\s+/).map((x) => x.trim()).filter(Boolean);
      const exported = halves[halves.length - 1];
      if (exported) names.add(exported);
    }
  }
  return names;
};

const files = fs.readdirSync(DOCS).filter((f) => f.endsWith('.js'));
const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(DOCS, f), 'utf8')]));

/** Every name exported by any module in docs/js, and where it comes from. */
const exportedBy = new Map();
for (const [file, src] of sources) for (const name of exportsOf(src)) {
  if (!exportedBy.has(name)) exportedBy.set(name, file);
}

const importedNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const raw of m[1].split(',')) {
      const halves = raw.split(/\s+as\s+/).map((x) => x.trim()).filter(Boolean);
      const local = halves[halves.length - 1];
      if (local) names.add(local);
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+(\w+)/g)) names.add(m[1]);
  return names;
};

const declaredNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
};

// Verify imported names actually exist, and - the bug that shipped twice - that
// a name exported elsewhere in docs/js is not USED here without being imported.
for (const [file, src] of sources) {
  const imported = importedNames(src);
  const declared = declaredNames(src);

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/[\w.-]+\.js)(?:\?v=[\w.-]+)?'/g)) {
    const target = path.join(DOCS, m[2].replace('./', ''));
    if (!fs.existsSync(target)) { errors.push(`${file} imports missing module ${m[2]}`); continue; }
    const available = exportsOf(fs.readFileSync(target, 'utf8'));
    for (const raw of m[1].split(',')) {
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (name && !available.has(name)) {
        errors.push(`${file} imports { ${name} } from ${m[2]}, which does not export it`);
      }
    }
  }

  // Scan executable code only: comments and string literals contain plain
  // English ("No recurring hotspots yet") that would otherwise look like an
  // identifier. Template literals keep their ${...} interpolations, which ARE code.
  const body = src
    .replace(/^import[\s\S]*?from\s*'[^']*';?$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, (lit) =>
      [...lit.matchAll(/\$\{([\s\S]*?)\}/g)].map((m) => m[1]).join(' '))
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  for (const [name, origin] of exportedBy) {
    if (origin === file || imported.has(name) || declared.has(name)) continue;
    if (new RegExp(`(?<![\\w$.'"])${name}(?![\\w$'"])`).test(body)) {
      errors.push(`${file} uses ${name} but never imports it (exported by ${origin}) - this is a runtime ReferenceError in the browser`);
    }
  }
}

if (errors.length) {
  console.error('Browser build is out of sync with the server build:\n');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('docs/ is in sync with the server build.');
