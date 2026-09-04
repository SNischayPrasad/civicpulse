import {
  api, guard, renderShell, connectSocket, toast, esc, timeAgo, dueIn, fmtDate,
  sevChip, statusChip, ICONS, makeMap, issueMarker, money, severityColor
} from '/js/core.js';

const user = guard(['admin']);

const state = { overview: null, issues: [], departments: [], contractors: [], map: null, layer: [] };

const NAV = [
  { key: 'overview', label: 'Overview', icon: '◱', href: '#overview' },
  { key: 'hotspots', label: 'Hotspots & map', icon: '◉', href: '#hotspots' },
  { key: 'review', label: 'Review queue', icon: '⚠', href: '#review' },
  { key: 'contractors', label: 'Contractors', icon: '⚖', href: '#contractors' },
  { key: 'staff', label: 'Departments & staff', icon: '☰', href: '#staff' }
];
const TITLES = {
  overview: ['City control room', 'One pipeline: citizen evidence → AI → authority action'],
  hotspots: ['Hotspots', 'Where the same problem keeps coming back'],
  review: ['Human-in-the-loop review', 'Low-confidence classifications awaiting a human decision'],
  contractors: ['Contractor accountability', 'Who built it, and are they still liable'],
  staff: ['Departments & staff', 'Capacity, performance and account provisioning']
};

async function init() {
  show(location.hash.replace('#', '') || 'overview');
  window.addEventListener('hashchange', () => show(location.hash.replace('#', '') || 'overview'));
  document.getElementById('refresh-btn').onclick = loadAll;
  document.getElementById('search').oninput = renderIssues;
  document.getElementById('staff-form').onsubmit = createStaff;

  await loadAll();
  connectSocket({
    'issue:new': () => loadAll(),
    'issue:updated': (i) => { const k = state.issues.findIndex((x) => x.id === i.id); if (k >= 0) state.issues[k] = i; renderIssues(); },
    'alert:new': (a) => toast(a.title, a.message, a.level === 'critical' ? 'error' : a.level === 'warning' ? 'warn' : 'ok')
  });
}

function show(view) {
  if (!TITLES[view]) view = 'overview';
  document.querySelectorAll('[data-view]').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== view));
  renderShell({ active: view, nav: NAV, title: TITLES[view][0], subtitle: TITLES[view][1] });
  if (view === 'hotspots') setTimeout(renderMap, 80);
}

async function loadAll() {
  const [ov, issues, depts, cons] = await Promise.all([
    api('/analytics/overview'), api('/issues?limit=400'), api('/departments'), api('/contractors')
  ]);
  state.overview = ov;
  state.issues = issues.issues;
  state.departments = depts.departments;
  state.contractors = cons.contractors;
  renderOverview(); renderIssues(); renderHotspots(); renderContractors(); renderDeptPerf(); renderMap();
}

function renderOverview() {
  const o = state.overview;
  document.getElementById('k-issues').textContent = o.totals.issues;
  document.getElementById('k-citizens').textContent = `${o.totals.citizens} citizens · ${o.totals.corroborations} corroborations`;
  document.getElementById('k-open').textContent = o.totals.open;
  document.getElementById('k-overdue').textContent = `${o.totals.overdue} past SLA`;
  document.getElementById('k-sla').textContent = o.sla.compliance === null ? '—' : `${o.sla.compliance}%`;
  document.getElementById('k-avg').textContent = o.sla.avgResolutionHours ? `avg ${o.sla.avgResolutionHours}h to resolve` : 'no closures yet';
  document.getElementById('k-conf').textContent = o.ai.avgConfidence ? `${Math.round(o.ai.avgConfidence * 100)}%` : '—';
  document.getElementById('k-engine').textContent = o.ai.remote.configured ? `${o.ai.remote.provider} + CivicVision` : 'CivicVision on-board';

  const max = Math.max(1, ...o.trend.map((t) => Math.max(t.reported, t.closed)));
  document.getElementById('trend').innerHTML = o.trend.map((t) =>
    `<i style="height:${(t.reported / max) * 100}%" title="${t.date}: ${t.reported} reported, ${t.closed} closed"></i>`).join('');
  document.getElementById('trend-start').textContent = o.trend[0]?.date || '';
  document.getElementById('trend-end').textContent = o.trend.at(-1)?.date || '';
  document.getElementById('trend-total').textContent = `${o.trend.reduce((a, t) => a + t.reported, 0)} reported · ${o.trend.reduce((a, t) => a + t.closed, 0)} closed`;

  const catMax = Math.max(1, ...o.byCategory.map((c) => c.count));
  document.getElementById('cat-bars').innerHTML = o.byCategory.length ? o.byCategory.map((c) => `
    <div style="margin-bottom:10px">
      <div class="row space-between small"><span>${esc(c.label)}</span><b class="mono">${c.count}</b></div>
      <div class="bar-track"><i style="width:${(c.count / catMax) * 100}%"></i></div>
    </div>`).join('') : '<div class="small faint">No issues reported yet.</div>';

  document.getElementById('ai-status').innerHTML = `
    <div class="row space-between" style="margin-top:6px"><span class="small muted">On-board engine</span><b class="small">CivicVision v1 · ${o.ai.onboard.categories} categories</b></div>
    <div class="row space-between"><span class="small muted">Hosted model</span><b class="small">${o.ai.remote.configured ? esc(`${o.ai.remote.provider} / ${o.ai.remote.model || 'default'}`) : 'not configured'}</b></div>
    <div class="row space-between"><span class="small muted">Confidence threshold</span><b class="small mono">${o.ai.confidenceThreshold}</b></div>
    <div class="row space-between"><span class="small muted">Auto-routed</span><b class="small">${o.ai.autoRouted}</b></div>
    <div class="row space-between"><span class="small muted">Human overrides</span><b class="small">${o.ai.overridden}</b></div>
    <div class="row space-between"><span class="small muted">Review queue</span><b class="small">${o.ai.humanReviewQueue}</b></div>
    <div class="row space-between"><span class="small muted">Fake closures blocked</span><b class="small" style="color:var(--danger)">${o.ai.fakeClosuresBlocked}</b></div>
    <div class="row space-between"><span class="small muted">Contractor liabilities</span><b class="small">${o.totals.contractorLiabilities}</b></div>
    ${o.ai.remote.lastError ? `<div class="small" style="margin-top:8px;color:var(--warn)">Last hosted-model error: ${esc(o.ai.remote.lastError)}</div>` : ''}`;

  document.getElementById('dept-table').innerHTML = `<table><thead><tr><th>Department</th><th>Issues</th><th>Open</th><th>Overdue</th><th>SLA</th></tr></thead><tbody>
    ${state.departments.map((d) => `<tr>
      <td><span style="color:${d.color}">■</span> ${esc(d.name)}</td>
      <td>${d.stats.total}</td><td>${d.stats.open}</td>
      <td style="${d.stats.overdue ? 'color:var(--danger)' : ''}">${d.stats.overdue}</td>
      <td>${d.stats.slaCompliance === null ? '—' : `${d.stats.slaCompliance}%`}</td></tr>`).join('')}</tbody></table>`;
}

function issueRow(i) {
  const shot = i.evidence?.report?.[0]?.url;
  return `<div class="issue-card" data-id="${i.id}">
    ${shot ? `<img class="shot" src="${shot}">` : `<div class="shot" style="display:grid;place-items:center;font-size:22px">${ICONS[i.icon] || '◍'}</div>`}
    <div><div class="title">${esc(i.categoryLabel)}</div>
      <div class="meta"><span class="mono">${esc(i.code)}</span>${sevChip(i.severity, i.severityLabel)}
      <span>${esc(i.department?.name || '')}</span><span>${esc(i.wardName || '')}</span><span>${timeAgo(i.createdAt)}</span>
      ${i.reportCount > 1 ? `<span class="badge accent">${i.reportCount} citizens</span>` : ''}
      <span class="badge">AI ${Math.round((i.ai?.confidence || 0) * 100)}%</span></div></div>
    <div class="right col" style="gap:5px;align-items:flex-end">${statusChip(i.status)}
      <span class="small" style="color:${i.overdue ? 'var(--danger)' : 'var(--faint)'}">${dueIn(i.dueAt)}</span></div>
  </div>`;
}

function renderIssues() {
  const review = state.issues.filter((i) => i.humanReview && i.status !== 'CLOSED');
  document.getElementById('review-count').textContent = review.length;
  const rl = document.getElementById('review-list');
  rl.innerHTML = review.length ? review.map(issueRow).join('') : '<div class="empty"><div class="big">✓</div>No low-confidence classifications pending.</div>';

  const q = (document.getElementById('search')?.value || '').toLowerCase();
  const rows = state.issues.filter((i) => !q || `${i.code} ${i.categoryLabel} ${i.wardName} ${i.address}`.toLowerCase().includes(q)).slice(0, 60);
  const al = document.getElementById('all-list');
  al.innerHTML = rows.length ? rows.map(issueRow).join('') : '<div class="empty">No issues match.</div>';

  [rl, al].forEach((el) => el.querySelectorAll('.issue-card').forEach((c) => { c.onclick = () => openIssue(c.dataset.id); }));
}

function renderHotspots() {
  const h = state.overview.hotspots;
  document.getElementById('hot-count').textContent = h.length;
  document.getElementById('hotspot-list').innerHTML = h.length ? h.map((s) => `
    <div class="alert-item warning">
      <div class="row space-between"><b class="small">${esc(s.dominant || 'Mixed')} cluster</b><span class="badge warn">${s.count} reports</span></div>
      <div class="small muted mono">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)} · cell ${esc(s.cell)}</div>
    </div>`).join('') : '<div class="small faint">No recurring hotspots yet.</div>';
}

function renderMap() {
  const el = document.getElementById('admin-map');
  if (!el || el.offsetParent === null) return;
  if (!state.map) state.map = makeMap(el, { lat: 12.9352, lng: 77.6245 }, 12);
  if (!state.map) return;
  state.map.invalidateSize();
  state.layer.forEach((m) => state.map.removeLayer(m));
  state.layer = state.issues.map((i) => issueMarker(state.map, i, (x) => openIssue(x.id))).filter(Boolean);

  for (const s of state.overview.hotspots) {
    state.layer.push(window.L.circle([s.lat, s.lng], {
      radius: 220, color: '#fbbf24', weight: 1, fillColor: '#fbbf24', fillOpacity: 0.12
    }).addTo(state.map).bindPopup(`<b>Hotspot</b><br>${s.count} reports · ${esc(s.dominant || '')}`));
  }
}

function renderContractors() {
  document.getElementById('contractor-table').innerHTML = `<table><thead><tr>
    <th>Contractor</th><th>Agency / licence</th><th>Ward &amp; scope</th><th>Value</th><th>DLP</th><th>Liability</th><th>Rating</th><th>Notices</th>
  </tr></thead><tbody>${state.contractors.map((c) => `<tr>
    <td><b>${esc(c.name)}</b>${c.blacklisted ? '<div class="badge danger" style="margin-top:3px">blacklisted</div>' : ''}</td>
    <td class="small">${esc(c.agency)}<div class="faint mono">${esc(c.licenceNo)}</div></td>
    <td class="small">${esc(c.ward)}<div class="faint">${esc(c.workType)}</div></td>
    <td class="mono small">${money(c.contractValue)}</td>
    <td class="small">${esc(c.defectLiabilityUntil)}${new Date(c.defectLiabilityUntil) > new Date() ? ' <span class="badge danger">active</span>' : ''}</td>
    <td>${c.accountability.openLiability} <span class="faint small">/ ${c.accountability.linkedIssues}</span></td>
    <td class="mono">${c.rating}</td>
    <td class="small">${(c.notices || []).length}</td>
  </tr>`).join('')}</tbody></table>
  <p class="small faint" style="margin-top:10px">Records shaped after public works disclosures (work order, licence, defect liability period) and enriched live from OpenStreetMap construction tags.</p>`;
}

function renderDeptPerf() {
  document.getElementById('dept-perf').innerHTML = state.departments.map((d) => `
    <div style="margin-bottom:13px">
      <div class="row space-between small"><span><span style="color:${d.color}">■</span> <b>${esc(d.name)}</b></span>
        <span class="mono">${d.stats.slaCompliance === null ? '—' : `${d.stats.slaCompliance}%`} SLA</span></div>
      <div class="bar-track"><i style="width:${d.stats.slaCompliance || 0}%;background:${d.color}"></i></div>
      <div class="small faint">${d.stats.total} issues · ${d.stats.open} open · ${d.stats.overdue} overdue · avg ${d.stats.avgResolutionHours ?? '—'}h</div>
    </div>`).join('');

  document.getElementById('dept-select').innerHTML = state.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
}

async function createStaff(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/auth/staff', { method: 'POST', body: Object.fromEntries(f.entries()) });
    toast('Account created', `${f.get('name')} can now sign in.`, 'ok');
    e.target.reset();
    loadAll();
  } catch (err) { toast('Failed', err.message, 'error'); }
}

async function openIssue(id) {
  const { issue, audit } = await api(`/issues/${id}`);
  const { categories } = await api('/analytics/taxonomy');
  const root = document.getElementById('modal-root');

  root.innerHTML = `<div class="modal-backdrop" id="backdrop"><div class="modal">
    <div class="card-head">
      <div><div class="row wrap"><span class="badge mono">${esc(issue.code)}</span>${statusChip(issue.status)}${sevChip(issue.severity, issue.severityLabel)}
        ${issue.humanReview ? '<span class="badge warn">low confidence</span>' : ''}</div>
        <h2 style="margin-top:8px">${ICONS[issue.icon] || '◍'} ${esc(issue.categoryLabel)}</h2>
        <div class="muted small">${esc(issue.address || '')} · ${esc(issue.department?.name || '')}</div></div>
      <button class="btn sm" id="close-modal">Close</button>
    </div>

    <div class="grid cols-2">
      <div><div class="tiny">Evidence</div>
        <div class="thumbs" style="grid-template-columns:repeat(2,1fr)">
          ${issue.evidence.report.map((e, i) => `<div class="thumb"><img src="${e.url}"><span class="angle">${i + 1}</span>${e.exif?.gps ? '<span class="gps">GPS</span>' : ''}</div>`).join('')}
        </div>
        ${issue.description ? `<p class="small" style="margin-top:8px">"${esc(issue.description)}"</p>` : ''}
      </div>
      <div><div class="ai-panel">
        <div class="tiny">AI verdict · ${esc(issue.ai?.engine || '')}</div>
        <div class="row" style="margin-top:5px"><b>${esc(issue.categoryLabel)}</b><span class="grow"></span><b class="mono">${Math.round((issue.ai?.confidence || 0) * 100)}%</b></div>
        <div class="confidence"><i style="width:${Math.round((issue.ai?.confidence || 0) * 100)}%"></i></div>
        <p class="small" style="margin-top:8px">${esc(issue.ai?.summary || '')}</p>
        <div>${(issue.ai?.evidence || []).map((e) => `<span class="evidence-chip">${esc(e.label)} <b>${e.value}</b></span>`).join('')}</div>
      </div>
      <div class="card" style="margin-top:12px;padding:13px">
        <div class="tiny">Human-in-the-loop override</div>
        <select id="reclass-cat" style="margin-top:7px">${categories.map((c) => `<option value="${c.key}" ${c.key === issue.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
        <select id="reclass-sev" style="margin-top:7px">${[1, 2, 3, 4, 5].map((s) => `<option value="${s}" ${s === issue.severity ? 'selected' : ''}>Severity ${s}</option>`).join('')}</select>
        <button class="btn primary sm block" style="margin-top:9px" id="reclass-btn">Confirm classification</button>
      </div></div>
    </div>

    ${issue.contractor ? `<div class="card" style="margin-top:14px;padding:13px">
      <div class="tiny">Contractor accountability</div>
      <div class="row"><b>${esc(issue.contractor.name)}</b><span class="grow"></span>
      ${issue.contractor.liable ? '<span class="badge danger">liable · DLP active</span>' : '<span class="badge">informational</span>'}</div>
      <ul class="small muted" style="margin:7px 0 0 16px;padding:0">${(issue.contractorReasoning || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>` : ''}

    <div class="tiny" style="margin-top:16px">Audit trail</div>
    <div class="timeline" style="margin-top:10px">${audit.map((a) => `<div class="ev ${a.actorRole === 'system' ? 'sys' : ''}">
      <div><b class="small">${esc(String(a.action).replace(/_/g, ' '))}</b> <span class="small muted">· ${esc(a.actorName)}</span></div>
      <div class="when">${fmtDate(a.createdAt)}</div></div>`).join('')}</div>
  </div></div>`;

  const close = () => { root.innerHTML = ''; };
  document.getElementById('close-modal').onclick = close;
  document.getElementById('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') close(); };
  document.getElementById('reclass-btn').onclick = async () => {
    try {
      await api(`/issues/${issue.id}/reclassify`, {
        method: 'POST',
        body: {
          category: document.getElementById('reclass-cat').value,
          severity: Number(document.getElementById('reclass-sev').value),
          reason: 'Control room review'
        }
      });
      toast('Classification confirmed', 'Routing and SLA updated.', 'ok');
      close(); loadAll();
    } catch (e) { toast('Failed', e.message, 'error'); }
  };
}

/* Bootstrap last: init() reads module-level constants declared above. */
if (user) init();
