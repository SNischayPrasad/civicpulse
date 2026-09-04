/**
 * Downloads the real-photograph fixtures the test suite runs against.
 *
 * Images come from Wikimedia Commons (public domain / CC licensed) and are not
 * committed to the repository - run this once before `npm run test:e2e`.
 *
 * Usage: node scripts/fetch-test-photos.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'test-fixtures');
const UA = { 'User-Agent': 'CivicPulse-test/1.0 (SIH25031 prototype)' };

/** category prefix -> Commons search terms */
const QUERIES = {
  pothole: ['pothole road', 'pothole asphalt damage'],
  garbage: ['garbage pile street', 'waste dump municipal'],
  streetlight: ['street light pole night', 'broken street lamp'],
  waterlog: ['waterlogged road flooding street'],
  tree: ['fallen tree road'],
  manhole: ['open manhole']
};

/** Photos of intact road surfaces, used as "after" repair evidence. */
const REPAIRED = [
  'File:Amboy (California, USA), Hist. Route 66 -- 2012 -- 1.jpg',
  'File:Chestnut Mt Rd, looking south over Truevine.jpg'
];

/** Photos that are NOT civic issues - the model must refuse to file these. */
const NON_CIVIC = [
  ['cat', 'File:Cat November 2010-1a.jpg'],
  ['dog', 'File:Golde33443.jpg'],
  ['food', 'File:Good Food Display - NCI Visuals Online.jpg'],
  ['flower', 'File:Sunflower sky backdrop.jpg'],
  ['person', 'File:Portrait Placeholder.png']
];

/** Photos containing legible street signage, for the address-AI test. */
const SIGNAGE = [
  'File:2nd B Cross Rd, Banaswadi, Bengaluru, Karnataka 560043, India (Ank Kumar, Infosys Limited) 02.jpg',
  'File:2nd B Cross Rd, Banaswadi, Bengaluru, Karnataka 560043, India (Ank Kumar, Infosys Limited) 05.jpg',
  'File:MDR Kerala name board.jpg',
  'File:Shoot-Up Hill road name plate, retaining "Borough of Hampstead" text.jpg',
  'File:An old street name plate - geograph.org.uk - 2593062.jpg'
];

const api = async (params) => {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: UA });
  return res.json();
};

async function search(q, limit) {
  const j = await api({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `filetype:bitmap ${q}`, gsrlimit: String(limit), gsrnamespace: '6',
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '900'
  });
  return Object.values(j.query?.pages || {})
    .map((p) => ({
      title: p.title,
      url: p.imageinfo?.[0]?.thumburl,
      licence: p.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value
    }))
    .filter((x) => x.url);
}

async function byTitle(title) {
  const j = await api({
    action: 'query', format: 'json', titles: title,
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '900'
  });
  const p = Object.values(j.query?.pages || {})[0];
  const info = p?.imageinfo?.[0];
  return info?.thumburl
    ? { title, url: info.thumburl, licence: info.extmetadata?.LicenseShortName?.value }
    : null;
}

async function save(hit, name) {
  const res = await fetch(hit.url, { headers: UA });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 8000) return false;
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name.padEnd(24)} ${hit.title.replace('File:', '').slice(0, 58)}  [${hit.licence || 'see Commons'}]`);
  return true;
}

const main = async () => {
  fs.mkdirSync(path.join(OUT, 'signage'), { recursive: true });

  console.log('Civic issue photos:');
  let i = 0;
  for (const [category, queries] of Object.entries(QUERIES)) {
    for (const q of queries) {
      for (const hit of await search(q, 4)) {
        const ext = /\.png$/i.test(hit.url) ? 'png' : 'jpg';
        await save(hit, `${category}-${String(++i).padStart(2, '0')}.${ext}`).catch(() => {});
      }
    }
  }

  console.log('\nRepaired road surfaces (after-evidence):');
  for (const [n, title] of REPAIRED.entries()) {
    const hit = await byTitle(title);
    if (hit) await save(hit, `repaired-0${n + 1}.jpg`).catch(() => {});
  }

  console.log('\nStreet signage (address AI):');
  for (const [n, title] of SIGNAGE.entries()) {
    const hit = await byTitle(title);
    if (hit) await save(hit, path.join('signage', `sign-0${n + 1}.jpg`)).catch(() => {});
  }

  console.log(`\nSaved to ${OUT}`);
  console.log('Now run:  node test-e2e.mjs   (server must be running)');
};

main();
