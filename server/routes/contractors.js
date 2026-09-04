import express from 'express';
import db from '../db.js';
import { requireAuth, requireRole, ROLES } from '../middleware/auth.js';
import { findAccountable, queryOsmWorks, searchRegistry } from '../services/contractors.js';
import notify from '../services/notify.js';

const router = express.Router();

function accountability(contractorId) {
  const linked = db.issues.all().filter((i) => i.contractor?.contractorId === contractorId);
  const liable = linked.filter((i) => i.contractor?.liable);
  const closed = linked.filter((i) => i.status === 'CLOSED');
  return {
    linkedIssues: linked.length,
    liableIssues: liable.length,
    closedIssues: closed.length,
    openLiability: liable.filter((i) => i.status !== 'CLOSED').length,
    issues: linked.slice(0, 25).map((i) => ({
      id: i.id, code: i.code, category: i.categoryLabel, status: i.status,
      severity: i.severity, ward: i.wardName, createdAt: i.createdAt, liable: !!i.contractor?.liable
    }))
  };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.contractors.all().map((c) => ({ ...c, accountability: accountability(c.id) }));
  const q = String(req.query.q || '').toLowerCase();
  const filtered = q
    ? rows.filter((c) => `${c.name} ${c.agency} ${c.ward} ${c.workType}`.toLowerCase().includes(q))
    : rows;
  res.json({
    contractors: filtered.sort((a, b) => b.accountability.openLiability - a.accountability.openLiability)
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const c = db.contractors.byId(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  res.json({ contractor: { ...c, accountability: accountability(c.id) } });
});

/** Live open-data lookup for any point on the map. */
router.post('/lookup', requireAuth, async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Valid lat/lng required.' });
  }
  const point = { lat, lng };
  const result = await findAccountable({ point, ward: req.body.ward, category: req.body.category });
  res.json(result);
});

router.get('/osm/nearby', requireAuth, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng required.' });
  res.json({ works: await queryOsmWorks({ lat, lng }, Number(req.query.radius) || 500) });
});

/** Supervisors issue a formal defect notice against a liable contractor. */
router.post('/:id/notice', requireAuth, requireRole(ROLES.SUPERVISOR, ROLES.ADMIN), (req, res) => {
  const c = db.contractors.byId(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  const issue = req.body.issueId ? db.issues.byId(req.body.issueId) : null;

  const notices = [...(c.notices || []), {
    id: `ntc_${Date.now().toString(36)}`,
    issueId: issue?.id || null,
    issueCode: issue?.code || null,
    reason: String(req.body.reason || 'Defect during liability period').slice(0, 400),
    issuedBy: req.user.name,
    issuedAt: new Date().toISOString(),
    penaltyProposed: Number(req.body.penalty) || null
  }];
  const updated = db.contractors.update(c.id, {
    notices,
    rating: Math.max(1, +(c.rating - 0.2).toFixed(1))
  });

  if (issue) {
    notify.audit(issue.id, req.user, 'CONTRACTOR_NOTICE_ISSUED', { contractor: c.name, reason: req.body.reason });
    notify.toIssue(issue.id, 'issue:updated', { ...issue, contractorNotice: true });
  }
  notify.broadcast('contractor:updated', updated);
  res.json({ contractor: updated });
});

router.get('/registry/search', requireAuth, (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  res.json({
    results: searchRegistry({
      point: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
      ward: req.query.ward,
      category: req.query.category
    })
  });
});

export default router;
