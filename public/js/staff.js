import {
  api, store, guard, renderShell, connectSocket, toast, esc, timeAgo, dueIn, fmtDate,
  sevChip, statusChip, ICONS, makeMap, issueMarker, money
} from '/js/core.js';

const user = guard(['worker', 'supervisor', 'admin']);

const state = { issues: [], alerts: [], workers: [], contractors: [], map: null, layer: [], department: null };
const isSupervisor = () => ['supervisor', 'admin'].includes(store.user.role);

const NAV = [
  { key: 'queue', label: 'Work queue', icon: '▤', href: '#queue' },
  { key: 'field', label: 'My field tasks', icon: '⚑', href: '#field' },
  { key: 'contractors', label: 'Contractors', icon: '⚖', href: '#contractors' },
  { key: 'team', label: 'Field team', icon: '☰', href: '#team' }
];
const TITLES = {
  queue: ['Department console', 'AI-routed issues owned by your department'],
  field: ['My field tasks', 'Jobs assigned to you, with photo evidence capture'],
  contractors: ['Contractor accountability', 'Open-data contract records and defect liability'],
  team: ['Field team', 'Workload across your department']
};

async function init() {
  const me = await api('/auth/me');
  state.department = me.department;
  show(location.hash.replace('#', '') || 'queue');
  window.addEventListener('hashchange', () => show(location.hash.replace('#', '') || 'queue'));
  document.getElementById('refresh-btn').onclick = loadAll;
  document.getElementById('status-filter').onchange = renderQueue;
  document.getElementById('contractor-search').oninput = renderContractors;

  await loadAll();
  connectSocket({
    'alert:new': (a) => { state.alerts.unshift(a); renderAlerts(); toast(a.title, a.message, a.level === 'critical' ? 'error' : a.level === 'warning' ? 'warn' : 'ok'); },
    'issue:updated': (i) => { upsert(i); },
    'issue:new': (i) => { upsert(i); },
    'task:assigned': (i) => toast('New task assigned to you', `${i.code} · ${i.categoryLabel}`, 'warn')
  });
}

function show(view) {
  if (!TITLES[view]) view = 'queue';
  document.querySelectorAll('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== view));
  renderShell({
    active: view, nav: NAV,
    title: state.department ? state.department.name : TITLES[view][0],
    subtitle: TITLES[view][1]
  });
  if (view === 'queue') setTimeout(renderMap, 80);
}

async function loadAll() {
  const [issues, alerts] = await Promise.all([
    api('/issues?limit=300'),
    api(`/departments/${store.user.departmentId || state.department?.id || ''}/alerts`).catch(() => ({ alerts: [] }))
  ]);
  state.issues = issues.issues;
  state.alerts = alerts.alerts || [];
  if (isSupervisor() || true) {
    api(`/departments/${store.user.departmentId || state.department?.id}/workers`)
      .then((w) => { state.workers = w.workers; renderTeam(); }).catch(() => {});
  }
  api('/contractors').then((c) => { state.contractors = c.contractors; renderContractors(); }).catch(() => {});
  renderAll();
}

function upsert(issue) {
  const i = state.issues.findIndex((x) => x.id === issue.id);
  if (i >= 0) state.issues[i] = issue; else state.issues.unshift(issue);
  renderAll();
}

function renderAll() { renderStats(); renderQueue(); renderField(); renderAlerts(); renderMap(); }

const OPEN = ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'];

function renderStats() {
  const mine = state.issues.filter((i) => i.assignedTo === store.user.id && OPEN.includes(i.status));
  const open = state.issues.filter((i) => OPEN.includes(i.status));
  const done = state.issues.filter((i) => ['RESOLVED', 'CLOSED'].includes(i.status));
  const onTime = done.filter((i) => i.resolution?.withinSla).length;
  document.getElementById('s-open').textContent = open.length;
  document.getElementById('s-overdue').textContent = open.filter((i) => i.overdue).length;
  document.getElementById('s-mine').textContent = mine.length;
  document.getElementById('s-sla').textContent = done.length ? `${Math.round((onTime / done.length) * 100)}%` : '—';
}

function issueRow(issue) {
  const shot = issue.evidence?.report?.[0]?.url;
  return `
    <div class="issue-card" data-id="${issue.id}">
      ${shot ? `<img class="shot" src="${shot}">` : `<div class="shot" style="display:grid;place-items:center;font-size:22px">${ICONS[issue.icon] || '◍'}</div>`}
      <div>
        <div class="title">${esc(issue.categoryLabel)}</div>
        <div class="meta">
          <span class="mono">${esc(issue.code)}</span>
          ${sevChip(issue.severity, issue.severityLabel)}
          <span>${esc(issue.wardName || issue.address || '')}</span>
          <span>${timeAgo(issue.createdAt)}</span>
          ${issue.reportCount > 1 ? `<span class="badge accent">${issue.reportCount} citizens</span>` : ''}
          ${issue.humanReview ? '<span class="badge warn">needs review</span>' : ''}
          ${issue.contractor?.liable ? '<span class="badge danger">contractor liable</span>' : ''}
        </div>
      </div>
      <div class="right col" style="gap:6px;align-items:flex-end">
        ${statusChip(issue.status)}
        <span class="small" style="color:${issue.overdue ? 'var(--danger)' : 'var(--faint)'}">${dueIn(issue.dueAt)}</span>
        ${issue.assignedToName ? `<span class="small faint">${esc(issue.assignedToName)}</span>` : ''}
      </div>
    </div>`;
}

function bind(list) {
  list.querySelectorAll('.issue-card').forEach((c) => { c.onclick = () => openIssue(c.dataset.id); });
}

function renderQueue() {
  const f = document.getElementById('status-filter').value;
  const rows = state.issues.filter((i) => (f ? i.status === f : OPEN.includes(i.status)));
  const el = document.getElementById('queue-list');
  el.innerHTML = rows.length ? rows.map(issueRow).join('') : '<div class="empty"><div class="big">▤</div>Queue is clear.</div>';
  bind(el);
}

function renderField() {
  const rows = state.issues.filter((i) => i.assignedTo === store.user.id);
  const el = document.getElementById('field-list');
  el.innerHTML = rows.length ? rows.map(issueRow).join('') : '<div class="empty"><div class="big">⚑</div>No tasks assigned to you yet.</div>';
  bind(el);
}

function renderAlerts() {
  const el = document.getElementById('alert-feed');
  document.getElementById('alert-count').textContent = state.alerts.filter((a) => !a.read).length;
  el.innerHTML = state.alerts.length ? state.alerts.slice(0, 40).map((a) => `
    <div class="alert-item ${a.level} ${a.read ? '' : 'unread'}" data-issue="${a.issueId || ''}" style="cursor:pointer">
      <div class="row space-between"><b class="small">${esc(a.title)}</b><span class="small faint">${timeAgo(a.createdAt)}</span></div>
      <div class="small muted" style="margin-top:3px">${esc(a.message)}</div>
    </div>`).join('') : '<div class="small faint">No alerts yet. New AI-routed issues appear here instantly.</div>';
  el.querySelectorAll('[data-issue]').forEach((n) => {
    n.onclick = () => { if (n.dataset.issue) openIssue(n.dataset.issue); };
  });
}

function renderMap() {
  const el = document.getElementById('dept-map');
  if (!el || el.offsetParent === null) return;
  if (!state.map) state.map = makeMap(el, { lat: 12.9352, lng: 77.6245 }, 12);
  if (!state.map) return;
  state.map.invalidateSize();
  state.layer.forEach((m) => state.map.removeLayer(m));
  state.layer = state.issues.filter((i) => OPEN.includes(i.status))
    .map((i) => issueMarker(state.map, i, (x) => openIssue(x.id))).filter(Boolean);
}

function renderTeam() {
  document.getElementById('team-table').innerHTML = `
    <table><thead><tr><th>Officer</th><th>Role</th><th>Employee ID</th><th>Open tasks</th><th>Completed</th></tr></thead>
    <tbody>${state.workers.map((w) => `
      <tr><td><b>${esc(w.name)}</b><div class="small faint">${esc(w.email)}</div></td>
      <td><span class="badge ${w.role === 'supervisor' ? 'warn' : 'accent'}">${esc(w.role)}</span></td>
      <td class="mono small">${esc(w.employeeId || '—')}</td>
      <td>${w.openTasks}</td><td>${w.completed}</td></tr>`).join('')}</tbody></table>`;
}

function renderContractors() {
  const q = (document.getElementById('contractor-search')?.value || '').toLowerCase();
  const rows = state.contractors.filter((c) => !q || `${c.name} ${c.agency} ${c.ward} ${c.workType}`.toLowerCase().includes(q));
  document.getElementById('contractor-table').innerHTML = `
    <table><thead><tr>
      <th>Contractor</th><th>Scope / ward</th><th>Contract</th><th>DLP ends</th><th>Linked issues</th><th>Rating</th><th></th>
    </tr></thead><tbody>${rows.map((c) => `
      <tr>
        <td><b>${esc(c.name)}</b>${c.blacklisted ? ' <span class="badge danger">blacklisted</span>' : ''}
          <div class="small faint">${esc(c.agency)} · ${esc(c.licenceNo)}</div></td>
        <td class="small">${esc(c.workType)}<div class="faint">${esc(c.ward)}</div></td>
        <td class="small mono">${money(c.contractValue)}<div class="faint">${esc(c.workOrderNo)}</div></td>
        <td class="small ${new Date(c.defectLiabilityUntil) > new Date() ? '' : 'faint'}">
          ${esc(c.defectLiabilityUntil)}${new Date(c.defectLiabilityUntil) > new Date() ? ' <span class="badge danger">active</span>' : ''}</td>
        <td>${c.accountability.linkedIssues} <span class="faint small">(${c.accountability.openLiability} open liability)</span></td>
        <td class="mono">${c.rating}</td>
        <td>${isSupervisor() ? `<button class="btn sm" data-notice="${c.id}">Issue notice</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;

  document.querySelectorAll('[data-notice]').forEach((b) => {
    b.onclick = async () => {
      const reason = prompt('Reason for the defect notice:');
      if (!reason) return;
      try {
        await api(`/contractors/${b.dataset.notice}/notice`, { method: 'POST', body: { reason } });
        toast('Notice issued', 'Recorded against the contractor and their rating was reduced.', 'ok');
        const c = await api('/contractors'); state.contractors = c.contractors; renderContractors();
      } catch (e) { toast('Failed', e.message, 'error'); }
    };
  });
}

/* ------------------------------------------------------------ issue modal */

async function openIssue(id) {
  const { issue, audit } = await api(`/issues/${id}`);
  const root = document.getElementById('modal-root');
  const mine = issue.assignedTo === store.user.id;

  root.innerHTML = `
  <div class="modal-backdrop" id="backdrop"><div class="modal">
    <div class="card-head">
      <div>
        <div class="row wrap">
          <span class="badge mono">${esc(issue.code)}</span>${statusChip(issue.status)}${sevChip(issue.severity, issue.severityLabel)}
          <span class="badge ${issue.overdue ? 'danger' : ''}">${dueIn(issue.dueAt)}</span>
        </div>
        <h2 style="margin-top:8px">${ICONS[issue.icon] || '◍'} ${esc(issue.categoryLabel)}</h2>
        <div class="muted small">${esc(issue.address || '')} · reported by ${esc(issue.reporterName)} ${timeAgo(issue.createdAt)}</div>
      </div>
      <button class="btn sm" id="close-modal">Close</button>
    </div>

    <div class="grid cols-2">
      <div>
        <div class="tiny">Citizen evidence</div>
        <div class="thumbs" style="grid-template-columns:repeat(2,1fr)">
          ${issue.evidence.report.map((e, i) => `<div class="thumb"><img src="${e.url}"><span class="angle">Angle ${i + 1}</span>${e.exif?.gps ? '<span class="gps">GPS</span>' : ''}</div>`).join('')}
        </div>
        ${issue.description ? `<p class="small" style="margin-top:9px">"${esc(issue.description)}"</p>` : ''}
        ${issue.landmark ? `<p class="small faint">Landmark: ${esc(issue.landmark)}</p>` : ''}
        <div class="small faint">Location trust: ${esc(issue.location?.trust || '')} · ${esc(issue.geoSource)}</div>
      </div>
      <div>
        <div class="ai-panel">
          <div class="tiny">AI verdict</div>
          <div class="row" style="margin-top:5px"><b>${esc(issue.categoryLabel)}</b><span class="grow"></span><b class="mono">${Math.round((issue.ai?.confidence || 0) * 100)}%</b></div>
          <div class="confidence"><i style="width:${Math.round((issue.ai?.confidence || 0) * 100)}%"></i></div>
          <p class="small" style="margin-top:8px">${esc(issue.ai?.summary || '')}</p>
          <div>${(issue.ai?.evidence || []).map((e) => `<span class="evidence-chip">${esc(e.label)} <b>${e.value}</b></span>`).join('')}</div>
          ${issue.ai?.alternates?.length ? `<div class="small muted" style="margin-top:7px">Alternates: ${issue.ai.alternates.map((a) => `${esc(a.label)} ${Math.round(a.score * 100)}%`).join(' · ')}</div>` : ''}
        </div>
        ${issue.contractor ? `
        <div class="card" style="margin-top:12px;padding:13px">
          <div class="tiny">Contractor accountability · open data</div>
          <div class="row" style="margin-top:4px"><b>${esc(issue.contractor.name)}</b><span class="grow"></span>
            ${issue.contractor.liable ? '<span class="badge danger">DLP active — liable</span>' : '<span class="badge">informational</span>'}</div>
          <div class="small faint">${esc(issue.contractor.agency || '')} ${issue.contractor.workOrderNo ? `· ${esc(issue.contractor.workOrderNo)}` : ''}</div>
          <ul class="small muted" style="margin:8px 0 0 16px;padding:0">${(issue.contractorReasoning || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          ${isSupervisor() && issue.contractor.contractorId ? `<button class="btn sm danger" style="margin-top:9px" id="notice-btn">Issue defect notice</button>` : ''}
        </div>` : `<div class="card" style="margin-top:12px;padding:13px"><div class="tiny">Contractor lookup</div>
          <div class="small muted">${issue.contractorLookup === 'pending' ? 'Querying OpenStreetMap and the contracts registry…' : 'No contractor works matched this location in open data.'}</div></div>`}
      </div>
    </div>

    <div class="card" style="margin-top:16px;padding:15px">
      <div class="row wrap" style="gap:8px">
        ${issue.status === 'ROUTED' ? '<button class="btn" id="ack-btn">Acknowledge</button>' : ''}
        ${['ACKNOWLEDGED', 'ASSIGNED', 'ESCALATED', 'ROUTED'].includes(issue.status) ? '<button class="btn" id="start-btn">Start work</button>' : ''}
        ${isSupervisor() ? `<select id="assign-select" style="width:auto">
          <option value="">Assign to…</option>
          ${state.workers.map((w) => `<option value="${w.id}" ${issue.assignedTo === w.id ? 'selected' : ''}>${esc(w.name)} (${w.openTasks} open)</option>`).join('')}
        </select><button class="btn" id="assign-btn">Assign</button>` : ''}
        ${isSupervisor() ? '<button class="btn ghost" id="reclass-btn">Re-classify</button>' : ''}
      </div>

      ${['ASSIGNED', 'IN_PROGRESS', 'ACKNOWLEDGED', 'ESCALATED'].includes(issue.status) ? `
        <div class="grid cols-2" style="margin-top:15px">
          <div>
            <div class="tiny">Step 1 · "Before" photos (min 2 angles)</div>
            <input type="file" id="before-input" accept="image/jpeg,image/png" multiple style="margin-top:6px">
            <button class="btn sm block" style="margin-top:8px" id="before-btn">Upload before evidence</button>
            <div class="small faint" style="margin-top:6px">${issue.evidence.before.length} already uploaded</div>
          </div>
          <div>
            <div class="tiny">Step 2 · "After" photos (min 2 angles) → closes the job</div>
            <input type="file" id="after-input" accept="image/jpeg,image/png" multiple style="margin-top:6px">
            <input id="resolve-notes" placeholder="Work done (e.g. patched with hot mix, 3 sqm)" style="margin-top:8px">
            <button class="btn primary sm block" style="margin-top:8px" id="resolve-btn">Submit &amp; run AI verification</button>
          </div>
        </div>
        <div class="small faint" style="margin-top:8px">
          CivicVision compares your "after" photos against the original evidence. Re-uploading the same photo is detected and rejected.
        </div>` : ''}
      <div id="verify-out"></div>
    </div>

    ${issue.evidence.after.length ? `
      <div class="tiny" style="margin-top:16px">Before / after evidence</div>
      <div class="ba-grid" style="margin-top:8px">
        <div class="side"><div class="badge">Before</div>${(issue.evidence.before.length ? issue.evidence.before : issue.evidence.report).slice(0, 2).map((e) => `<img src="${e.url}">`).join('')}</div>
        <div class="side"><div class="badge ok">After</div>${issue.evidence.after.slice(0, 2).map((e) => `<img src="${e.url}">`).join('')}</div>
      </div>` : ''}

    <div class="tiny" style="margin-top:16px">Audit trail</div>
    <div class="timeline" style="margin-top:10px">
      ${audit.map((a) => `<div class="ev ${a.actorRole === 'system' ? 'sys' : ''}">
        <div><b class="small">${esc(String(a.action).replace(/_/g, ' '))}</b> <span class="small muted">· ${esc(a.actorName)}</span></div>
        <div class="when">${fmtDate(a.createdAt)}</div></div>`).join('')}
    </div>
  </div></div>`;

  const close = () => { root.innerHTML = ''; };
  document.getElementById('close-modal').onclick = close;
  document.getElementById('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') close(); };

  const act = async (path, body) => {
    try {
      const out = await api(`/issues/${issue.id}/${path}`, { method: 'POST', body });
      toast('Updated', `${issue.code} → ${out.issue.status.replace('_', ' ')}`, 'ok');
      close(); await loadAll();
      return out;
    } catch (e) { toast('Failed', e.message, 'error'); }
  };

  document.getElementById('ack-btn')?.addEventListener('click', () => act('acknowledge'));
  document.getElementById('start-btn')?.addEventListener('click', () => act('start'));
  document.getElementById('assign-btn')?.addEventListener('click', () => {
    const w = document.getElementById('assign-select').value;
    if (!w) return toast('Pick an officer', 'Choose who should handle this.', 'warn');
    act('assign', { workerId: w });
  });
  document.getElementById('reclass-btn')?.addEventListener('click', async () => {
    const { categories } = await api('/analytics/taxonomy');
    const choice = prompt(`Re-classify ${issue.code} as:\n${categories.map((c) => `${c.key} - ${c.label}`).join('\n')}`, issue.category);
    if (!choice) return;
    act('reclassify', { category: choice.trim().toUpperCase(), reason: 'Supervisor override' });
  });

  const uploadPhotos = async (inputId, path, extra = {}) => {
    const input = document.getElementById(inputId);
    if (!input.files.length) return toast('No photos', 'Select at least 2 photos from different angles.', 'warn');
    const fd = new FormData();
    [...input.files].slice(0, 4).forEach((f) => fd.append('photos', f));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    try {
      const out = await api(`/issues/${issue.id}/${path}`, { method: 'POST', body: fd });
      if (out.verification) renderVerification(out.verification);
      toast('Uploaded', path === 'resolve' ? 'AI verification complete.' : 'Before evidence stored.', 'ok');
      await loadAll();
      if (path === 'resolve') setTimeout(() => openIssue(issue.id), 800);
    } catch (e) { toast('Rejected', e.message, 'error'); }
  };

  document.getElementById('before-btn')?.addEventListener('click', () => uploadPhotos('before-input', 'before'));
  document.getElementById('resolve-btn')?.addEventListener('click', () =>
    uploadPhotos('after-input', 'resolve', { notes: document.getElementById('resolve-notes').value }));

  document.getElementById('notice-btn')?.addEventListener('click', async () => {
    const reason = prompt('Defect notice reason:', `Defect at ${issue.code} during liability period`);
    if (!reason) return;
    try {
      await api(`/contractors/${issue.contractor.contractorId}/notice`, { method: 'POST', body: { reason, issueId: issue.id } });
      toast('Notice issued', `Recorded against ${issue.contractor.name}.`, 'ok');
    } catch (e) { toast('Failed', e.message, 'error'); }
  });
}

function renderVerification(v) {
  document.getElementById('verify-out').innerHTML = `
    <div class="card" style="margin-top:13px;padding:13px;border-color:${v.verified ? 'var(--ok)' : 'var(--warn)'}">
      <div class="row space-between"><b class="small">CivicVision closure verification</b>
        <span class="badge ${v.verified ? 'ok' : 'warn'}">${v.verified ? 'Verified' : 'Not confirmed'} · ${v.improvementScore}</span></div>
      ${v.metrics.map((m) => `<div class="meter-row"><span>${esc(m.label)}</span>
        <span class="mono faint">${m.before}</span><span class="mono">${m.after}</span>
        <span class="badge ${m.improved ? 'ok' : ''}">${m.improved ? 'better' : 'flat'}</span></div>`).join('')}
      <div class="small muted" style="margin-top:8px">${v.notes.map(esc).join(' ')}</div>
      <div class="small faint">Angle check: ${esc(v.angleDiversity.note)}</div>
    </div>`;
}

/* Bootstrap last: init() reads module-level constants declared above. */
if (user) init();
