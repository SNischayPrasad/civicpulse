import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import db from '../db.js';
import { requireAuth, requireRole, requireStaff, ROLES } from '../middleware/auth.js';
import { analyseIssue, verifyResolution, angleDiversity } from '../services/ai/index.js';
import { categoryMeta, SEVERITY_LABELS } from '../services/ai/taxonomy.js';
import { readExif } from '../services/exif.js';
import { reverseGeocode, findNearby, haversine } from '../services/geo.js';
import { findAccountable, accountableFromRegistry } from '../services/contractors.js';
import { resolveAddress } from '../services/ai/address.js';
import notify from '../services/notify.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.policy.maxUploadBytes, files: config.policy.maxPhotos },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|jpg|png)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG or PNG photos are accepted.'));
  }
});

const OPEN_STATUSES = ['REPORTED', 'ROUTED', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'];

/* ------------------------------------------------------------------ helpers */

function nextCode() {
  const year = new Date().getFullYear();
  const n = db.issues.count() + 1;
  return `CP-${year}-${String(n).padStart(4, '0')}`;
}

function savePhotos(issueId, files, kind, uploaderId, hashes = []) {
  const dir = path.join(config.paths.uploads, issueId);
  fs.mkdirSync(dir, { recursive: true });
  return files.map((f, i) => {
    const ext = /png/i.test(f.mimetype) ? 'png' : 'jpg';
    const name = `${kind}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${i + 1}.${ext}`;
    fs.writeFileSync(path.join(dir, name), f.buffer);
    const exif = readExif(f.buffer);
    const rec = {
      issueId, kind, angle: i + 1,
      url: `/uploads/${issueId}/${name}`,
      filename: f.originalname,
      bytes: f.size,
      hashes: hashes[i] || null,
      exif: { hasExif: exif.hasExif, gps: exif.gps, capturedAt: exif.capturedAt, camera: exif.camera },
      uploadedBy: uploaderId
    };
    db.evidence.insert(rec);
    return rec;
  });
}

function priorityScore(issue) {
  const ageH = (Date.now() - new Date(issue.createdAt).getTime()) / 36e5;
  return Math.round(
    issue.severity * 20 +
    Math.min(30, (issue.reportCount || 1) * 6) +
    Math.min(20, ageH / 6) +
    (issue.escalated ? 15 : 0)
  );
}

function decorate(issue) {
  if (!issue) return null;
  const dept = db.departments.byId(issue.departmentId);
  const evidence = db.evidence.find({ issueId: issue.id });
  return {
    ...issue,
    priorityScore: priorityScore(issue),
    department: dept ? { id: dept.id, name: dept.name, code: dept.code, color: dept.color, email: dept.email } : null,
    evidence: {
      report: evidence.filter((e) => e.kind === 'report'),
      before: evidence.filter((e) => e.kind === 'before'),
      after: evidence.filter((e) => e.kind === 'after')
    },
    overdue: issue.dueAt ? new Date(issue.dueAt).getTime() < Date.now() && OPEN_STATUSES.includes(issue.status) : false
  };
}

function canTouch(user, issue) {
  if (user.role === ROLES.ADMIN) return true;
  if ([ROLES.WORKER, ROLES.SUPERVISOR].includes(user.role)) return user.departmentId === issue.departmentId;
  return false;
}

/* ------------------------------------------------------- POST /api/issues */

router.post('/', requireAuth, upload.array('photos', config.policy.maxPhotos), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length < config.policy.minPhotos) {
      return res.status(400).json({ error: `Please attach at least ${config.policy.minPhotos} photo of the issue.` });
    }
    if (files.length > config.policy.maxPhotos) {
      return res.status(400).json({ error: `You can attach a maximum of ${config.policy.maxPhotos} photos per issue.` });
    }

    const buffers = files.map((f) => f.buffer);
    const description = String(req.body.description || '').slice(0, 1200);
    const landmark = String(req.body.landmark || '').slice(0, 200);

    // ---- location: EXIF GPS is trusted first, browser GPS second -----------
    const exifs = buffers.map(readExif);
    const exifGps = exifs.map((e) => e.gps).find(Boolean) || null;
    const bodyLat = Number(req.body.lat);
    const bodyLng = Number(req.body.lng);
    const browserGps = Number.isFinite(bodyLat) && Number.isFinite(bodyLng)
      ? { lat: bodyLat, lng: bodyLng, accuracy: Number(req.body.accuracy) || null, source: 'device' }
      : null;

    const location = exifGps || browserGps;
    if (!location) {
      return res.status(400).json({
        error: 'Location required. Allow location access in your browser, or upload a photo that carries GPS data.'
      });
    }
    const locationTrust = exifGps && browserGps
      ? (haversine(exifGps, browserGps) < 250 ? 'high (photo GPS matches device GPS)' : 'medium (photo GPS differs from device GPS)')
      : exifGps ? 'high (photo carries embedded GPS)' : 'medium (device GPS only)';

    // ---- AI: classify before anything is written --------------------------
    const nearbyAll = findNearby(db.issues.all(), location, null, config.policy.duplicateRadiusM);
    const ai = await analyseIssue(buffers, description, { duplicateCount: nearbyAll.length });
    if (!ai.ok) return res.status(400).json({ error: ai.error });

    const diversity = angleDiversity(ai.hashes);
    const place = await reverseGeocode(location);

    // ---- crowd intelligence: merge into an existing cluster ---------------
    const nearSame = findNearby(db.issues.all(), location, ai.category, config.policy.duplicateRadiusM);
    const existing = nearSame[0]?.issue;
    if (existing) {
      const already = (existing.corroborators || []).includes(req.user.id) || existing.reporterId === req.user.id;
      if (!already) {
        const reportCount = (existing.reportCount || 1) + 1;
        const severity = Math.min(5, existing.severity + (reportCount % 3 === 0 ? 1 : 0));
        const updated = db.issues.update(existing.id, {
          reportCount,
          corroborators: [...(existing.corroborators || []), req.user.id],
          severity,
          severityLabel: SEVERITY_LABELS[severity],
          lastCorroboratedAt: new Date().toISOString()
        });
        savePhotos(existing.id, files, 'report', req.user.id, ai.hashes);
        notify.audit(existing.id, req.user, 'CORROBORATED', {
          reportCount, distanceM: Math.round(nearSame[0].distance)
        });
        notify.raiseAlert({
          issueId: existing.id, departmentId: existing.departmentId, level: reportCount >= 3 ? 'warning' : 'info',
          title: `${reportCount} citizens now reporting ${categoryMeta(existing.category).label}`,
          message: `${existing.code} at ${existing.wardName || existing.address} has been confirmed by ${reportCount} independent reports. Priority raised.`,
          meta: { reportCount, severity }
        });
        notify.toIssue(existing.id, 'issue:updated', decorate(db.issues.byId(existing.id)));
        db.users.update(req.user.id, { reportsFiled: (req.user.reportsFiled || 0) + 1 });
      }
      return res.status(200).json({
        duplicate: true,
        message: `We matched your report to an existing issue ${Math.round(nearSame[0].distance)} m away. Your photos strengthen it.`,
        issue: decorate(db.issues.byId(existing.id)),
        ai
      });
    }

    // ---- AI address resolution ---------------------------------------------
    // Reads signboards, house numbers and street names out of the photo itself
    // and geocodes them against OpenStreetMap, biased to the GPS fix.
    const addressAI = await resolveAddress({ buffers, point: location, description, place })
      .catch(() => null);

    // ---- contractor accountability from the open-contracts registry --------
    // Runs synchronously (no network) so the citizen sees responsibility
    // assigned in the same response. OSM enrichment follows asynchronously.
    const liability = accountableFromRegistry({ point: location, ward: place?.ward, category: ai.category });

    // ---- create the issue -------------------------------------------------
    const meta = categoryMeta(ai.category);
    const now = Date.now();
    const issue = db.issues.insert({
      code: nextCode(),
      reporterId: req.user.id,
      reporterName: req.user.name,
      description,
      landmark,
      category: ai.category,
      categoryLabel: ai.categoryLabel,
      icon: ai.icon,
      severity: ai.severity,
      severityLabel: ai.severityLabel,
      departmentId: ai.departmentId,
      status: 'ROUTED',
      location: { ...location, trust: locationTrust },
      address: addressAI?.formatted || place?.address || null,
      addressAI,
      ward: place?.ward || null,
      wardName: place?.wardName || null,
      city: place?.city || null,
      geoSource: place?.source || 'offline-grid',
      reportCount: 1,
      corroborators: [],
      slaHours: meta.slaHours,
      dueAt: new Date(now + meta.slaHours * 36e5).toISOString(),
      escalated: false,
      humanReview: ai.needsHumanReview,
      angleCheck: diversity,
      ai: {
        engine: ai.engine, provider: ai.provider, model: ai.model,
        confidence: ai.confidence, summary: ai.summary,
        evidence: ai.evidence, alternates: ai.alternates,
        objects: ai.objects, hazards: ai.hazards,
        textSignal: ai.textSignal, urgencyCues: ai.urgencyCues,
        agreement: ai.agreement, angles: ai.angles,
        features: ai.features, processingMs: ai.processingMs,
        classifiedAt: new Date().toISOString()
      },
      contractor: liability.accountable,
      contractorReasoning: liability.reasoning,
      contractorSources: { osm: [], registry: liability.registry },
      contractorLookup: liability.accountable ? 'registry-matched' : 'pending'
    });

    const photos = savePhotos(issue.id, files, 'report', req.user.id, ai.hashes);
    db.users.update(req.user.id, { reportsFiled: (req.user.reportsFiled || 0) + 1 });

    notify.audit(issue.id, req.user, 'REPORTED', {
      category: ai.category, confidence: ai.confidence, photos: photos.length
    });
    notify.audit(issue.id, null, 'AI_ROUTED', {
      department: db.departments.byId(ai.departmentId)?.name,
      engine: ai.engine, confidence: ai.confidence, slaHours: meta.slaHours
    });
    if (addressAI) {
      notify.audit(issue.id, null, 'ADDRESS_RESOLVED', {
        address: addressAI.formatted,
        confidence: addressAI.confidence,
        signals: addressAI.signals,
        ocrLines: addressAI.ocr.lines.length,
        snapped: addressAI.snapped
      });
    }

    const dept = db.departments.byId(ai.departmentId);
    notify.raiseAlert({
      issueId: issue.id,
      departmentId: ai.departmentId,
      level: ai.severity >= 4 ? 'critical' : ai.severity >= 3 ? 'warning' : 'info',
      title: `New ${ai.categoryLabel} - ${SEVERITY_LABELS[ai.severity]}`,
      message: `${issue.code} auto-routed to ${dept?.name} by ${ai.engine} (confidence ${(ai.confidence * 100).toFixed(0)}%). ${ai.summary} Address: ${issue.address || issue.wardName}. SLA ${meta.slaHours}h.`,
      meta: { category: ai.category, severity: ai.severity, confidence: ai.confidence, ward: issue.ward, needsHumanReview: ai.needsHumanReview }
    });
    notify.notifyUser(req.user.id, {
      issueId: issue.id,
      title: `${issue.code} routed to ${dept?.name}`,
      message: `Our AI identified this as ${ai.categoryLabel}. Target resolution within ${meta.slaHours} hours.`
    });
    if (liability.accountable) {
      notify.audit(issue.id, null, 'CONTRACTOR_IDENTIFIED', {
        name: liability.accountable.name,
        liable: liability.accountable.liable,
        source: liability.accountable.source
      });
      if (liability.accountable.liable) {
        notify.raiseAlert({
          issueId: issue.id, departmentId: ai.departmentId, level: 'warning',
          title: `Contractor liability: ${liability.accountable.name}`,
          message: `${issue.code} falls inside an active Defect Liability Period for work order ${liability.accountable.workOrderNo}. Rectification is recoverable from ${liability.accountable.name}.`,
          meta: { contractorId: liability.accountable.contractorId }
        });
      }
    }

    notify.broadcast('issue:new', decorate(issue));

    res.status(201).json({ duplicate: false, issue: decorate(issue), ai });

    // ---- OpenStreetMap enrichment runs after the response (non-blocking) --
    findAccountable({ point: location, ward: issue.ward, category: ai.category })
      .then(({ accountable, reasoning, osm, registry }) => {
        const updated = db.issues.update(issue.id, {
          contractor: accountable,
          contractorReasoning: reasoning,
          contractorSources: { osm: osm.slice(0, 5), registry: registry.slice(0, 3) },
          contractorLookup: 'done'
        });
        if (accountable && !liability.accountable) {
          notify.audit(issue.id, null, 'CONTRACTOR_IDENTIFIED', {
            name: accountable.name, liable: accountable.liable, source: accountable.source
          });
        }
        notify.toIssue(issue.id, 'issue:updated', decorate(updated));
        notify.broadcast('issue:updated', decorate(updated));
      })
      .catch(() => db.issues.update(issue.id, { contractorLookup: 'failed' }));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not process this report.' });
  }
});

/* -------------------------------------------------------- GET /api/issues */

router.get('/', requireAuth, (req, res) => {
  const { scope, status, category, departmentId, ward, q } = req.query;
  let rows = db.issues.all();

  if (scope === 'mine') {
    rows = rows.filter((i) => i.reporterId === req.user.id || (i.corroborators || []).includes(req.user.id));
  } else if (scope === 'department') {
    const d = departmentId || req.user.departmentId;
    rows = rows.filter((i) => i.departmentId === d);
  } else if (scope === 'assigned') {
    rows = rows.filter((i) => i.assignedTo === req.user.id);
  } else if (req.user.role === ROLES.WORKER || req.user.role === ROLES.SUPERVISOR) {
    rows = rows.filter((i) => i.departmentId === req.user.departmentId);
  }

  if (status) rows = rows.filter((i) => String(status).split(',').includes(i.status));
  if (category) rows = rows.filter((i) => i.category === category);
  if (ward) rows = rows.filter((i) => i.ward === ward);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((i) =>
      [i.code, i.description, i.categoryLabel, i.address, i.wardName].filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(needle)));
  }

  const out = rows.map(decorate).sort((a, b) => b.priorityScore - a.priorityScore || new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ count: out.length, issues: out.slice(0, Number(req.query.limit) || 300) });
});

router.get('/:id', requireAuth, (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  res.json({
    issue: decorate(issue),
    audit: db.audit.find({ issueId: issue.id }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    alerts: db.alerts.find({ issueId: issue.id })
  });
});

/* ------------------------------------------------------ staff transitions */

function transition(issue, patch, user, action, detail = {}) {
  const updated = db.issues.update(issue.id, patch);
  notify.audit(issue.id, user, action, detail);
  const payload = decorate(updated);
  notify.toIssue(issue.id, 'issue:updated', payload);
  notify.toDepartment(updated.departmentId, 'issue:updated', payload);
  notify.broadcast('issue:updated', payload);
  return payload;
}

router.post('/:id/acknowledge', requireAuth, requireStaff, (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  if (!canTouch(req.user, issue)) return res.status(403).json({ error: 'This issue belongs to another department.' });

  const out = transition(issue, {
    status: 'ACKNOWLEDGED',
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: req.user.id
  }, req.user, 'ACKNOWLEDGED', { by: req.user.name });

  notify.notifyUser(issue.reporterId, {
    issueId: issue.id, title: `${issue.code} acknowledged`,
    message: `${db.departments.byId(issue.departmentId)?.name} has acknowledged your report.`
  });
  res.json({ issue: out });
});

router.post('/:id/assign', requireAuth, requireRole(ROLES.SUPERVISOR, ROLES.ADMIN), (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  if (!canTouch(req.user, issue)) return res.status(403).json({ error: 'This issue belongs to another department.' });

  const worker = db.users.byId(req.body.workerId);
  if (!worker || ![ROLES.WORKER, ROLES.SUPERVISOR].includes(worker.role)) {
    return res.status(400).json({ error: 'Select a valid field worker.' });
  }

  const out = transition(issue, {
    status: 'ASSIGNED',
    assignedTo: worker.id,
    assignedToName: worker.name,
    assignedAt: new Date().toISOString()
  }, req.user, 'ASSIGNED', { worker: worker.name });

  notify.toUser(worker.id, 'task:assigned', out);
  notify.notifyUser(worker.id, {
    issueId: issue.id, title: `New field task ${issue.code}`,
    message: `${issue.categoryLabel} at ${issue.wardName || issue.address}. Due ${new Date(issue.dueAt).toLocaleString()}.`
  });
  notify.notifyUser(issue.reporterId, {
    issueId: issue.id, title: `${issue.code} assigned to a field team`,
    message: `${worker.name} is now responsible for resolving your report.`
  });
  res.json({ issue: out });
});

router.post('/:id/start', requireAuth, requireStaff, (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  if (!canTouch(req.user, issue)) return res.status(403).json({ error: 'Not your department.' });
  const out = transition(issue, {
    status: 'IN_PROGRESS',
    startedAt: new Date().toISOString(),
    assignedTo: issue.assignedTo || req.user.id,
    assignedToName: issue.assignedToName || req.user.name
  }, req.user, 'WORK_STARTED', { by: req.user.name });
  notify.notifyUser(issue.reporterId, {
    issueId: issue.id, title: `Work started on ${issue.code}`,
    message: 'A field team is now working on the issue you reported.'
  });
  res.json({ issue: out });
});

/** Worker uploads "before" evidence from multiple angles. */
router.post('/:id/before', requireAuth, requireStaff, upload.array('photos', config.policy.maxPhotos), (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  if (!canTouch(req.user, issue)) return res.status(403).json({ error: 'Not your department.' });

  const files = req.files || [];
  if (files.length < 2) return res.status(400).json({ error: 'Upload at least 2 "before" photos from different angles.' });

  try {
    const analysis = analyseBufferHashes(files.map((f) => f.buffer));
    const diversity = angleDiversity(analysis);
    if (!diversity.ok) return res.status(400).json({ error: diversity.note });

    const saved = savePhotos(issue.id, files, 'before', req.user.id, analysis);
    const out = transition(issue, {
      status: issue.status === 'RESOLVED' ? issue.status : 'IN_PROGRESS',
      beforeCapturedAt: new Date().toISOString()
    }, req.user, 'BEFORE_EVIDENCE', { photos: saved.length, angleCheck: diversity });
    res.json({ issue: out, angleCheck: diversity });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Worker closes the job with "after" evidence - AI verifies it is genuine. */
router.post('/:id/resolve', requireAuth, requireStaff, upload.array('photos', config.policy.maxPhotos), async (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  if (!canTouch(req.user, issue)) return res.status(403).json({ error: 'Not your department.' });

  const files = req.files || [];
  if (files.length < 2) {
    return res.status(400).json({ error: 'Upload at least 2 "after" photos from different angles to close this issue.' });
  }

  const beforeRecords = db.evidence.find({ issueId: issue.id }).filter((e) => e.kind === 'before');
  const reportRecords = db.evidence.find({ issueId: issue.id }).filter((e) => e.kind === 'report');
  const baseline = (beforeRecords.length ? beforeRecords : reportRecords);
  if (!baseline.length) return res.status(400).json({ error: 'No baseline evidence found for this issue.' });

  try {
    const beforeBuffers = baseline
      .map((e) => path.join(config.paths.root, e.url.replace(/^\//, '')))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p));

    const verification = await verifyResolution({
      beforeBuffers,
      afterBuffers: files.map((f) => f.buffer),
      category: issue.category
    });

    if (verification.recycledEvidence) {
      notify.audit(issue.id, req.user, 'CLOSURE_REJECTED', { reason: 'recycled evidence', crossDistance: verification.crossDistance });
      notify.raiseAlert({
        issueId: issue.id, departmentId: issue.departmentId, level: 'critical',
        title: `Fake closure attempt blocked on ${issue.code}`,
        message: `An "after" photo submitted by ${req.user.name} is a near-duplicate of the original evidence. Closure rejected by CivicVision.`,
        meta: { crossDistance: verification.crossDistance }
      });
      return res.status(422).json({ error: 'Closure rejected: the "after" photos are near-identical to the original evidence. Please capture the completed work.', verification });
    }

    const saved = savePhotos(issue.id, files, 'after', req.user.id, verification.afterHashes);
    const notes = String(req.body.notes || '').slice(0, 800);

    const out = transition(issue, {
      status: 'RESOLVED',
      resolvedAt: new Date().toISOString(),
      resolvedBy: req.user.id,
      resolvedByName: req.user.name,
      resolution: {
        notes,
        workerId: req.user.id,
        workerName: req.user.name,
        photos: saved.length,
        verification: {
          verified: verification.verified,
          improvementScore: verification.improvementScore,
          metrics: verification.metrics,
          angleDiversity: verification.angleDiversity,
          notes: verification.notes,
          crossDistance: verification.crossDistance
        },
        withinSla: new Date().getTime() <= new Date(issue.dueAt).getTime()
      }
    }, req.user, 'RESOLVED', {
      verified: verification.verified,
      improvementScore: verification.improvementScore,
      photos: saved.length
    });

    notify.notifyUser(issue.reporterId, {
      issueId: issue.id,
      title: `${issue.code} marked resolved`,
      message: verification.verified
        ? 'CivicVision confirmed visible improvement. Please review the before/after photos and confirm.'
        : 'Work has been submitted but CivicVision could not confirm improvement. Your review decides the outcome.',
      level: verification.verified ? 'success' : 'warning'
    });
    notify.raiseAlert({
      issueId: issue.id, departmentId: issue.departmentId,
      level: verification.verified ? 'success' : 'warning',
      title: `${issue.code} resolved by ${req.user.name}`,
      message: verification.verified
        ? `CivicVision verified the closure evidence (improvement score ${verification.improvementScore}). Awaiting citizen confirmation.`
        : `Closure evidence submitted but improvement could not be confirmed (score ${verification.improvementScore}). Supervisor review recommended.`,
      meta: { improvementScore: verification.improvementScore }
    });

    res.json({ issue: out, verification });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Citizen confirms or rejects the closure. */
router.post('/:id/verify', requireAuth, (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const isOwner = issue.reporterId === req.user.id || (issue.corroborators || []).includes(req.user.id);
  if (!isOwner && req.user.role !== ROLES.ADMIN) {
    return res.status(403).json({ error: 'Only the citizen who reported this issue can verify it.' });
  }
  if (issue.status !== 'RESOLVED') return res.status(400).json({ error: 'This issue has not been marked resolved yet.' });

  const accepted = req.body.accepted !== false;
  const rating = Math.max(1, Math.min(5, Number(req.body.rating) || (accepted ? 4 : 2)));
  const comment = String(req.body.comment || '').slice(0, 500);

  if (accepted) {
    const out = transition(issue, {
      status: 'CLOSED',
      verifiedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      citizenFeedback: { accepted: true, rating, comment, by: req.user.name }
    }, req.user, 'CITIZEN_VERIFIED', { rating });

    const worker = issue.resolvedBy ? db.users.byId(issue.resolvedBy) : null;
    if (worker) db.users.update(worker.id, { verifiedReports: (worker.verifiedReports || 0) + 1 });
    db.users.update(req.user.id, {
      trustScore: Math.min(1, (req.user.trustScore || 0.6) + 0.05),
      verifiedReports: (req.user.verifiedReports || 0) + 1
    });
    notify.raiseAlert({
      issueId: issue.id, departmentId: issue.departmentId, level: 'success',
      title: `${issue.code} closed and verified by citizen`,
      message: `${req.user.name} confirmed the fix with a ${rating}/5 rating.`, meta: { rating }
    });
    return res.json({ issue: out });
  }

  const out = transition(issue, {
    status: 'ESCALATED',
    escalated: true,
    reopenedAt: new Date().toISOString(),
    citizenFeedback: { accepted: false, rating, comment, by: req.user.name },
    dueAt: new Date(Date.now() + 24 * 36e5).toISOString()
  }, req.user, 'CITIZEN_REJECTED', { rating, comment });

  notify.raiseAlert({
    issueId: issue.id, departmentId: issue.departmentId, level: 'critical',
    title: `Closure rejected by citizen on ${issue.code}`,
    message: `${req.user.name} rejected the closure: "${comment || 'no comment'}". Re-opened with a 24 hour SLA.`,
    meta: { rating }
  });
  res.json({ issue: out });
});

/** Human-in-the-loop override of the AI classification. */
router.post('/:id/reclassify', requireAuth, requireRole(ROLES.SUPERVISOR, ROLES.ADMIN), (req, res) => {
  const issue = db.issues.byId(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const meta = categoryMeta(req.body.category);
  if (!req.body.category || meta.label === 'Unclassified Civic Issue') {
    return res.status(400).json({ error: 'Choose a valid category.' });
  }
  const severity = Math.max(1, Math.min(5, Number(req.body.severity) || issue.severity));
  const out = transition(issue, {
    category: req.body.category,
    categoryLabel: meta.label,
    icon: meta.icon,
    severity,
    severityLabel: SEVERITY_LABELS[severity],
    departmentId: meta.department,
    slaHours: meta.slaHours,
    dueAt: new Date(Date.now() + meta.slaHours * 36e5).toISOString(),
    humanReview: false,
    reclassified: {
      from: issue.category, by: req.user.name, at: new Date().toISOString(),
      reason: String(req.body.reason || '').slice(0, 300)
    }
  }, req.user, 'RECLASSIFIED', { from: issue.category, to: req.body.category });

  notify.raiseAlert({
    issueId: issue.id, departmentId: meta.department, level: 'info',
    title: `Issue re-routed to your department`,
    message: `${issue.code} was re-classified from ${issue.categoryLabel} to ${meta.label} by ${req.user.name}.`,
    meta: {}
  });
  res.json({ issue: out });
});

/* --------------------------------------------------------------- utilities */

import { decodeImage, perceptualHash } from '../services/ai/heuristic.js';
function analyseBufferHashes(buffers) {
  return buffers.map((b) => perceptualHash(decodeImage(b)));
}

export default router;
