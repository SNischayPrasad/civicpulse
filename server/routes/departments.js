import express from 'express';
import db from '../db.js';
import { requireAuth, requireStaff, publicUser, ROLES } from '../middleware/auth.js';

const router = express.Router();
const OPEN = ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'];

function stats(deptId) {
  const rows = db.issues.find({ departmentId: deptId });
  const closed = rows.filter((i) => ['CLOSED', 'RESOLVED'].includes(i.status));
  const onTime = closed.filter((i) => i.resolution?.withinSla).length;
  const durations = closed
    .filter((i) => i.resolvedAt)
    .map((i) => (new Date(i.resolvedAt) - new Date(i.createdAt)) / 36e5);
  return {
    total: rows.length,
    open: rows.filter((i) => OPEN.includes(i.status)).length,
    overdue: rows.filter((i) => OPEN.includes(i.status) && i.dueAt && new Date(i.dueAt) < new Date()).length,
    resolved: rows.filter((i) => i.status === 'RESOLVED').length,
    closed: rows.filter((i) => i.status === 'CLOSED').length,
    slaCompliance: closed.length ? Math.round((onTime / closed.length) * 100) : null,
    avgResolutionHours: durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1) : null
  };
}

router.get('/', requireAuth, (_req, res) => {
  res.json({
    departments: db.departments.all().map((d) => ({ ...d, stats: stats(d.id) }))
  });
});

router.get('/:id/workers', requireAuth, requireStaff, (req, res) => {
  const workers = db.users
    .find({ departmentId: req.params.id })
    .filter((u) => [ROLES.WORKER, ROLES.SUPERVISOR].includes(u.role))
    .map((u) => {
      const load = db.issues.find({ assignedTo: u.id });
      return {
        ...publicUser(u),
        openTasks: load.filter((i) => OPEN.includes(i.status)).length,
        completed: load.filter((i) => ['RESOLVED', 'CLOSED'].includes(i.status)).length
      };
    });
  res.json({ workers });
});

router.get('/:id/alerts', requireAuth, requireStaff, (req, res) => {
  const alerts = db.alerts
    .find({ departmentId: req.params.id })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 60);
  res.json({ alerts });
});

router.post('/alerts/:alertId/read', requireAuth, requireStaff, (req, res) => {
  const a = db.alerts.update(req.params.alertId, { read: true });
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  res.json({ alert: a });
});

export default router;
