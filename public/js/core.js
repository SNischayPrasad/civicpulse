/* CivicPulse shared front-end runtime: auth, API, realtime socket, UI helpers. */

export const store = {
  get token() { return localStorage.getItem('cp_token'); },
  set token(v) { v ? localStorage.setItem('cp_token', v) : localStorage.removeItem('cp_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('cp_user') || 'null'); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('cp_user', JSON.stringify(v)) : localStorage.removeItem('cp_user'); },
  clear() { localStorage.removeItem('cp_token'); localStorage.removeItem('cp_user'); }
};

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });

  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    store.clear();
    location.href = '/index.html';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function guard(roles) {
  const u = store.user;
  if (!store.token || !u) { location.href = '/index.html'; return null; }
  if (roles && !roles.includes(u.role)) { location.href = homeFor(u.role); return null; }
  return u;
}

export function homeFor(role) {
  if (role === 'admin') return '/admin.html';
  if (role === 'worker' || role === 'supervisor') return '/staff.html';
  return '/citizen.html';
}

export function logout() {
  store.clear();
  location.href = '/index.html';
}

/* -------------------------------------------------------------- realtime */

let socket = null;
export function connectSocket(handlers = {}) {
  if (!window.io || !store.token) return null;
  socket = window.io({ auth: { token: store.token } });
  socket.on('connect', () => setLive(true));
  socket.on('disconnect', () => setLive(false));
  socket.on('connect_error', () => setLive(false));
  for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);
  return socket;
}
export const getSocket = () => socket;

function setLive(on) {
  document.querySelectorAll('.live-dot').forEach((d) => d.classList.toggle('off', !on));
  document.querySelectorAll('[data-live-text]').forEach((el) => { el.textContent = on ? 'Live' : 'Offline'; });
}

/* ---------------------------------------------------------------- toasts */

export function toast(title, message = '', kind = '') {
  let wrap = document.getElementById('toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toasts'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t"></div><div class="m"></div>`;
  el.querySelector('.t').textContent = title;
  el.querySelector('.m').textContent = message;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 6200);
}

/* ------------------------------------------------------------- formatting */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function timeAgo(iso) {
  if (!iso) return '-';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dueIn(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  const h = ms / 36e5;
  if (ms < 0) return `overdue ${Math.abs(h) < 24 ? `${Math.abs(h).toFixed(0)}h` : `${(Math.abs(h) / 24).toFixed(0)}d`}`;
  return h < 24 ? `${h.toFixed(0)}h left` : `${(h / 24).toFixed(0)}d left`;
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const money = (n) => (n ? `₹${(n / 1e5).toFixed(1)} L` : '-');

export const STATUS_STYLE = {
  REPORTED: 'info', ROUTED: 'info', ACKNOWLEDGED: 'info', ASSIGNED: 'accent',
  IN_PROGRESS: 'accent', RESOLVED: 'ok', CLOSED: 'ok', ESCALATED: 'danger', REJECTED: 'danger'
};

export const sevChip = (sev, label) =>
  `<span class="sev sev-${sev}"><i></i>${esc(label || `S${sev}`)}</span>`;

export const statusChip = (s) =>
  `<span class="badge ${STATUS_STYLE[s] || ''} status">${esc(String(s).replace('_', ' '))}</span>`;

export const ICONS = {
  pothole: '◍', garbage: '⛝', sewage: '≋', water: '◈', light: '☀', tree: '⌘',
  manhole: '◎', debris: '▦', signal: '⊟', mosquito: '✳', graffiti: '✎', footpath: '▤', unknown: '?'
};

/* ------------------------------------------------------------ app shell */

export function renderShell({ active, nav, title, subtitle }) {
  const u = store.user;
  document.getElementById('side-brand')?.remove();
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.innerHTML = `
      <a class="brand" href="${homeFor(u.role)}" style="text-decoration:none;color:inherit">
        <div class="brand-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="#04231f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 12h4l3-8 4 16 3-8h6"/>
          </svg>
        </div>
        <div>
          <div class="brand-name">CivicPulse</div>
          <div class="brand-sub">Infinity Force</div>
        </div>
      </a>
      <nav class="nav">
        <div class="nav-label">Workspace</div>
        ${nav.map((n) => `<a href="${n.href}" data-nav="${n.key}" class="${n.key === active ? 'active' : ''}">
          <span style="width:16px;text-align:center">${n.icon}</span>${esc(n.label)}
          ${n.badge ? `<span class="badge ${n.badgeKind || ''}" data-badge="${n.key}">${n.badge}</span>` : ''}
        </a>`).join('')}
      </nav>
      <div class="side-foot" style="margin-top:auto">
        <div class="card" style="padding:12px">
          <div class="row" style="gap:8px"><span class="live-dot"></span><span class="small muted" data-live-text>Connecting</span></div>
          <div style="margin-top:10px" class="small">
            <div style="font-weight:650">${esc(u.name)}</div>
            <div class="faint tiny" style="margin-top:2px">${esc(u.role)}${u.employeeId ? ` · ${esc(u.employeeId)}` : ''}</div>
          </div>
          <button class="btn ghost sm block" style="margin-top:10px" id="logout-btn">Sign out</button>
        </div>
      </div>`;
    sidebar.querySelector('#logout-btn').onclick = logout;
  }
  const tb = document.querySelector('.topbar');
  if (tb && title) {
    tb.querySelector('[data-title]') && (tb.querySelector('[data-title]').textContent = title);
    tb.querySelector('[data-subtitle]') && (tb.querySelector('[data-subtitle]').textContent = subtitle || '');
  }
}

/* --------------------------------------------------------------- geo/maps */

export function getPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation is not supported by this browser.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.message || 'Location permission denied.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000, ...options }
    );
  });
}

export function makeMap(el, center = { lat: 12.9352, lng: 77.6245 }, zoom = 13) {
  if (!window.L) return null;
  const map = window.L.map(el, { zoomControl: true, attributionControl: false }).setView([center.lat, center.lng], zoom);
  // Standard OpenStreetMap tiles (no API key). The dark look comes from a CSS
  // filter on the tile pane, so the map still works fully offline of any vendor.
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, crossOrigin: true
  }).addTo(map);
  return map;
}

export function severityColor(sev) {
  return ['#64748b', '#64748b', '#38bdf8', '#f59e0b', '#fb7185', '#ef4444'][sev] || '#64748b';
}

export function issueMarker(map, issue, onClick) {
  if (!window.L || !issue.location) return null;
  const color = severityColor(issue.severity);
  const marker = window.L.circleMarker([issue.location.lat, issue.location.lng], {
    radius: 7 + Math.min(6, (issue.reportCount || 1)), color, weight: 2,
    fillColor: color, fillOpacity: issue.status === 'CLOSED' ? 0.15 : 0.55
  }).addTo(map);
  marker.bindPopup(`
    <b>${esc(issue.code)}</b> · ${esc(issue.categoryLabel)}<br>
    <span style="color:#8aa0b6">${esc(issue.wardName || issue.address || '')}</span><br>
    <span style="color:${color}">Severity ${issue.severity}</span> · ${esc(issue.status)} · ${issue.reportCount || 1} report(s)
  `);
  if (onClick) marker.on('click', () => onClick(issue));
  return marker;
}
