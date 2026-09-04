import {
  api, store, guard, renderShell, connectSocket, toast, esc, timeAgo, dueIn, fmtDate,
  sevChip, statusChip, ICONS, getPosition, makeMap, issueMarker, severityColor
} from '/js/core.js';

const user = guard();

const state = {
  photos: [],
  location: null,
  locationSource: null,
  issues: [],
  nearby: [],
  pickMap: null,
  pickMarker: null,
  cityMap: null,
  cityLayer: []
};

const NAV = [
  { key: 'report', label: 'Report an issue', icon: '＋', href: '#report' },
  { key: 'reports', label: 'My reports', icon: '▤', href: '#reports' },
  { key: 'map', label: 'City map', icon: '◉', href: '#map' }
];

const TITLES = {
  report: ['Report an issue', 'Photograph it, we handle the routing'],
  reports: ['My reports', 'Every report you filed, tracked to closure'],
  map: ['City map', 'Live civic issues around you']
};

function init() {
  showView(location.hash.replace('#', '') || 'report');
  window.addEventListener('hashchange', () => showView(location.hash.replace('#', '') || 'report'));

  document.getElementById('refresh-btn').onclick = () => { loadIssues(); toast('Refreshed', 'Latest data loaded.'); };
  setupUploader();
  setupLocation();
  document.getElementById('submit-btn').onclick = submitReport;

  loadIssues();
  connectSocket({
    'issue:updated': (issue) => { upsert(issue); toastIfMine(issue); },
    'issue:new': (issue) => upsert(issue),
    'notification:new': (n) => toast(n.title, n.message, n.level === 'warning' ? 'warn' : 'ok')
  });
}

function showView(view) {
  if (!TITLES[view]) view = 'report';
  document.querySelectorAll('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== view));
  renderShell({ active: view, nav: NAV, title: TITLES[view][0], subtitle: TITLES[view][1] });
  document.getElementById('trust-badge').textContent = `Trust ${Math.round((store.user.trustScore || 0.6) * 100)}%`;
  if (view === 'map') setTimeout(renderCityMap, 60);
  if (view === 'report') setTimeout(() => state.pickMap?.invalidateSize(), 60);
}

/* ------------------------------------------------------------- uploader */

function setupUploader() {
  const dz = document.getElementById('dropzone');
  const cam = document.getElementById('camera-input');
  const file = document.getElementById('file-input');

  document.getElementById('camera-btn').onclick = (e) => { e.stopPropagation(); cam.click(); };
  document.getElementById('file-btn').onclick = (e) => { e.stopPropagation(); file.click(); };
  dz.onclick = () => file.click();

  const add = (list) => {
    for (const f of list) {
      if (state.photos.length >= 4) { toast('Photo limit', 'Maximum 4 photos per issue.', 'warn'); break; }
      if (!/image\/(jpeg|png)/i.test(f.type)) { toast('Unsupported file', `${f.name} is not a JPEG or PNG.`, 'error'); continue; }
      state.photos.push({ file: f, url: URL.createObjectURL(f) });
    }
    renderThumbs();
  };

  cam.onchange = (e) => { add(e.target.files); e.target.value = ''; };
  file.onchange = (e) => { add(e.target.files); e.target.value = ''; };

  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => add(e.dataTransfer.files));
}

function renderThumbs() {
  const wrap = document.getElementById('thumbs');
  wrap.innerHTML = state.photos.map((p, i) => `
    <div class="thumb">
      <img src="${p.url}" alt="Angle ${i + 1}">
      <span class="angle">Angle ${i + 1}</span>
      <button class="rm" data-i="${i}" title="Remove">×</button>
    </div>`).join('');
  wrap.querySelectorAll('.rm').forEach((b) => {
    b.onclick = () => { URL.revokeObjectURL(state.photos[b.dataset.i].url); state.photos.splice(b.dataset.i, 1); renderThumbs(); };
  });
  document.getElementById('photo-count').textContent = `${state.photos.length} / 4 photos`;
}

/* ------------------------------------------------------------- location */

function setupLocation() {
  state.pickMap = makeMap(document.getElementById('pick-map'), { lat: 12.9352, lng: 77.6245 }, 15);
  if (state.pickMap) {
    state.pickMarker = window.L.marker([12.9352, 77.6245], { draggable: true }).addTo(state.pickMap);
    state.pickMarker.on('dragend', () => {
      const p = state.pickMarker.getLatLng();
      setLocation({ lat: p.lat, lng: p.lng, accuracy: null }, 'pin dragged manually');
    });
    state.pickMap.on('click', (e) => {
      state.pickMarker.setLatLng(e.latlng);
      setLocation({ lat: e.latlng.lat, lng: e.latlng.lng, accuracy: null }, 'picked on map');
    });
  }
  document.getElementById('locate-btn').onclick = locate;
  locate();
}

async function locate() {
  const badge = document.getElementById('loc-badge');
  badge.textContent = 'Locating…';
  try {
    const p = await getPosition();
    setLocation(p, `device GPS ±${Math.round(p.accuracy)} m`);
  } catch (e) {
    badge.textContent = 'Location blocked';
    badge.className = 'badge danger';
    document.getElementById('loc-text').textContent = 'Allow location access, drop a pin on the map, or upload a photo that carries GPS.';
  }
}

function setLocation(p, source) {
  state.location = p;
  state.locationSource = source;
  document.getElementById('loc-badge').textContent = source;
  document.getElementById('loc-badge').className = 'badge ok';
  document.getElementById('loc-text').textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
  if (state.pickMap) {
    state.pickMarker.setLatLng([p.lat, p.lng]);
    state.pickMap.setView([p.lat, p.lng], 17);
  }
  renderNearby();
}

/* --------------------------------------------------------------- submit */

async function submitReport() {
  const btn = document.getElementById('submit-btn');
  if (!state.photos.length) return toast('Photo required', 'Add at least one photo of the issue.', 'error');
  if (!state.location) return toast('Location required', 'Allow GPS or drop a pin on the map.', 'error');

  const fd = new FormData();
  state.photos.forEach((p) => fd.append('photos', p.file));
  fd.append('description', document.getElementById('description').value);
  fd.append('landmark', document.getElementById('landmark').value);
  fd.append('lat', state.location.lat);
  fd.append('lng', state.location.lng);
  if (state.location.accuracy) fd.append('accuracy', state.location.accuracy);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> CivicVision is analysing your photos…';
  showAiScanning();

  try {
    const out = await api('/issues', { method: 'POST', body: fd });
    renderAiResult(out);
    if (out.duplicate) {
      toast('Merged with an existing issue', out.message, 'warn');
    } else {
      toast('Report sent', `${out.issue.code} routed to ${out.issue.department?.name}.`, 'ok');
    }
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    renderThumbs();
    document.getElementById('description').value = '';
    document.getElementById('landmark').value = '';
    await loadIssues();
  } catch (e) {
    toast('Could not submit', e.message, 'error');
    document.getElementById('ai-result').classList.add('hidden');
    document.getElementById('ai-empty').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyse with AI & send to department';
  }
}

function showAiScanning() {
  document.getElementById('ai-empty').classList.add('hidden');
  const box = document.getElementById('ai-result');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="scan card" style="padding:26px;text-align:center">
      <div class="spinner" style="margin:0 auto 12px;width:24px;height:24px;color:var(--accent)"></div>
      <div style="font-weight:650">Reading ${state.photos.length} photo angle${state.photos.length > 1 ? 's' : ''}…</div>
      <div class="small muted" style="margin-top:6px">Colour · texture · structure · specular analysis → category → department</div>
    </div>`;
}

function renderAiResult({ issue, ai, duplicate, message }) {
  document.getElementById('ai-empty').classList.add('hidden');
  const box = document.getElementById('ai-result');
  box.classList.remove('hidden');
  const pct = Math.round(ai.confidence * 100);

  box.innerHTML = `
    ${duplicate ? `<div class="badge warn" style="margin-bottom:10px">Merged into existing cluster</div>
      <p class="small muted">${esc(message)}</p>` : ''}
    <div class="ai-verdict">
      <div style="font-size:30px">${ICONS[ai.icon] || '◍'}</div>
      <div class="grow">
        <div class="cat">${esc(ai.categoryLabel)}</div>
        <div class="small muted">${esc(ai.engine)} · ${ai.processingMs} ms · ${ai.angles} angle${ai.angles > 1 ? 's' : ''}</div>
      </div>
      ${sevChip(ai.severity, ai.severityLabel)}
    </div>

    <div class="row space-between small"><span class="muted">Confidence</span><b class="mono">${pct}%</b></div>
    <div class="confidence"><i style="width:${pct}%"></i></div>
    ${ai.needsHumanReview ? '<div class="badge warn" style="margin-top:9px">Below threshold → queued for human review</div>' : ''}

    <p class="small" style="margin-top:13px">${esc(ai.summary)}</p>

    <div class="tiny" style="margin-top:12px">Why the AI decided this</div>
    <div>${(ai.evidence || []).map((e) => `<span class="evidence-chip">${esc(e.label)} <b>${e.value}</b></span>`).join('') || '<span class="small faint">Colour and texture profile match.</span>'}</div>
    ${ai.textSignal?.matched?.length ? `<div class="small muted" style="margin-top:8px">Text signals: ${ai.textSignal.matched.map((m) => `<span class="badge">${esc(m)}</span>`).join(' ')}</div>` : ''}
    ${ai.hazards?.length ? `<div class="small" style="margin-top:8px;color:var(--warn)">Hazards: ${ai.hazards.map(esc).join(', ')}</div>` : ''}

    <div class="card" style="margin-top:14px;padding:13px;background:var(--surface-3)">
      <div class="tiny">Alert dispatched to</div>
      <div style="font-weight:700;font-size:15px;margin-top:3px">${esc(issue.department?.name || '')}</div>
      <div class="small muted">${esc(issue.department?.email || '')} · SLA ${issue.slaHours}h · due ${fmtDate(issue.dueAt)}</div>
      <div class="row small muted" style="margin-top:9px;gap:14px">
        <span class="mono">${esc(issue.code)}</span>
        <span>${esc(issue.wardName || issue.address || '')}</span>
      </div>
      <div class="small faint" style="margin-top:6px">Location trust: ${esc(issue.location?.trust || '')}</div>
    </div>

    ${ai.alternates?.length ? `<div class="small muted" style="margin-top:11px">Also considered: ${ai.alternates.map((a) => `${esc(a.label)} (${Math.round(a.score * 100)}%)`).join(' · ')}</div>` : ''}
    <button class="btn block sm" style="margin-top:12px" onclick="location.hash='#reports'">Track this report</button>`;
}

/* ---------------------------------------------------------------- issues */

async function loadIssues() {
  const [mine, all] = await Promise.all([
    api('/issues?scope=mine'),
    api('/issues?limit=300')
  ]);
  state.issues = mine.issues;
  state.nearby = all.issues;
  renderMyIssues();
  renderNearby();
  if (!document.querySelector('[data-view="map"]').classList.contains('hidden')) renderCityMap();
}

function upsert(issue) {
  const lists = [state.issues, state.nearby];
  for (const list of lists) {
    const i = list.findIndex((x) => x.id === issue.id);
    if (i >= 0) list[i] = issue;
  }
  if (issue.reporterId === store.user.id && !state.issues.find((x) => x.id === issue.id)) state.issues.unshift(issue);
  if (!state.nearby.find((x) => x.id === issue.id)) state.nearby.unshift(issue);
  renderMyIssues();
  renderNearby();
}

function toastIfMine(issue) {
  if (issue.reporterId !== store.user.id) return;
  toast(`${issue.code} · ${String(issue.status).replace('_', ' ')}`, issue.categoryLabel, issue.status === 'CLOSED' ? 'ok' : '');
}

function issueRow(issue, { action = '' } = {}) {
  const shot = issue.evidence?.report?.[0]?.url;
  return `
    <div class="issue-card" data-id="${issue.id}">
      ${shot ? `<img class="shot" src="${shot}" alt="">` : `<div class="shot" style="display:grid;place-items:center;font-size:22px">${ICONS[issue.icon] || '◍'}</div>`}
      <div>
        <div class="title">${esc(issue.categoryLabel)}</div>
        <div class="meta">
          <span class="mono">${esc(issue.code)}</span>
          ${sevChip(issue.severity, issue.severityLabel)}
          <span>${esc(issue.wardName || issue.address || 'Unknown location')}</span>
          <span>${timeAgo(issue.createdAt)}</span>
          ${issue.reportCount > 1 ? `<span class="badge accent">${issue.reportCount} reports</span>` : ''}
        </div>
      </div>
      <div class="right col" style="gap:6px;align-items:flex-end">
        ${statusChip(issue.status)}
        <span class="small ${issue.overdue ? 'danger' : 'faint'}" style="${issue.overdue ? 'color:var(--danger)' : ''}">${dueIn(issue.dueAt)}</span>
        ${action}
      </div>
    </div>`;
}

function renderMyIssues() {
  const list = document.getElementById('my-list');
  const rows = state.issues;
  document.getElementById('m-total').textContent = rows.length;
  document.getElementById('m-open').textContent = rows.filter((i) => ['ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'].includes(i.status)).length;
  document.getElementById('m-closed').textContent = rows.filter((i) => i.status === 'CLOSED').length;
  document.getElementById('m-await').textContent = rows.filter((i) => i.status === 'RESOLVED').length;

  list.innerHTML = rows.length
    ? rows.map((i) => issueRow(i, {
        action: i.status === 'RESOLVED' ? '<span class="badge warn">Verify now</span>' : ''
      })).join('')
    : '<div class="empty"><div class="big">▤</div>No reports yet. Head to “Report an issue”.</div>';
  list.querySelectorAll('.issue-card').forEach((c) => { c.onclick = () => openIssue(c.dataset.id); });
}

function renderNearby() {
  const wrap = document.getElementById('nearby-list');
  if (!wrap) return;
  let rows = state.nearby.filter((i) => i.status !== 'CLOSED');
  if (state.location) {
    rows = rows.map((i) => ({ ...i, _d: dist(state.location, i.location) }))
      .filter((i) => i._d < 3000).sort((a, b) => a._d - b._d);
  }
  rows = rows.slice(0, 5);
  document.getElementById('nearby-count').textContent = rows.length;
  wrap.innerHTML = rows.length
    ? rows.map((i) => `
      <div class="issue-card" data-id="${i.id}" style="grid-template-columns:34px 1fr auto">
        <div style="font-size:20px;text-align:center">${ICONS[i.icon] || '◍'}</div>
        <div>
          <div class="title" style="font-size:13px">${esc(i.categoryLabel)}</div>
          <div class="meta">${i._d !== undefined ? `${Math.round(i._d)} m away · ` : ''}${timeAgo(i.createdAt)}</div>
        </div>
        ${statusChip(i.status)}
      </div>`).join('')
    : '<div class="small faint">No open issues reported nearby.</div>';
  wrap.querySelectorAll('.issue-card').forEach((c) => { c.onclick = () => openIssue(c.dataset.id); });
}

function dist(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function renderCityMap() {
  const el = document.getElementById('city-map');
  if (!state.cityMap) state.cityMap = makeMap(el, state.location || { lat: 12.9352, lng: 77.6245 }, 13);
  if (!state.cityMap) return;
  state.cityMap.invalidateSize();
  state.cityLayer.forEach((m) => state.cityMap.removeLayer(m));
  state.cityLayer = state.nearby.map((i) => issueMarker(state.cityMap, i, (issue) => openIssue(issue.id))).filter(Boolean);
}

/* ----------------------------------------------------------- issue modal */

async function openIssue(id) {
  const { issue, audit } = await api(`/issues/${id}`);
  const root = document.getElementById('modal-root');
  const canVerify = issue.status === 'RESOLVED' &&
    (issue.reporterId === store.user.id || (issue.corroborators || []).includes(store.user.id));

  root.innerHTML = `
  <div class="modal-backdrop" id="backdrop">
    <div class="modal">
      <div class="card-head">
        <div>
          <div class="row"><span class="mono badge">${esc(issue.code)}</span>${statusChip(issue.status)}${sevChip(issue.severity, issue.severityLabel)}</div>
          <h2 style="margin-top:8px">${ICONS[issue.icon] || '◍'} ${esc(issue.categoryLabel)}</h2>
          <div class="muted small">${esc(issue.address || '')}</div>
        </div>
        <button class="btn sm" id="close-modal">Close</button>
      </div>

      <div class="grid cols-2">
        <div>
          <div class="tiny">Citizen evidence (before)</div>
          <div class="thumbs" style="grid-template-columns:repeat(2,1fr)">
            ${issue.evidence.report.map((e, i) => `<div class="thumb"><img src="${e.url}"><span class="angle">Angle ${i + 1}</span>${e.exif?.gps ? '<span class="gps">GPS</span>' : ''}</div>`).join('')}
          </div>
          ${issue.description ? `<p class="small" style="margin-top:10px">"${esc(issue.description)}"</p>` : ''}
        </div>

        <div>
          <div class="ai-panel">
            <div class="tiny">AI classification</div>
            <div class="row" style="margin-top:6px"><b>${esc(issue.categoryLabel)}</b><span class="grow"></span><b class="mono">${Math.round((issue.ai?.confidence || 0) * 100)}%</b></div>
            <div class="confidence"><i style="width:${Math.round((issue.ai?.confidence || 0) * 100)}%"></i></div>
            <p class="small" style="margin-top:9px">${esc(issue.ai?.summary || '')}</p>
            <div>${(issue.ai?.evidence || []).map((e) => `<span class="evidence-chip">${esc(e.label)} <b>${e.value}</b></span>`).join('')}</div>
            <div class="small faint" style="margin-top:8px">${esc(issue.ai?.engine || '')}</div>
          </div>
          <div class="card" style="margin-top:12px;padding:13px">
            <div class="tiny">Routing</div>
            <div style="font-weight:650;margin-top:3px">${esc(issue.department?.name || '')}</div>
            <div class="small muted">SLA ${issue.slaHours}h · ${dueIn(issue.dueAt)} · ${issue.reportCount || 1} citizen report(s)</div>
            ${issue.assignedToName ? `<div class="small" style="margin-top:6px">Field officer: <b>${esc(issue.assignedToName)}</b></div>` : ''}
            ${issue.contractor ? `
              <div class="tiny" style="margin-top:11px">Contractor accountability</div>
              <div class="small"><b>${esc(issue.contractor.name)}</b> ${issue.contractor.liable ? '<span class="badge danger">Liable · DLP active</span>' : '<span class="badge">Informational</span>'}</div>
              <div class="small faint">${esc(issue.contractor.agency || '')} ${issue.contractor.workOrderNo ? `· ${esc(issue.contractor.workOrderNo)}` : ''}</div>
              <div class="small faint" style="margin-top:5px">Source: ${esc(issue.contractor.source)}</div>` : ''}
          </div>
        </div>
      </div>

      ${issue.evidence.after.length ? `
        <div class="tiny" style="margin-top:18px">Closure evidence</div>
        <div class="ba-grid" style="margin-top:8px">
          <div class="side"><div class="badge">Before</div>${(issue.evidence.before.length ? issue.evidence.before : issue.evidence.report).slice(0, 2).map((e) => `<img src="${e.url}">`).join('')}</div>
          <div class="side"><div class="badge ok">After</div>${issue.evidence.after.slice(0, 2).map((e) => `<img src="${e.url}">`).join('')}</div>
        </div>
        ${issue.resolution?.verification ? `
          <div class="card" style="margin-top:12px;padding:13px">
            <div class="row space-between">
              <b class="small">CivicVision closure check</b>
              <span class="badge ${issue.resolution.verification.verified ? 'ok' : 'warn'}">
                ${issue.resolution.verification.verified ? 'Improvement verified' : 'Not confirmed'} · score ${issue.resolution.verification.improvementScore}
              </span>
            </div>
            ${issue.resolution.verification.metrics.map((m) => `
              <div class="meter-row">
                <span>${esc(m.label)}</span><span class="mono faint">${m.before}</span>
                <span class="mono">${m.after}</span>
                <span class="badge ${m.improved ? 'ok' : ''}">${m.improved ? 'better' : 'flat'}</span>
              </div>`).join('')}
            <div class="small muted" style="margin-top:8px">${issue.resolution.verification.notes.map(esc).join(' ')}</div>
          </div>` : ''}
        ${issue.resolution?.notes ? `<p class="small" style="margin-top:10px">Field note: "${esc(issue.resolution.notes)}"</p>` : ''}
      ` : ''}

      ${canVerify ? `
        <div class="card" style="margin-top:16px;padding:15px;border-color:var(--accent)">
          <b>Is this actually fixed?</b>
          <p class="small muted">Your confirmation closes the issue. If it is not fixed, it re-opens with a 24-hour escalated SLA.</p>
          <div class="row wrap" style="margin-top:8px">
            <select id="rating" style="width:150px">
              <option value="5">5 · Excellent</option><option value="4" selected>4 · Good</option>
              <option value="3">3 · Average</option><option value="2">2 · Poor</option><option value="1">1 · Very poor</option>
            </select>
            <input id="comment" placeholder="Optional comment" class="grow">
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn primary" id="accept-btn">Yes — close it</button>
            <button class="btn danger" id="reject-btn">No — re-open</button>
          </div>
        </div>` : ''}

      <div class="tiny" style="margin-top:18px">Audit trail</div>
      <div class="timeline" style="margin-top:10px">
        ${audit.map((a) => `
          <div class="ev ${a.actorRole === 'system' ? 'sys' : ''}">
            <div><b class="small">${esc(String(a.action).replace(/_/g, ' '))}</b> <span class="small muted">by ${esc(a.actorName)}</span></div>
            <div class="when">${fmtDate(a.createdAt)}</div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;

  const close = () => { root.innerHTML = ''; };
  document.getElementById('close-modal').onclick = close;
  document.getElementById('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') close(); };

  if (canVerify) {
    const send = async (accepted) => {
      try {
        await api(`/issues/${issue.id}/verify`, {
          method: 'POST',
          body: {
            accepted,
            rating: Number(document.getElementById('rating').value),
            comment: document.getElementById('comment').value
          }
        });
        toast(accepted ? 'Thank you' : 'Re-opened', accepted ? 'Issue closed and verified.' : 'The department has been alerted.', accepted ? 'ok' : 'warn');
        close();
        loadIssues();
      } catch (e) { toast('Failed', e.message, 'error'); }
    };
    document.getElementById('accept-btn').onclick = () => send(true);
    document.getElementById('reject-btn').onclick = () => send(false);
  }
}

/* Bootstrap last: init() reads module-level constants declared above. */
if (user) init();
