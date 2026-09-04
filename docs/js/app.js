/* CivicPulse static build - UI layer for citizen, department and control room. */
import * as E from './engine.js?v=20260905c';
import { onModelProgress } from './clip.js?v=20260905c';
import { onOcrProgress } from './address.js?v=20260905c';
import { readExif, compressImage } from './exif.js?v=20260905c';
import { CATEGORIES, SEVERITY_LABELS } from './taxonomy.js?v=20260905c';

/* ----------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const timeAgo = (iso) => {
  if (!iso) return '-';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const dueIn = (iso) => {
  if (!iso) return '-';
  const h = (new Date(iso).getTime() - Date.now()) / 36e5;
  if (h < 0) return `overdue ${Math.abs(h) < 24 ? `${Math.abs(h).toFixed(0)}h` : `${(Math.abs(h) / 24).toFixed(0)}d`}`;
  return h < 24 ? `${h.toFixed(0)}h left` : `${(h / 24).toFixed(0)}d left`;
};
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const money = (n) => (n ? `₹${(n / 1e5).toFixed(1)} L` : '-');

const STATUS_STYLE = { REPORTED: 'info', ROUTED: 'info', ACKNOWLEDGED: 'info', ASSIGNED: 'accent', IN_PROGRESS: 'accent', RESOLVED: 'ok', CLOSED: 'ok', ESCALATED: 'danger' };
const sevChip = (s, l) => `<span class="sev sev-${s}"><i></i>${esc(l || `S${s}`)}</span>`;
const statusChip = (s) => `<span class="badge ${STATUS_STYLE[s] || ''} status">${esc(String(s).replace('_', ' '))}</span>`;
const ICONS = { pothole: '◍', garbage: '⛝', sewage: '≋', water: '◈', light: '☀', tree: '⌘', manhole: '◎', debris: '▦', signal: '⊟', mosquito: '✳', graffiti: '✎', footpath: '▤', unknown: '?' };

function toast(title, message = '', kind = '') {
  let wrap = $('toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toasts'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = '<div class="t"></div><div class="m"></div>';
  el.querySelector('.t').textContent = title;
  el.querySelector('.m').textContent = message;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 6000);
}

const severityColor = (s) => ['#64748b', '#64748b', '#38bdf8', '#f59e0b', '#fb7185', '#ef4444'][s] || '#64748b';

function makeMap(el, center = { lat: 12.9352, lng: 77.6245 }, zoom = 13) {
  if (!window.L || !el) return null;
  const map = window.L.map(el, { attributionControl: false }).setView([center.lat, center.lng], zoom);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  return map;
}

/* ------------------------------------------------------------------ state */

const state = { photos: [], location: null, view: null, maps: {}, layers: {} };

const NAV = {
  citizen: [
    { key: 'report', label: 'Report an issue', icon: '＋' },
    { key: 'reports', label: 'My reports', icon: '▤' },
    { key: 'map', label: 'City map', icon: '◉' }
  ],
  worker: [
    { key: 'queue', label: 'Work queue', icon: '▤' },
    { key: 'map', label: 'Department map', icon: '◉' },
    { key: 'contractors', label: 'Contractors', icon: '⚖' }
  ],
  supervisor: [
    { key: 'queue', label: 'Work queue', icon: '▤' },
    { key: 'map', label: 'Department map', icon: '◉' },
    { key: 'contractors', label: 'Contractors', icon: '⚖' },
    { key: 'analytics', label: 'Analytics', icon: '◱' }
  ],
  admin: [
    { key: 'analytics', label: 'Control room', icon: '◱' },
    { key: 'queue', label: 'All issues', icon: '▤' },
    { key: 'map', label: 'City map', icon: '◉' },
    { key: 'review', label: 'Review queue', icon: '⚠' },
    { key: 'contractors', label: 'Contractors', icon: '⚖' }
  ]
};

const TITLES = {
  report: ['Report an issue', 'Photograph it, we handle the routing'],
  reports: ['My reports', 'Every report you filed, tracked to closure'],
  map: ['Issue map', 'Live civic issues, sized by how many citizens reported them'],
  queue: ['Work queue', 'AI-routed issues owned by your department'],
  analytics: ['City control room', 'One pipeline: citizen evidence → AI → authority action'],
  review: ['Human-in-the-loop review', 'Low-confidence classifications awaiting a human decision'],
  contractors: ['Contractor accountability', 'Who built it, and are they still liable']
};

/* ------------------------------------------------------------------- boot */

E.ensureSeed();
E.slaSweep();
setInterval(() => { E.slaSweep(); }, 60000);
E.onChange(() => { if (E.currentUser()) renderAll(); });

$('reset-demo').onclick = () => {
  if (!confirm('Clear all demo data stored in this browser?')) return;
  E.resetDemo();
  location.reload();
};

/* ------------------------------------------------------------------- auth */

document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('login-form').classList.toggle('hidden', b.dataset.tab !== 'login');
    $('register-form').classList.toggle('hidden', b.dataset.tab !== 'register');
    $('auth-error').classList.add('hidden');
  };
});

const authError = (m) => { $('auth-error').textContent = m; $('auth-error').classList.remove('hidden'); };

$('login-form').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { E.login(f.get('email'), f.get('password')); enterApp(); }
  catch (err) { authError(err.message); }
};

$('register-form').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { E.register({ name: f.get('name'), email: f.get('email'), password: f.get('password') }); enterApp(); }
  catch (err) { authError(err.message); }
};

const roleTag = { citizen: 'info', worker: 'accent', supervisor: 'warn', admin: 'danger' };
$('demo-list').innerHTML = E.DEMO_ACCOUNTS.map((a) => `
  <button class="demo-account" data-email="${esc(a.email)}" data-password="${esc(a.password)}">
    <span class="badge ${roleTag[a.role]}">${esc(a.role)}</span>
    <span class="grow"><b>${esc(a.name)}</b><span class="faint small mono" style="display:block">${esc(a.email)}</span></span>
  </button>`).join('');

document.querySelectorAll('.demo-account').forEach((b) => {
  b.onclick = () => { try { E.login(b.dataset.email, b.dataset.password); enterApp(); } catch (e) { authError(e.message); } };
});

$('hero-issues').textContent = E.db.state.issues.length;

function enterApp() {
  const u = E.currentUser();
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  show((NAV[u.role] || NAV.citizen)[0].key);
  wireOnce();
}

if (E.currentUser()) enterApp();

/* ------------------------------------------------------------------ shell */

function renderShell(active) {
  const u = E.currentUser();
  const nav = NAV[u.role] || NAV.citizen;
  const dept = u.departmentId ? E.db.byId('departments', u.departmentId) : null;

  document.querySelector('.sidebar').innerHTML = `
    <div class="brand">
      <div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#04231f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-8 4 16 3-8h6"/></svg></div>
      <div><div class="brand-name">CivicPulse</div><div class="brand-sub">Infinity Force</div></div>
    </div>
    <nav class="nav">
      <div class="nav-label">${esc(dept ? dept.name : 'Workspace')}</div>
      ${nav.map((n) => `<a href="#${n.key}" data-nav="${n.key}" class="${n.key === active ? 'active' : ''}"><span style="width:16px;text-align:center">${n.icon}</span>${esc(n.label)}</a>`).join('')}
    </nav>
    <div class="side-foot" style="margin-top:auto">
      <div class="card" style="padding:12px">
        <div class="row" style="gap:8px"><span class="live-dot"></span><span class="small muted">Live</span></div>
        <div style="margin-top:10px" class="small">
          <div style="font-weight:650">${esc(u.name)}</div>
          <div class="faint tiny" style="margin-top:2px">${esc(u.role)}${u.employeeId ? ` · ${esc(u.employeeId)}` : ''}</div>
        </div>
        <button class="btn ghost sm block" style="margin-top:10px" id="logout-btn">Sign out</button>
      </div>
    </div>`;

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); show(a.dataset.nav); };
  });
  $('logout-btn').onclick = () => { E.logout(); location.reload(); };

  const [t, s] = TITLES[active] || ['CivicPulse', ''];
  document.querySelector('[data-title]').textContent = dept && active === 'queue' ? dept.name : t;
  document.querySelector('[data-subtitle]').textContent = s;
  $('trust-badge').textContent = u.role === 'citizen' ? `Trust ${Math.round((u.trustScore || 0.6) * 100)}%` : u.role;
}

function show(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('hidden', el.dataset.view !== view));
  renderShell(view);
  renderAll();
  setTimeout(() => {
    if (view === 'map') renderCityMap();
    if (view === 'report') state.maps.pick?.invalidateSize();
  }, 60);
}

function renderAll() {
  if (!E.currentUser()) return;
  renderNearby(); renderMyIssues(); renderQueue(); renderAlerts();
  renderAnalytics(); renderContractors(); renderReview();
}

/* --------------------------------------------------------------- wiring */

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;

  const cam = $('camera-input'), file = $('file-input'), dz = $('dropzone');
  $('camera-btn').onclick = (e) => { e.stopPropagation(); cam.click(); };
  $('file-btn').onclick = (e) => { e.stopPropagation(); file.click(); };
  dz.onclick = () => file.click();
  cam.onchange = (e) => { addPhotos(e.target.files); e.target.value = ''; };
  file.onchange = (e) => { addPhotos(e.target.files); e.target.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => addPhotos(e.dataTransfer.files));

  state.maps.pick = makeMap($('pick-map'), { lat: 12.9352, lng: 77.6245 }, 15);
  if (state.maps.pick) {
    state.layers.pin = window.L.marker([12.9352, 77.6245], { draggable: true }).addTo(state.maps.pick);
    state.layers.pin.on('dragend', () => {
      const p = state.layers.pin.getLatLng();
      setLocation({ lat: p.lat, lng: p.lng }, 'pin dragged manually');
    });
    state.maps.pick.on('click', (e) => {
      state.layers.pin.setLatLng(e.latlng);
      setLocation({ lat: e.latlng.lat, lng: e.latlng.lng }, 'picked on map');
    });
  }
  $('locate-btn').onclick = locate;
  $('submit-btn').onclick = submitReport;
  $('status-filter').onchange = renderQueue;
  $('contractor-search').oninput = renderContractors;
  $('search').oninput = renderReview;
  locate();
}

/* -------------------------------------------------------------- uploader */

async function addPhotos(list) {
  for (const f of list) {
    if (state.photos.length >= E.CONFIG.maxPhotos) { toast('Photo limit', 'Maximum 4 photos per issue.', 'warn'); break; }
    if (!/image\/(jpeg|png)/i.test(f.type)) { toast('Unsupported file', `${f.name} is not a JPEG or PNG.`, 'error'); continue; }
    try {
      const [dataUrl, exif] = await Promise.all([compressImage(f), readExif(f)]);
      state.photos.push({ dataUrl, exif, name: f.name });
      if (exif.gps && !state.location) setLocation(exif.gps, 'GPS read from the photo');
    } catch (e) { toast('Could not read photo', e.message, 'error'); }
  }
  renderThumbs();
}

function renderThumbs() {
  $('thumbs').innerHTML = state.photos.map((p, i) => `
    <div class="thumb">
      <img src="${p.dataUrl}" alt="Angle ${i + 1}">
      <span class="angle">Angle ${i + 1}</span>
      ${p.exif?.gps ? '<span class="gps">GPS</span>' : ''}
      <button class="rm" data-i="${i}">×</button>
    </div>`).join('');
  $('thumbs').querySelectorAll('.rm').forEach((b) => {
    b.onclick = () => { state.photos.splice(Number(b.dataset.i), 1); renderThumbs(); };
  });
  $('photo-count').textContent = `${state.photos.length} / 4 photos`;
}

/* -------------------------------------------------------------- location */

function locate() {
  const badge = $('loc-badge');
  badge.textContent = 'Locating…';
  if (!navigator.geolocation) { badge.textContent = 'GPS unavailable'; badge.className = 'badge danger'; return; }
  navigator.geolocation.getCurrentPosition(
    (p) => setLocation({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }, `device GPS ±${Math.round(p.coords.accuracy)} m`),
    () => {
      badge.textContent = 'Location blocked';
      badge.className = 'badge danger';
      $('loc-text').textContent = 'Allow location access, drop a pin on the map, or upload a photo carrying GPS.';
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

function setLocation(p, source) {
  state.location = p;
  $('loc-badge').textContent = source;
  $('loc-badge').className = 'badge ok';
  $('loc-text').textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
  if (state.maps.pick) { state.layers.pin.setLatLng([p.lat, p.lng]); state.maps.pick.setView([p.lat, p.lng], 17); }
  renderNearby();
}

/* ---------------------------------------------------------------- submit */

async function submitReport() {
  const btn = $('submit-btn');
  if (!state.photos.length) return toast('Photo required', 'Add at least one photo of the issue.', 'error');
  if (!state.location) return toast('Location required', 'Allow GPS or drop a pin on the map.', 'error');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> CivicVision is analysing your photos…';
  $('ai-empty').classList.add('hidden');
  $('ai-result').classList.remove('hidden');
  const setStage = (msg) => {
    const el = document.getElementById('ai-stage');
    if (el) el.textContent = msg;
  };
  $('ai-result').innerHTML = `<div class="scan card" style="padding:26px;text-align:center">
      <div class="spinner" style="margin:0 auto 12px;width:24px;height:24px;color:var(--accent)"></div>
      <div style="font-weight:650">Analysing ${state.photos.length} photo angle${state.photos.length > 1 ? 's' : ''}…</div>
      <div class="small muted" style="margin-top:6px" id="ai-stage">Starting the vision model</div>
    </div>`;
  const offModel = onModelProgress((i) => {
    if (i.status === 'downloading') setStage(`Downloading the vision model — ${i.progress}% (one time, then cached)`);
    else if (i.status === 'ready') setStage('Vision model ready — classifying the issue');
    else if (i.status === 'error') setStage('Vision model unavailable, using the fallback engine');
  });
  const offOcr = onOcrProgress((i) => {
    if (i.status === 'loading-ocr') setStage('Loading the text reader to find the address');
    else if (i.status === 'reading') setStage(`Reading signboards in the photo — ${i.progress}%`);
  });

  try {
    const out = await E.reportIssue({
      sources: state.photos.map((p) => p.dataUrl),
      exifs: state.photos.map((p) => p.exif),
      description: $('description').value,
      landmark: $('landmark').value,
      location: state.location
    });
    renderAiResult(out);
    toast(out.duplicate ? 'Merged with an existing issue' : 'Report sent',
      out.duplicate ? out.message : `${out.issue.code} routed to ${out.issue.department?.name}.`,
      out.duplicate ? 'warn' : 'ok');
    state.photos = [];
    renderThumbs();
    $('description').value = ''; $('landmark').value = '';
    renderAll();
  } catch (e) {
    if (e.notCivicIssue) {
      const m = e.ai?.visionModel;
      $('ai-result').innerHTML = `
        <div class="badge warn" style="margin-bottom:10px">Not a civic issue</div>
        <div class="ai-verdict"><div style="font-size:30px">⚠</div>
          <div class="grow"><div class="cat">Report not filed</div>
            <div class="small muted">${esc(e.ai?.engine || 'vision model')}</div></div></div>
        <p class="small">${esc(e.message)}</p>
        ${m ? `<div class="tiny" style="margin-top:12px">Closest civic categories the model considered</div>
        <div>${m.topMatches.map((x) => `<span class="evidence-chip">${esc(x.label)} <b>${Math.round(x.probability * 100)}%</b></span>`).join('')}</div>
        <div class="small faint" style="margin-top:8px">All of these scored below the model's "everyday scene" prompts, so nothing was sent to a department.</div>` : ''}`;
      toast('Not filed', 'That photo does not look like a civic issue.', 'warn');
    } else {
      toast('Could not submit', e.message, 'error');
      $('ai-result').classList.add('hidden');
      $('ai-empty').classList.remove('hidden');
    }
  } finally {
    offModel(); offOcr();
    btn.disabled = false;
    btn.textContent = 'Analyse with AI & send to department';
  }
}

function renderAiResult({ issue, ai, duplicate, message }) {
  const pct = Math.round(ai.confidence * 100);
  $('ai-result').innerHTML = `
    ${duplicate ? `<div class="badge warn" style="margin-bottom:10px">Merged into existing cluster</div><p class="small muted">${esc(message)}</p>` : ''}
    <div class="ai-verdict">
      <div style="font-size:30px">${ICONS[ai.icon] || '◍'}</div>
      <div class="grow"><div class="cat">${esc(ai.categoryLabel)}</div>
        <div class="small muted">${esc(ai.engine)} · ${ai.processingMs} ms · ${ai.angles} angle${ai.angles > 1 ? 's' : ''}</div>
        ${ai.visionModel ? `<div class="small faint mono">${esc(ai.visionModel.name)} · Hugging Face</div>` : ''}</div>
      ${sevChip(ai.severity, ai.severityLabel)}
    </div>
    <div class="row space-between small"><span class="muted">Confidence</span><b class="mono">${pct}%</b></div>
    <div class="confidence"><i style="width:${pct}%"></i></div>
    ${ai.needsHumanReview ? '<div class="badge warn" style="margin-top:9px">Below threshold → queued for human review</div>' : ''}
    <p class="small" style="margin-top:13px">${esc(ai.summary)}</p>
    ${ai.visionModel ? `<div class="tiny" style="margin-top:12px">Vision model match</div>
    <div>${ai.visionModel.topMatches.map((m) => `<span class="evidence-chip">${esc(m.label)} <b>${Math.round(m.probability * 100)}%</b></span>`).join('')}</div>` : ''}
    <div class="tiny" style="margin-top:12px">Why the AI decided this</div>
    <div>${(ai.evidence || []).map((e) => `<span class="evidence-chip">${esc(e.label)} <b>${e.value}</b></span>`).join('') || '<span class="small faint">Colour and texture profile match.</span>'}</div>
    ${ai.textSignal?.matched?.length ? `<div class="small muted" style="margin-top:8px">Text signals: ${ai.textSignal.matched.map((m) => `<span class="badge">${esc(m)}</span>`).join(' ')}</div>` : ''}
    ${issue.addressAI ? `
    <div class="card" style="margin-top:14px;padding:13px;border-color:var(--accent-2)">
      <div class="row space-between"><div class="tiny">Address determined by AI</div>
        <span class="badge ${issue.addressAI.photoContributed ? 'accent' : ''}">${Math.round(issue.addressAI.confidence * 100)}% confident</span></div>
      <div style="font-weight:650;margin-top:4px">${esc(issue.addressAI.formatted)}</div>
      ${issue.addressAI.ocr.lines.length ? `<div class="small muted" style="margin-top:7px">Text read from your photo:
        ${issue.addressAI.ocr.lines.slice(0, 4).map((l) => `<span class="badge">${esc(l.text)}</span>`).join(' ')}</div>` : ''}
      <ul class="small faint" style="margin:8px 0 0 16px;padding:0">
        ${issue.addressAI.signals.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>` : ''}

    <div class="card" style="margin-top:14px;padding:13px;background:var(--surface-3)">
      <div class="tiny">Alert dispatched to</div>
      <div style="font-weight:700;font-size:15px;margin-top:3px">${esc(issue.department?.name || '')}</div>
      <div class="small muted">${esc(issue.department?.email || '')} · SLA ${issue.slaHours}h · due ${fmtDate(issue.dueAt)}</div>
      <div class="row small muted" style="margin-top:9px;gap:14px"><span class="mono">${esc(issue.code)}</span><span>${esc(issue.wardName || '')}</span></div>
      <div class="small faint" style="margin-top:6px">Location trust: ${esc(issue.location?.trust || '')}</div>
      ${issue.contractor ? `<div class="small" style="margin-top:8px">Contractor: <b>${esc(issue.contractor.name)}</b> ${issue.contractor.liable ? '<span class="badge danger">DLP active — liable</span>' : ''}</div>` : ''}
    </div>
    ${ai.alternates?.length ? `<div class="small muted" style="margin-top:11px">Also considered: ${ai.alternates.map((a) => `${esc(a.label)} (${Math.round(a.score * 100)}%)`).join(' · ')}</div>` : ''}`;
}

/* ----------------------------------------------------------------- lists */

function issueRow(i, extra = '') {
  const shot = i.evidence?.report?.[0]?.url;
  return `<div class="issue-card" data-id="${i.id}">
    ${shot ? `<img class="shot" src="${shot}">` : `<div class="shot" style="display:grid;place-items:center;font-size:22px">${ICONS[i.icon] || '◍'}</div>`}
    <div><div class="title">${esc(i.categoryLabel)}</div>
      <div class="meta"><span class="mono">${esc(i.code)}</span>${sevChip(i.severity, i.severityLabel)}
        <span>${esc(i.wardName || '')}</span><span>${timeAgo(i.createdAt)}</span>
        ${i.reportCount > 1 ? `<span class="badge accent">${i.reportCount} citizens</span>` : ''}
        ${i.humanReview ? '<span class="badge warn">needs review</span>' : ''}
        ${i.contractor?.liable ? '<span class="badge danger">contractor liable</span>' : ''}</div></div>
    <div class="right col" style="gap:5px;align-items:flex-end">${statusChip(i.status)}
      <span class="small" style="color:${i.overdue ? 'var(--danger)' : 'var(--faint)'}">${dueIn(i.dueAt)}</span>${extra}</div>
  </div>`;
}

const bind = (el) => el.querySelectorAll('.issue-card').forEach((c) => { c.onclick = () => openIssue(c.dataset.id); });

function renderMyIssues() {
  const u = E.currentUser();
  const rows = E.listIssues().filter((i) => i.reporterId === u.id || (i.corroborators || []).includes(u.id));
  $('m-total').textContent = rows.length;
  $('m-open').textContent = rows.filter((i) => E.OPEN_STATUSES.includes(i.status)).length;
  $('m-closed').textContent = rows.filter((i) => i.status === 'CLOSED').length;
  $('m-await').textContent = rows.filter((i) => i.status === 'RESOLVED').length;
  const el = $('my-list');
  el.innerHTML = rows.length ? rows.map((i) => issueRow(i, i.status === 'RESOLVED' ? '<span class="badge warn">Verify now</span>' : '')).join('')
    : '<div class="empty"><div class="big">▤</div>No reports yet. Head to “Report an issue”.</div>';
  bind(el);
}

function renderNearby() {
  const el = $('nearby-list');
  let rows = E.listIssues().filter((i) => i.status !== 'CLOSED');
  if (state.location) {
    rows = rows.map((i) => ({ ...i, _d: E.haversine(state.location, i.location) })).filter((i) => i._d < 3000).sort((a, b) => a._d - b._d);
  }
  rows = rows.slice(0, 5);
  $('nearby-count').textContent = rows.length;
  el.innerHTML = rows.length ? rows.map((i) => `
    <div class="issue-card" data-id="${i.id}" style="grid-template-columns:34px 1fr auto">
      <div style="font-size:20px;text-align:center">${ICONS[i.icon] || '◍'}</div>
      <div><div class="title" style="font-size:13px">${esc(i.categoryLabel)}</div>
        <div class="meta">${i._d !== undefined ? `${Math.round(i._d)} m away · ` : ''}${timeAgo(i.createdAt)}</div></div>
      ${statusChip(i.status)}</div>`).join('')
    : '<div class="small faint">No open issues reported nearby.</div>';
  bind(el);
}

function renderQueue() {
  const u = E.currentUser();
  const all = E.listIssues();
  const scoped = u.role === 'admin' ? all : all.filter((i) => i.departmentId === u.departmentId);
  const f = $('status-filter').value;
  const rows = scoped.filter((i) => (f ? i.status === f : E.OPEN_STATUSES.includes(i.status)));

  const done = scoped.filter((i) => ['RESOLVED', 'CLOSED'].includes(i.status));
  const onTime = done.filter((i) => i.resolution?.withinSla).length;
  $('s-open').textContent = scoped.filter((i) => E.OPEN_STATUSES.includes(i.status)).length;
  $('s-overdue').textContent = scoped.filter((i) => i.overdue).length;
  $('s-mine').textContent = scoped.filter((i) => i.assignedTo === u.id && E.OPEN_STATUSES.includes(i.status)).length;
  $('s-sla').textContent = done.length ? `${Math.round((onTime / done.length) * 100)}%` : '—';

  const el = $('queue-list');
  el.innerHTML = rows.length ? rows.map((i) => issueRow(i, i.assignedToName ? `<span class="small faint">${esc(i.assignedToName)}</span>` : '')).join('')
    : '<div class="empty"><div class="big">▤</div>Queue is clear.</div>';
  bind(el);
}

function renderAlerts() {
  const u = E.currentUser();
  const alerts = E.db.state.alerts
    .filter((a) => u.role === 'admin' || a.departmentId === u.departmentId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 40);
  $('alert-count').textContent = alerts.filter((a) => !a.read).length;
  const el = $('alert-feed');
  el.innerHTML = alerts.length ? alerts.map((a) => `
    <div class="alert-item ${a.level} ${a.read ? '' : 'unread'}" data-issue="${a.issueId || ''}" style="cursor:pointer">
      <div class="row space-between"><b class="small">${esc(a.title)}</b><span class="small faint">${timeAgo(a.createdAt)}</span></div>
      <div class="small muted" style="margin-top:3px">${esc(a.message)}</div></div>`).join('')
    : '<div class="small faint">No alerts yet. New AI-routed issues appear here instantly.</div>';
  el.querySelectorAll('[data-issue]').forEach((n) => { n.onclick = () => { if (n.dataset.issue) openIssue(n.dataset.issue); }; });
}

function renderCityMap() {
  const u = E.currentUser();
  const el = $('city-map');
  if (!state.maps.city) state.maps.city = makeMap(el, state.location || { lat: 12.9352, lng: 77.6245 }, 13);
  if (!state.maps.city) return;
  state.maps.city.invalidateSize();
  (state.layers.city || []).forEach((m) => state.maps.city.removeLayer(m));

  const rows = E.listIssues().filter((i) => (u.role === 'citizen' || u.role === 'admin') ? true : i.departmentId === u.departmentId);
  state.layers.city = rows.filter((i) => i.location).map((i) => {
    const color = severityColor(i.severity);
    const m = window.L.circleMarker([i.location.lat, i.location.lng], {
      radius: 7 + Math.min(6, i.reportCount || 1), color, weight: 2,
      fillColor: color, fillOpacity: i.status === 'CLOSED' ? 0.15 : 0.55
    }).addTo(state.maps.city);
    m.bindPopup(`<b>${esc(i.code)}</b> · ${esc(i.categoryLabel)}<br><span style="color:#8aa0b6">${esc(i.wardName || '')}</span><br>Severity ${i.severity} · ${esc(i.status)}`);
    m.on('click', () => openIssue(i.id));
    return m;
  });
}

/* ------------------------------------------------------------- analytics */

function renderAnalytics() {
  const o = E.overview();
  $('k-issues').textContent = o.totals.issues;
  $('k-citizens').textContent = `${o.totals.citizens} citizens · ${o.totals.corroborations} corroborations`;
  $('k-open').textContent = o.totals.open;
  $('k-overdue').textContent = `${o.totals.overdue} past SLA`;
  $('k-sla').textContent = o.sla.compliance === null ? '—' : `${o.sla.compliance}%`;
  $('k-avg').textContent = o.sla.avgResolutionHours ? `avg ${o.sla.avgResolutionHours}h to resolve` : 'no closures yet';
  $('k-conf').textContent = o.ai.avgConfidence ? `${Math.round(o.ai.avgConfidence * 100)}%` : '—';

  const max = Math.max(1, ...o.trend.map((t) => Math.max(t.reported, t.closed)));
  $('trend').innerHTML = o.trend.map((t) => `<i style="height:${(t.reported / max) * 100}%" title="${t.date}: ${t.reported} reported"></i>`).join('');
  $('trend-total').textContent = `${o.trend.reduce((a, t) => a + t.reported, 0)} reported · ${o.trend.reduce((a, t) => a + t.closed, 0)} closed`;

  const cMax = Math.max(1, ...o.byCategory.map((c) => c.count));
  $('cat-bars').innerHTML = o.byCategory.length ? o.byCategory.map((c) => `
    <div style="margin-bottom:10px"><div class="row space-between small"><span>${esc(c.label)}</span><b class="mono">${c.count}</b></div>
    <div class="bar-track"><i style="width:${(c.count / cMax) * 100}%"></i></div></div>`).join('')
    : '<div class="small faint">No issues reported yet.</div>';

  $('ai-status').innerHTML = `
    <div class="row space-between" style="margin-top:6px"><span class="small muted">Engine</span><b class="small">CivicVision v1 · ${o.ai.categories} categories</b></div>
    <div class="row space-between"><span class="small muted">Confidence threshold</span><b class="small mono">${o.ai.confidenceThreshold}</b></div>
    <div class="row space-between"><span class="small muted">Review queue</span><b class="small">${o.ai.humanReviewQueue}</b></div>
    <div class="row space-between"><span class="small muted">Human overrides</span><b class="small">${o.ai.overridden}</b></div>
    <div class="row space-between"><span class="small muted">Fake closures blocked</span><b class="small" style="color:var(--danger)">${o.ai.fakeClosuresBlocked}</b></div>
    <div class="row space-between"><span class="small muted">Contractor liabilities</span><b class="small">${o.totals.contractorLiabilities}</b></div>`;

  $('dept-table').innerHTML = `<table><thead><tr><th>Department</th><th>Issues</th><th>Open</th><th>Overdue</th><th>SLA</th></tr></thead><tbody>
    ${E.db.state.departments.map((d) => { const s = E.departmentStats(d.id); return `<tr>
      <td><span style="color:${d.color}">■</span> ${esc(d.name)}</td><td>${s.total}</td><td>${s.open}</td>
      <td style="${s.overdue ? 'color:var(--danger)' : ''}">${s.overdue}</td>
      <td>${s.slaCompliance === null ? '—' : `${s.slaCompliance}%`}</td></tr>`; }).join('')}</tbody></table>`;

  $('hot-count').textContent = o.hotspots.length;
  $('hotspot-list').innerHTML = o.hotspots.length ? o.hotspots.map((s) => `
    <div class="alert-item warning"><div class="row space-between"><b class="small">${esc(s.dominant || 'Mixed')} cluster</b>
    <span class="badge warn">${s.count} reports</span></div>
    <div class="small muted mono">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</div></div>`).join('')
    : '<div class="small faint">No recurring hotspots yet.</div>';
}

function renderReview() {
  const rows = E.listIssues();
  const review = rows.filter((i) => i.humanReview && i.status !== 'CLOSED');
  $('review-count').textContent = review.length;
  const rl = $('review-list');
  rl.innerHTML = review.length ? review.map((i) => issueRow(i)).join('') : '<div class="empty"><div class="big">✓</div>No low-confidence classifications pending.</div>';
  bind(rl);

  const q = ($('search').value || '').toLowerCase();
  const all = rows.filter((i) => !q || `${i.code} ${i.categoryLabel} ${i.wardName}`.toLowerCase().includes(q)).slice(0, 60);
  const al = $('all-list');
  al.innerHTML = all.length ? all.map((i) => issueRow(i)).join('') : '<div class="empty">No issues match.</div>';
  bind(al);
}

function renderContractors() {
  const u = E.currentUser();
  const q = ($('contractor-search').value || '').toLowerCase();
  const issues = E.db.state.issues;
  const rows = E.db.state.contractors
    .map((c) => {
      const linked = issues.filter((i) => i.contractor?.contractorId === c.id);
      return { ...c, linked: linked.length, openLiability: linked.filter((i) => i.contractor?.liable && i.status !== 'CLOSED').length };
    })
    .filter((c) => !q || `${c.name} ${c.agency} ${c.ward} ${c.workType}`.toLowerCase().includes(q))
    .sort((a, b) => b.openLiability - a.openLiability);

  $('contractor-table').innerHTML = `<table><thead><tr>
    <th>Contractor</th><th>Scope / ward</th><th>Contract</th><th>DLP ends</th><th>Linked issues</th><th>Rating</th><th></th></tr></thead>
    <tbody>${rows.map((c) => `<tr>
      <td><b>${esc(c.name)}</b>${c.blacklisted ? ' <span class="badge danger">blacklisted</span>' : ''}
        <div class="small faint">${esc(c.agency)} · ${esc(c.licenceNo)}</div></td>
      <td class="small">${esc(c.workType)}<div class="faint">${esc(c.ward)}</div></td>
      <td class="small mono">${money(c.contractValue)}<div class="faint">${esc(c.workOrderNo)}</div></td>
      <td class="small">${esc(c.defectLiabilityUntil)}${new Date(c.defectLiabilityUntil) > new Date() ? ' <span class="badge danger">active</span>' : ''}</td>
      <td>${c.linked} <span class="faint small">(${c.openLiability} open liability)</span></td>
      <td class="mono">${c.rating}</td>
      <td>${['supervisor', 'admin'].includes(u.role) ? `<button class="btn sm" data-notice="${c.id}">Issue notice</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>
    <p class="small faint" style="margin-top:10px">Records shaped after public works disclosures (work order, licence, defect liability period) and enriched live from OpenStreetMap construction tags.</p>`;

  document.querySelectorAll('[data-notice]').forEach((b) => {
    b.onclick = () => {
      const reason = prompt('Reason for the defect notice:');
      if (!reason) return;
      try { E.issueNotice(b.dataset.notice, { reason }); toast('Notice issued', 'Recorded against the contractor.', 'ok'); }
      catch (e) { toast('Failed', e.message, 'error'); }
    };
  });
}

/* ------------------------------------------------------------ issue modal */

function openIssue(id) {
  const issue = E.decorate(E.db.byId('issues', id));
  if (!issue) return;
  const u = E.currentUser();
  const audit = E.db.state.audit.filter((a) => a.issueId === id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const isStaff = ['worker', 'supervisor', 'admin'].includes(u.role);
  const sameDept = u.role === 'admin' || u.departmentId === issue.departmentId;
  const canVerify = issue.status === 'RESOLVED' && (issue.reporterId === u.id || (issue.corroborators || []).includes(u.id));
  const workers = E.db.state.users.filter((w) => w.departmentId === issue.departmentId && ['worker', 'supervisor'].includes(w.role));

  $('modal-root').innerHTML = `
  <div class="modal-backdrop" id="backdrop"><div class="modal">
    <div class="card-head">
      <div><div class="row wrap"><span class="badge mono">${esc(issue.code)}</span>${statusChip(issue.status)}${sevChip(issue.severity, issue.severityLabel)}
        <span class="badge ${issue.overdue ? 'danger' : ''}">${dueIn(issue.dueAt)}</span></div>
        <h2 style="margin-top:8px">${ICONS[issue.icon] || '◍'} ${esc(issue.categoryLabel)}</h2>
        <div class="muted small">${esc(issue.address || '')} · reported by ${esc(issue.reporterName)} ${timeAgo(issue.createdAt)}</div></div>
      <button class="btn sm" id="close-modal">Close</button>
    </div>

    <div class="grid cols-2">
      <div><div class="tiny">Citizen evidence</div>
        <div class="thumbs" style="grid-template-columns:repeat(2,1fr)">
          ${issue.evidence.report.map((e, i) => `<div class="thumb">${e.url ? `<img src="${e.url}">` : '<div class="empty small">photo pruned</div>'}<span class="angle">Angle ${i + 1}</span>${e.exif?.gps ? '<span class="gps">GPS</span>' : ''}</div>`).join('')}
        </div>
        ${issue.description ? `<p class="small" style="margin-top:9px">"${esc(issue.description)}"</p>` : ''}
        <div class="small faint">Location trust: ${esc(issue.location?.trust || '')} · ${esc(issue.geoSource || '')}</div>
      </div>
      <div>
        <div class="ai-panel">
          <div class="tiny">AI verdict</div>
          <div class="row" style="margin-top:5px"><b>${esc(issue.categoryLabel)}</b><span class="grow"></span><b class="mono">${Math.round((issue.ai?.confidence || 0) * 100)}%</b></div>
          <div class="confidence"><i style="width:${Math.round((issue.ai?.confidence || 0) * 100)}%"></i></div>
          <p class="small" style="margin-top:8px">${esc(issue.ai?.summary || '')}</p>
          <div>${(issue.ai?.evidence || []).map((e) => `<span class="evidence-chip">${esc(e.label)} <b>${e.value}</b></span>`).join('')}</div>
        </div>
        ${issue.contractor ? `<div class="card" style="margin-top:12px;padding:13px">
          <div class="tiny">Contractor accountability · open data</div>
          <div class="row" style="margin-top:4px"><b>${esc(issue.contractor.name)}</b><span class="grow"></span>
            ${issue.contractor.liable ? '<span class="badge danger">DLP active — liable</span>' : '<span class="badge">informational</span>'}</div>
          <div class="small faint">${esc(issue.contractor.agency || '')} ${issue.contractor.workOrderNo ? `· ${esc(issue.contractor.workOrderNo)}` : ''}</div>
          <ul class="small muted" style="margin:8px 0 0 16px;padding:0">${(issue.contractorReasoning || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          ${['supervisor', 'admin'].includes(u.role) && issue.contractor.contractorId ? '<button class="btn sm danger" style="margin-top:9px" id="notice-btn">Issue defect notice</button>' : ''}
        </div>` : ''}
      </div>
    </div>

    ${isStaff && sameDept ? `
    <div class="card" style="margin-top:16px;padding:15px">
      <div class="row wrap" style="gap:8px">
        ${issue.status === 'ROUTED' ? '<button class="btn" id="ack-btn">Acknowledge</button>' : ''}
        ${['ACKNOWLEDGED', 'ASSIGNED', 'ESCALATED', 'ROUTED'].includes(issue.status) ? '<button class="btn" id="start-btn">Start work</button>' : ''}
        ${['supervisor', 'admin'].includes(u.role) ? `<select id="assign-select" style="width:auto"><option value="">Assign to…</option>
          ${workers.map((w) => `<option value="${w.id}" ${issue.assignedTo === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
          <button class="btn" id="assign-btn">Assign</button>
          <select id="reclass-cat" style="width:auto">${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}" ${k === issue.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
          <button class="btn ghost" id="reclass-btn">Re-classify</button>` : ''}
      </div>
      ${['ASSIGNED', 'IN_PROGRESS', 'ACKNOWLEDGED', 'ESCALATED'].includes(issue.status) ? `
        <div class="grid cols-2" style="margin-top:15px">
          <div><div class="tiny">Step 1 · "Before" photos (min 2 angles)</div>
            <input type="file" id="before-input" accept="image/jpeg,image/png" multiple style="margin-top:6px">
            <button class="btn sm block" style="margin-top:8px" id="before-btn">Upload before evidence</button>
            <div class="small faint" style="margin-top:6px">${issue.evidence.before.length} already uploaded</div></div>
          <div><div class="tiny">Step 2 · "After" photos (min 2 angles) → closes the job</div>
            <input type="file" id="after-input" accept="image/jpeg,image/png" multiple style="margin-top:6px">
            <input id="resolve-notes" placeholder="Work done (e.g. patched with hot mix, 3 sqm)" style="margin-top:8px">
            <button class="btn primary sm block" style="margin-top:8px" id="resolve-btn">Submit &amp; run AI verification</button></div>
        </div>
        <div class="small faint" style="margin-top:8px">CivicVision compares your "after" photos against the original evidence. Re-uploading the same photo is detected and rejected.</div>` : ''}
      <div id="verify-out"></div>
    </div>` : ''}

    ${issue.evidence.after.length ? `
      <div class="tiny" style="margin-top:16px">Before / after evidence</div>
      <div class="ba-grid" style="margin-top:8px">
        <div class="side"><div class="badge">Before</div>${(issue.evidence.before.length ? issue.evidence.before : issue.evidence.report).slice(0, 2).map((e) => e.url ? `<img src="${e.url}">` : '').join('')}</div>
        <div class="side"><div class="badge ok">After</div>${issue.evidence.after.slice(0, 2).map((e) => e.url ? `<img src="${e.url}">` : '').join('')}</div>
      </div>
      ${issue.resolution?.verification ? `<div class="card" style="margin-top:12px;padding:13px">
        <div class="row space-between"><b class="small">CivicVision closure check</b>
          <span class="badge ${issue.resolution.verification.verified ? 'ok' : 'warn'}">${issue.resolution.verification.verified ? 'Improvement verified' : 'Not confirmed'} · ${issue.resolution.verification.improvementScore}</span></div>
        ${issue.resolution.verification.metrics.map((m) => `<div class="meter-row"><span>${esc(m.label)}</span>
          <span class="mono faint">${m.before}</span><span class="mono">${m.after}</span>
          <span class="badge ${m.improved ? 'ok' : ''}">${m.improved ? 'better' : 'flat'}</span></div>`).join('')}
        <div class="small muted" style="margin-top:8px">${issue.resolution.verification.notes.map(esc).join(' ')}</div></div>` : ''}` : ''}

    ${canVerify ? `<div class="card" style="margin-top:16px;padding:15px;border-color:var(--accent)">
      <b>Is this actually fixed?</b>
      <p class="small muted">Your confirmation closes the issue. If it is not fixed, it re-opens with a 24-hour escalated SLA.</p>
      <div class="row wrap" style="margin-top:8px">
        <select id="rating" style="width:150px"><option value="5">5 · Excellent</option><option value="4" selected>4 · Good</option>
          <option value="3">3 · Average</option><option value="2">2 · Poor</option><option value="1">1 · Very poor</option></select>
        <input id="comment" placeholder="Optional comment" class="grow"></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="accept-btn">Yes — close it</button>
        <button class="btn danger" id="reject-btn">No — re-open</button></div></div>` : ''}

    <div class="tiny" style="margin-top:18px">Audit trail</div>
    <div class="timeline" style="margin-top:10px">
      ${audit.map((a) => `<div class="ev ${a.actorRole === 'system' ? 'sys' : ''}">
        <div><b class="small">${esc(String(a.action).replace(/_/g, ' '))}</b> <span class="small muted">· ${esc(a.actorName)}</span></div>
        <div class="when">${fmtDate(a.createdAt)}</div></div>`).join('')}
    </div>
  </div></div>`;

  const close = () => { $('modal-root').innerHTML = ''; };
  $('close-modal').onclick = close;
  $('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') close(); };

  const run = (fn, okMsg) => {
    try { fn(); toast('Updated', okMsg, 'ok'); close(); renderAll(); }
    catch (e) { toast('Failed', e.message, 'error'); }
  };

  $('ack-btn')?.addEventListener('click', () => run(() => E.acknowledge(id), `${issue.code} acknowledged.`));
  $('start-btn')?.addEventListener('click', () => run(() => E.startWork(id), 'Work started.'));
  $('assign-btn')?.addEventListener('click', () => {
    const w = $('assign-select').value;
    if (!w) return toast('Pick an officer', 'Choose who should handle this.', 'warn');
    run(() => E.assign(id, w), 'Task assigned.');
  });
  $('reclass-btn')?.addEventListener('click', () =>
    run(() => E.reclassify(id, $('reclass-cat').value, issue.severity, 'Supervisor override'), 'Re-classified and re-routed.'));
  $('notice-btn')?.addEventListener('click', () => {
    const reason = prompt('Defect notice reason:', `Defect at ${issue.code} during liability period`);
    if (!reason) return;
    run(() => E.issueNotice(issue.contractor.contractorId, { reason, issueId: id }), 'Defect notice recorded.');
  });

  const upload = async (inputId, kind) => {
    const input = $(inputId);
    if (!input.files.length) return toast('No photos', 'Select at least 2 photos from different angles.', 'warn');
    const sources = [];
    for (const f of [...input.files].slice(0, 4)) sources.push(await compressImage(f));
    try {
      if (kind === 'before') {
        const out = await E.uploadBefore(id, sources);
        toast('Uploaded', out.angleCheck.note, 'ok');
      } else {
        const out = await E.resolveIssue(id, sources, $('resolve-notes').value);
        renderVerification(out.verification);
        toast('Verification complete', out.verification.verified ? 'Improvement confirmed.' : 'Improvement could not be confirmed.', out.verification.verified ? 'ok' : 'warn');
      }
      renderAll();
      setTimeout(() => openIssue(id), 400);
    } catch (e) {
      if (e.verification) renderVerification(e.verification);
      toast('Rejected', e.message, 'error');
    }
  };
  $('before-btn')?.addEventListener('click', () => upload('before-input', 'before'));
  $('resolve-btn')?.addEventListener('click', () => upload('after-input', 'after'));

  const verify = (accepted) => run(() => E.citizenVerify(id, {
    accepted, rating: Number($('rating').value), comment: $('comment').value
  }), accepted ? 'Issue closed and verified.' : 'Re-opened and escalated.');
  $('accept-btn')?.addEventListener('click', () => verify(true));
  $('reject-btn')?.addEventListener('click', () => verify(false));
}

function renderVerification(v) {
  const out = $('verify-out');
  if (!out) return;
  out.innerHTML = `<div class="card" style="margin-top:13px;padding:13px;border-color:${v.verified ? 'var(--ok)' : 'var(--warn)'}">
    <div class="row space-between"><b class="small">CivicVision closure verification</b>
      <span class="badge ${v.verified ? 'ok' : 'warn'}">${v.verified ? 'Verified' : 'Not confirmed'} · ${v.improvementScore}</span></div>
    ${v.metrics.map((m) => `<div class="meter-row"><span>${esc(m.label)}</span><span class="mono faint">${m.before}</span>
      <span class="mono">${m.after}</span><span class="badge ${m.improved ? 'ok' : ''}">${m.improved ? 'better' : 'flat'}</span></div>`).join('')}
    <div class="small muted" style="margin-top:8px">${v.notes.map(esc).join(' ')}</div></div>`;
}
