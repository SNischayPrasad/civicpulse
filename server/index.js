import express from 'express';
import http from 'node:http';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';
import config from './config.js';
import db from './db.js';
import { ensureSeed } from './seed.js';
import { verifyToken } from './middleware/auth.js';
import notify from './services/notify.js';
import { aiStatus } from './services/ai/index.js';

import authRoutes from './routes/auth.js';
import issueRoutes from './routes/issues.js';
import departmentRoutes from './routes/departments.js';
import contractorRoutes from './routes/contractors.js';
import analyticsRoutes from './routes/analytics.js';

ensureSeed();

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });
notify.attachIo(io);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(config.paths.uploads, { maxAge: '1h' }));
app.use(express.static(config.paths.public));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'CivicPulse',
    version: '1.0.0',
    ai: aiStatus(),
    realtime: io.engine.clientsCount,
    counts: {
      issues: db.issues.count(),
      users: db.users.count(),
      departments: db.departments.count(),
      contractors: db.contractors.count()
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/issues', issueRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/contractors', contractorRoutes);
app.use('/api/analytics', analyticsRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const msg = err?.code === 'LIMIT_FILE_SIZE'
    ? 'Photo too large. Keep each photo under 12 MB.'
    : err?.code === 'LIMIT_FILE_COUNT'
      ? `Maximum ${config.policy.maxPhotos} photos per issue.`
      : err?.message || 'Something went wrong.';
  res.status(400).json({ error: msg });
});

/* ------------------------------------------------------------- realtime */

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const payload = token ? verifyToken(String(token)) : null;
  if (!payload) return next(new Error('unauthorised'));
  const user = db.users.byId(payload.sub);
  if (!user) return next(new Error('unauthorised'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const u = socket.data.user;
  socket.join(notify.rooms.user(u.id));
  if (u.departmentId) socket.join(notify.rooms.dept(u.departmentId));
  if (['admin', 'supervisor'].includes(u.role)) socket.join(notify.rooms.city);

  socket.emit('ready', {
    user: { id: u.id, name: u.name, role: u.role, departmentId: u.departmentId || null },
    rooms: [...socket.rooms]
  });

  socket.on('issue:watch', (issueId) => { if (issueId) socket.join(notify.rooms.issue(String(issueId))); });
  socket.on('issue:unwatch', (issueId) => { if (issueId) socket.leave(notify.rooms.issue(String(issueId))); });
});

/* --------------------------------------------------- SLA escalation loop */

const OPEN = ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS'];

function slaSweep() {
  const now = Date.now();
  for (const issue of db.issues.all()) {
    if (!OPEN.includes(issue.status) || issue.escalated || !issue.dueAt) continue;
    if (new Date(issue.dueAt).getTime() > now) continue;

    const updated = db.issues.update(issue.id, { status: 'ESCALATED', escalated: true, escalatedAt: new Date().toISOString() });
    notify.audit(issue.id, null, 'SLA_BREACHED', { slaHours: issue.slaHours, dueAt: issue.dueAt });
    notify.raiseAlert({
      issueId: issue.id,
      departmentId: issue.departmentId,
      level: 'critical',
      title: `SLA breached on ${issue.code}`,
      message: `${issue.categoryLabel} at ${issue.wardName || issue.address} has crossed its ${issue.slaHours}h SLA without resolution. Escalated to supervisor.`,
      meta: { slaHours: issue.slaHours }
    });
    notify.notifyUser(issue.reporterId, {
      issueId: issue.id, level: 'warning',
      title: `${issue.code} escalated`,
      message: 'Your report has crossed its service deadline and has been escalated to the supervising officer.'
    });
    notify.broadcast('issue:updated', updated);
  }
}
setInterval(slaSweep, config.policy.slaTickMs).unref?.();
slaSweep();

server.listen(config.port, () => {
  const s = aiStatus();
  console.log('');
  console.log('  CivicPulse  |  AI-Powered Civic Issue Intelligence & Resolution');
  console.log('  ------------------------------------------------------------');
  console.log(`  Web app     : http://localhost:${config.port}`);
  console.log(`  API health  : http://localhost:${config.port}/api/health`);
  console.log(`  AI engine   : on-board CivicVision (${s.onboard.categories} categories)`);
  console.log(`  Hosted model: ${s.remote.configured ? `${s.remote.provider} (${s.remote.model || 'default model'})` : 'not configured - using on-board engine'}`);
  console.log(`  Realtime    : Socket.IO ready`);
  console.log('');
  console.log('  Demo logins : citizen@demo.in / Citizen@123');
  console.log('                worker.roads@city.gov.in / Worker@123');
  console.log('                supervisor.roads@city.gov.in / Super@123');
  console.log('                admin@city.gov.in / Admin@123');
  console.log('');
});

export default app;
