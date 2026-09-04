/**
 * CivicPulse end-to-end pipeline test.
 *
 * Drives the real HTTP API with real photographs and walks a civic issue all
 * the way from a citizen's camera to a verified closure:
 *
 *   auth -> AI classification -> department routing -> crowd clustering
 *        -> acknowledge/assign/start -> before evidence -> closure verification
 *        -> citizen sign-off -> contractor liability -> analytics
 *
 * Fixtures are real photos (see scripts/fetch-test-photos.mjs). Synthetic
 * images are only used where the test is about mechanics rather than content.
 *
 * Usage: npm start (in another terminal), then: node test-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';

const BASE = process.env.BASE || 'http://localhost:4000';
const FIX = path.join(process.cwd(), 'test-fixtures');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${extra}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

const photo = (name) => fs.readFileSync(path.join(FIX, name));

/** A flat grey frame - content-free, used only for the angle-diversity checks. */
function blank(seed = 0) {
  const W = 480, H = 360;
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = 120 + seed * 20 + (Math.random() - 0.5) * 8;
    const o = i * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v + 3; data[o + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width: W, height: H }, 88).data);
}

async function call(p, { token, method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function form(buffers, fields = {}) {
  const fd = new FormData();
  buffers.forEach((b, i) => fd.append('photos', new Blob([b], { type: 'image/jpeg' }), `angle${i + 1}.jpg`));
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

const login = async (email, password) =>
  (await call('/api/auth/login', { method: 'POST', body: { email, password } })).json;

/* ------------------------------------------------------------------- run */

if (!fs.existsSync(FIX)) {
  console.error('Missing test-fixtures/. Run: node scripts/fetch-test-photos.mjs');
  process.exit(2);
}

console.log('\n=== CivicPulse end-to-end pipeline test ===\n');

/* 1. AUTH ------------------------------------------------------------------ */
console.log('[1] Authentication and roles');
ok('unauthenticated request is rejected', (await call('/api/issues')).status === 401);
const citizen = await login('citizen@demo.in', 'Citizen@123');
ok('citizen login returns a token', !!citizen.token);
const worker = await login('worker.roads@city.gov.in', 'Worker@123');
const sup = await login('supervisor.roads@city.gov.in', 'Super@123');
const sanit = await login('worker.sanit@city.gov.in', 'Worker@123');
const power = await login('worker.power@city.gov.in', 'Worker@123');
const admin = await login('admin@city.gov.in', 'Admin@123');
ok('staff logins carry department binding', worker.user.departmentId === 'dept_roads');
ok('wrong password rejected',
  (await call('/api/auth/login', { method: 'POST', body: { email: 'citizen@demo.in', password: 'wrong' } })).status === 401);

/* 2. AI CLASSIFICATION ----------------------------------------------------- */
console.log('\n[2] AI image analysis and department routing (real photographs)');
const r1 = await call('/api/issues', {
  token: citizen.token, method: 'POST',
  form: form([photo('pothole-01.jpg'), photo('pothole-02.jpg'), photo('pothole-07.jpg')], {
    description: 'Deep pothole on the main road near the school, two bikes have fallen here this week',
    lat: 12.9352, lng: 77.6245, accuracy: 12
  })
});
ok('multi-angle report accepted', r1.status === 201, `(${r1.status})`);
const issue1 = r1.json.issue;
console.log(`        -> ${issue1?.code} ${r1.json.ai?.categoryLabel} sev ${r1.json.ai?.severity} conf ${r1.json.ai?.confidence} in ${r1.json.ai?.processingMs}ms`);
ok('pothole photos classified as POTHOLE', r1.json.ai?.category === 'POTHOLE', `got ${r1.json.ai?.category}`);
ok('routed to Roads & Infrastructure', issue1?.departmentId === 'dept_roads');
ok('vision model reported its matches', (r1.json.ai?.visionModel?.topMatches || []).length > 0);
ok('SLA due date computed', !!issue1?.dueAt);
ok('3 angles stored as evidence', issue1?.evidence?.report?.length === 3);
ok('location recorded with a trust level', !!issue1?.location?.trust);

const g1 = await call('/api/issues', {
  token: citizen.token, method: 'POST',
  form: form([photo('garbage-09.jpg'), photo('garbage-11.jpg')], {
    description: 'Garbage dumped at the corner, terrible smell', lat: 12.9719, lng: 77.6412
  })
});
console.log(`        -> ${g1.json.issue?.code} ${g1.json.ai?.categoryLabel} conf ${g1.json.ai?.confidence}`);
ok('garbage photos routed to Sanitation', g1.json.issue?.departmentId === 'dept_sanit', `got ${g1.json.ai?.category}`);

const s1 = await call('/api/issues', {
  token: citizen.token, method: 'POST',
  form: form([photo('streetlight-18.jpg'), photo('streetlight-22.jpg')], {
    description: 'Street light not working, the whole lane is dark at night', lat: 12.9116, lng: 77.6389
  })
});
console.log(`        -> ${s1.json.issue?.code} ${s1.json.ai?.categoryLabel} conf ${s1.json.ai?.confidence}`);
ok('street light photos routed to Electrical', s1.json.issue?.departmentId === 'dept_power', `got ${s1.json.ai?.category}`);

/* 3. AI ADDRESS ------------------------------------------------------------ */
console.log('\n[3] AI address resolution');
const addr = issue1?.addressAI;
console.log(`        -> ${addr?.formatted}`);
console.log(`        -> source=${addr?.source} confidence=${addr?.confidence}`);
ok('an address was resolved for the issue', !!addr?.formatted);
ok('address is more specific than raw coordinates', !/^-?\d+\.\d+, -?\d+\.\d+$/.test(addr?.formatted || ''));
ok('address records which signals produced it', (addr?.signals || []).length > 0);
ok('issue.address carries the resolved address', issue1?.address === addr?.formatted);

/* 4. GUARDS ---------------------------------------------------------------- */
console.log('\n[4] Input guards');
ok('report without a photo is rejected',
  (await call('/api/issues', { token: citizen.token, method: 'POST', form: form([], { lat: 12.9, lng: 77.6 }) })).status === 400);
ok('report without location is rejected',
  (await call('/api/issues', { token: citizen.token, method: 'POST', form: form([photo('pothole-01.jpg')]) })).status === 400);
ok('more than 4 photos is rejected',
  (await call('/api/issues', {
    token: citizen.token, method: 'POST',
    form: form([blank(0), blank(1), blank(2), blank(3), blank(4)], { lat: 12.9, lng: 77.6 })
  })).status === 400);

/* 5. CROWD CLUSTERING ------------------------------------------------------ */
console.log('\n[5] Crowd intelligence / duplicate merge');
const citizen2 = await login('citizen2@demo.in', 'Citizen@123');
const dup = await call('/api/issues', {
  token: citizen2.token, method: 'POST',
  form: form([photo('pothole-03.jpg'), photo('pothole-04.jpg')], {
    description: 'Same big pothole is still here', lat: 12.93523, lng: 77.62453
  })
});
ok('nearby same-category report merges into the cluster', dup.json.duplicate === true);
ok('report count increased', dup.json.issue?.reportCount === 2, `count=${dup.json.issue?.reportCount}`);

/* 6. WORKFLOW -------------------------------------------------------------- */
console.log('\n[6] Department workflow');
ok('a worker from another department is blocked',
  (await call(`/api/issues/${issue1.id}/acknowledge`, { token: sanit.token, method: 'POST' })).status === 403);
ok('acknowledge works for the owning department',
  (await call(`/api/issues/${issue1.id}/acknowledge`, { token: worker.token, method: 'POST' })).status === 200);
const assign = await call(`/api/issues/${issue1.id}/assign`, {
  token: sup.token, method: 'POST', body: { workerId: worker.user.id }
});
ok('supervisor assigns a field worker', assign.json.issue?.assignedToName === worker.user.name);
ok('a worker cannot assign work',
  (await call(`/api/issues/${issue1.id}/assign`, { token: worker.token, method: 'POST', body: { workerId: worker.user.id } })).status === 403);
ok('work start is recorded',
  (await call(`/api/issues/${issue1.id}/start`, { token: worker.token, method: 'POST' })).json.issue?.status === 'IN_PROGRESS');

/* 7. EVIDENCE RULES -------------------------------------------------------- */
console.log('\n[7] Before/after evidence rules');
ok('a single "before" photo is rejected',
  (await call(`/api/issues/${issue1.id}/before`, { token: worker.token, method: 'POST', form: form([photo('pothole-01.jpg')]) })).status === 400);
const same = photo('pothole-01.jpg');
const twice = await call(`/api/issues/${issue1.id}/before`, { token: worker.token, method: 'POST', form: form([same, same]) });
ok('two identical photos are rejected as "different angles"', twice.status === 400, twice.json.error || '');
const beforeOk = await call(`/api/issues/${issue1.id}/before`, {
  token: worker.token, method: 'POST', form: form([photo('pothole-01.jpg'), photo('pothole-02.jpg')])
});
ok('two genuinely different angles are accepted', beforeOk.status === 200, beforeOk.json.error || '');

/* 8. CLOSURE VERIFICATION -------------------------------------------------- */
console.log('\n[8] AI closure verification');
const fake = await call(`/api/issues/${issue1.id}/resolve`, {
  token: worker.token, method: 'POST',
  form: form([photo('pothole-01.jpg'), photo('pothole-02.jpg')], { notes: 'done' })
});
ok('recycled "after" photos are rejected as a fake closure', fake.status === 422, `(${fake.status})`);

const real = await call(`/api/issues/${issue1.id}/resolve`, {
  token: worker.token, method: 'POST',
  form: form([photo('repaired-01.jpg'), photo('repaired-02.jpg')], { notes: 'Patched with hot mix, 4 sqm' })
});
ok('a genuine repair is accepted', real.status === 200, real.json.error || '');
const v = real.json.verification;
console.log(`        -> verified=${v?.verified} improvement=${v?.improvementScore} defectGone=${JSON.stringify(v?.defectGone)}`);
ok('the vision model re-checked the defect', !!v?.defectGone);
ok('the defect score dropped after repair', (v?.defectGone?.drop ?? 0) > 0, `drop=${v?.defectGone?.drop}`);
ok('closure verified', v?.verified === true, `score=${v?.improvementScore}`);
ok('issue is now RESOLVED', real.json.issue?.status === 'RESOLVED');

/* 9. CITIZEN SIGN-OFF ------------------------------------------------------ */
console.log('\n[9] Citizen verification');
ok('an unrelated user cannot verify closure',
  (await call(`/api/issues/${issue1.id}/verify`, { token: power.token, method: 'POST', body: { accepted: true } })).status === 403);
ok('the reporter closes the issue',
  (await call(`/api/issues/${issue1.id}/verify`, {
    token: citizen.token, method: 'POST', body: { accepted: true, rating: 5, comment: 'Fixed properly' }
  })).json.issue?.status === 'CLOSED');

/* 10. CONTRACTORS ---------------------------------------------------------- */
console.log('\n[10] Contractor accountability from open data');
const detail = await call(`/api/issues/${issue1.id}`, { token: admin.token });
const con = detail.json.issue?.contractor;
console.log(`        -> ${con ? `${con.name} liable=${con.liable} source=${con.source}` : 'no match'}`);
ok('contractor identified for the location', !!con);
ok('defect-liability decision recorded', con && typeof con.liable === 'boolean');
ok('reasoning trail captured', (detail.json.issue?.contractorReasoning || []).length > 0);
ok('registry lists contractors', (await call('/api/contractors', { token: sup.token })).json.contractors?.length > 0);
ok('supervisor can issue a defect notice',
  (await call(`/api/contractors/${con?.contractorId || 'con_srinivasa'}/notice`, {
    token: sup.token, method: 'POST', body: { reason: 'Pothole inside DLP', issueId: issue1.id }
  })).status === 200);
ok('a worker cannot issue a defect notice',
  (await call('/api/contractors/con_srinivasa/notice', { token: worker.token, method: 'POST', body: { reason: 'x' } })).status === 403);

/* 11. ANALYTICS ------------------------------------------------------------ */
console.log('\n[11] Control-room analytics');
const ov = await call('/api/analytics/overview', { token: admin.token });
console.log(`        -> ${ov.json.totals.issues} issues, ${ov.json.totals.open} open, avg AI confidence ${ov.json.ai.avgConfidence}`);
ok('overview aggregates issues', ov.json.totals.issues >= 3);
ok('fake closure attempts are counted', ov.json.ai.fakeClosuresBlocked >= 1, `blocked=${ov.json.ai.fakeClosuresBlocked}`);
ok('SLA compliance computed', ov.json.sla.compliance !== undefined);
ok('audit trail is queryable', detail.json.audit?.length >= 5, `${detail.json.audit?.length} entries`);
ok('address resolution is audited', detail.json.audit?.some((a) => a.action === 'ADDRESS_RESOLVED'));
ok('department stats returned', (await call('/api/departments', { token: admin.token })).json.departments?.length === 8);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
