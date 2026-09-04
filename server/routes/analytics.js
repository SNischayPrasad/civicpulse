import express from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { hotspots } from '../services/geo.js';
import { aiStatus } from '../services/ai/index.js';
import { CATEGORIES, SEVERITY_LABELS } from '../services/ai/taxonomy.js';

const router = express.Router();
const OPEN = ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'];

router.get('/overview', requireAuth, (_req, res) => {
  const issues = db.issues.all();
  const closed = issues.filter((i) => i.status === 'CLOSED');
  const resolvedish = issues.filter((i) => ['RESOLVED', 'CLOSED'].includes(i.status));
  const durations = resolvedish.filter((i) => i.resolvedAt)
    .map((i) => (new Date(i.resolvedAt) - new Date(i.createdAt)) / 36e5);
  const onTime = resolvedish.filter((i) => i.resolution?.withinSla).length;

  const byStatus = {};
  const byCategory = {};
  const byDepartment = {};
  const bySeverity = {};
  for (const i of issues) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    byDepartment[i.departmentId] = (byDepartment[i.departmentId] || 0) + 1;
    bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
  }

  const aiConfidences = issues.map((i) => i.ai?.confidence).filter((n) => typeof n === 'number');
  const trendDays = 14;
  const trend = [];
  for (let d = trendDays - 1; d >= 0; d--) {
    const day = new Date(Date.now() - d * 864e5);
    const key = day.toISOString().slice(0, 10);
    trend.push({
      date: key,
      reported: issues.filter((i) => i.createdAt.slice(0, 10) === key).length,
      closed: issues.filter((i) => i.closedAt && i.closedAt.slice(0, 10) === key).length
    });
  }

  res.json({
    totals: {
      issues: issues.length,
      open: issues.filter((i) => OPEN.includes(i.status)).length,
      overdue: issues.filter((i) => OPEN.includes(i.status) && i.dueAt && new Date(i.dueAt) < new Date()).length,
      resolved: issues.filter((i) => i.status === 'RESOLVED').length,
      closed: closed.length,
      citizens: db.users.find({ role: 'citizen' }).length,
      corroborations: issues.reduce((a, i) => a + Math.max(0, (i.reportCount || 1) - 1), 0),
      contractorLiabilities: issues.filter((i) => i.contractor?.liable).length
    },
    sla: {
      compliance: resolvedish.length ? Math.round((onTime / resolvedish.length) * 100) : null,
      avgResolutionHours: durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1) : null
    },
    ai: {
      ...aiStatus(),
      classified: issues.length,
      avgConfidence: aiConfidences.length ? +(aiConfidences.reduce((a, b) => a + b, 0) / aiConfidences.length).toFixed(3) : null,
      humanReviewQueue: issues.filter((i) => i.humanReview).length,
      autoRouted: issues.filter((i) => !i.reclassified).length,
      overridden: issues.filter((i) => i.reclassified).length,
      fakeClosuresBlocked: db.audit.find({ action: 'CLOSURE_REJECTED' }).length
    },
    byStatus,
    bySeverity: Object.fromEntries(Object.entries(bySeverity).map(([k, v]) => [SEVERITY_LABELS[k] || k, v])),
    byCategory: Object.entries(byCategory)
      .map(([k, v]) => ({ category: k, label: CATEGORIES[k]?.label || k, count: v }))
      .sort((a, b) => b.count - a.count),
    byDepartment: Object.entries(byDepartment).map(([k, v]) => ({
      departmentId: k, name: db.departments.byId(k)?.name || k, count: v
    })).sort((a, b) => b.count - a.count),
    trend,
    hotspots: hotspots(issues, 2).slice(0, 10)
  });
});

router.get('/hotspots', requireAuth, (req, res) => {
  res.json({ hotspots: hotspots(db.issues.all(), Number(req.query.min) || 2) });
});

router.get('/ai-status', requireAuth, (_req, res) => res.json(aiStatus()));

router.get('/notifications', requireAuth, (req, res) => {
  res.json({
    notifications: db.notifications.find({ userId: req.user.id })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 40)
  });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  const n = db.notifications.byId(req.params.id);
  if (!n || n.userId !== req.user.id) return res.status(404).json({ error: 'Not found.' });
  res.json({ notification: db.notifications.update(n.id, { read: true }) });
});

router.get('/taxonomy', requireAuth, (_req, res) => {
  res.json({
    categories: Object.entries(CATEGORIES).map(([key, c]) => ({
      key, label: c.label, department: c.department, slaHours: c.slaHours, icon: c.icon
    })),
    severities: SEVERITY_LABELS
  });
});

export default router;
