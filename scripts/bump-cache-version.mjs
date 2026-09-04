/**
 * Cache-buster for the GitHub Pages build.
 *
 * Browsers cache ES modules aggressively, and GitHub Pages serves them with
 * `Cache-Control: max-age=600`. Without a version query a visitor who loaded the
 * site before a deploy keeps running the OLD modules - which is exactly how a
 * stale build reported "CivicVision on-board engine" after the CLIP model had
 * already shipped.
 *
 * Run before deploying: node scripts/bump-cache-version.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DOCS = path.join(process.cwd(), 'docs');
const stamp = process.argv[2] || String(Date.now());

const rewriteImports = (src) => src
  .replace(/(from\s+['"])(\.\/[\w.-]+\.js)(\?v=[^'"]*)?(['"])/g, `$1$2?v=${stamp}$4`)
  .replace(/(import\(\s*['"])(\.\/[\w.-]+\.js)(\?v=[^'"]*)?(['"])/g, `$1$2?v=${stamp}$4`);

let changed = 0;
for (const f of fs.readdirSync(path.join(DOCS, 'js'))) {
  if (!f.endsWith('.js')) continue;
  const p = path.join(DOCS, 'js', f);
  const before = fs.readFileSync(p, 'utf8');
  const after = rewriteImports(before);
  if (after !== before) { fs.writeFileSync(p, after); changed++; }
}

const indexPath = path.join(DOCS, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8')
  .replace(/(src=")(js\/app\.js)(\?v=[^"]*)?(")/, `$1$2?v=${stamp}$4`)
  .replace(/(href=")(css\/app\.css)(\?v=[^"]*)?(")/, `$1$2?v=${stamp}$4`);
fs.writeFileSync(indexPath, html);

console.log(`Cache version ${stamp} applied to ${changed} module(s) + index.html`);
