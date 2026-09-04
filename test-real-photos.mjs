/**
 * Real-photograph classification test.
 *
 * Drives the live HTTP API with actual photographs (not synthetic images) and
 * checks that each one is classified into the right category and routed to the
 * right department. This is the test that matters: the colour-statistics engine
 * scored 24% here, which is why the vision model was introduced.
 *
 * Usage: node test-real-photos.mjs [imageDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:4000';
const DIR = process.argv[2] || path.join(process.cwd(), 'test-fixtures');

const EXPECT = {
  pothole: { category: ['POTHOLE'], department: 'dept_roads' },
  garbage: { category: ['GARBAGE'], department: 'dept_sanit' },
  streetlight: { category: ['STREETLIGHT'], department: 'dept_power' },
  waterlog: { category: ['STAGNANT_WATER', 'SEWAGE', 'WATER_LEAK'], department: null },
  tree: { category: ['FALLEN_TREE'], department: 'dept_parks' },
  manhole: { category: ['MANHOLE'], department: 'dept_water' }
};

// A plausible citizen description per category - the NLP layer is part of the
// product, so the test exercises the same fusion a real report would use.
const DESCRIPTION = {
  pothole: 'There is a bad pothole here on the road, vehicles are getting damaged',
  garbage: 'Garbage has not been collected here for days, it smells terrible',
  streetlight: 'The street light here is not working, the road is dark at night',
  waterlog: 'Water has collected here and is not draining away',
  tree: 'A tree has fallen and is blocking the way',
  manhole: 'The manhole cover here is a hazard'
};

// spread reports out so the duplicate-clustering logic does not merge them
const spot = (i) => ({ lat: 12.9352 + i * 0.01, lng: 77.6245 + i * 0.01 });

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  return (await r.json()).token;
}

const main = async () => {
  if (!fs.existsSync(DIR)) {
    console.error(`No image directory at ${DIR}`);
    process.exit(2);
  }
  const token = await login('citizen@demo.in', 'Citizen@123');
  if (!token) { console.error('Could not sign in - is the server running?'); process.exit(2); }

  const files = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  let catHit = 0, deptHit = 0, deptTotal = 0, total = 0;
  const rows = [];

  for (const [i, f] of files.entries()) {
    const kind = f.split('-')[0];
    const want = EXPECT[kind];
    if (!want) continue;

    const fd = new FormData();
    const buf = fs.readFileSync(path.join(DIR, f));
    fd.append('photos', new Blob([buf], { type: /png$/i.test(f) ? 'image/png' : 'image/jpeg' }), f);
    fd.append('description', DESCRIPTION[kind] || '');
    const { lat, lng } = spot(i);
    fd.append('lat', String(lat));
    fd.append('lng', String(lng));

    const res = await fetch(`${BASE}/api/issues`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
    });
    const j = await res.json();
    const ai = j.ai;
    if (!ai) { rows.push(`ERR  ${f}  ${j.error || res.status}`); continue; }

    total++;
    const okCat = want.category.includes(ai.category);
    if (okCat) catHit++;
    let deptMark = '';
    if (want.department) {
      deptTotal++;
      const okDept = j.issue?.departmentId === want.department;
      if (okDept) deptHit++;
      deptMark = okDept ? '' : `  [dept ${j.issue?.departmentId}]`;
    }
    rows.push(
      `${okCat ? 'ok  ' : 'MISS'} ${f.padEnd(20)} want ${want.category[0].padEnd(15)} got ${String(ai.category).padEnd(15)} ` +
      `conf=${String(ai.confidence).padEnd(5)} ${ai.processingMs}ms${deptMark}`
    );
  }

  console.log(rows.join('\n'));
  console.log(`\nCategory accuracy   : ${catHit}/${total}  (${Math.round((catHit / total) * 100)}%)`);
  console.log(`Department routing  : ${deptHit}/${deptTotal}  (${Math.round((deptHit / deptTotal) * 100)}%)`);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`Vision model        : ${health.ai.vision.model} (loaded=${health.ai.vision.loaded})`);
  process.exit(catHit / total >= 0.8 ? 0 : 1);
};

main();
