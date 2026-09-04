import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { signToken, publicUser, requireAuth, requireRole, ROLES } from '../middleware/auth.js';
import { DEMO_ACCOUNTS } from '../seed.js';

const router = express.Router();

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

router.post('/register', (req, res) => {
  const { name, email, password, phone } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!emailOk(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.users.findOne({ email: String(email).toLowerCase() })) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const user = db.users.insert({
    name: String(name).trim(),
    email: String(email).toLowerCase(),
    phone: phone || null,
    role: ROLES.CITIZEN,
    passwordHash: bcrypt.hashSync(String(password), 8),
    trustScore: 0.6,
    reportsFiled: 0,
    verifiedReports: 0
  });

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.findOne({ email: String(email || '').toLowerCase() });
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (user.disabled) return res.status(403).json({ error: 'This account has been disabled.' });

  db.users.update(user.id, { lastLoginAt: new Date().toISOString() });
  const department = user.departmentId ? db.departments.byId(user.departmentId) : null;
  res.json({ token: signToken(user), user: publicUser(db.users.byId(user.id)), department });
});

router.get('/me', requireAuth, (req, res) => {
  const department = req.user.departmentId ? db.departments.byId(req.user.departmentId) : null;
  res.json({ user: publicUser(req.user), department });
});

/** Staff provisioning - control room only. */
router.post('/staff', requireAuth, requireRole(ROLES.ADMIN), (req, res) => {
  const { name, email, password, role, departmentId, employeeId } = req.body || {};
  if (![ROLES.WORKER, ROLES.SUPERVISOR, ROLES.ADMIN].includes(role)) {
    return res.status(400).json({ error: 'Role must be worker, supervisor or admin.' });
  }
  if (!emailOk(email)) return res.status(400).json({ error: 'Valid email required.' });
  if (role !== ROLES.ADMIN && !db.departments.byId(departmentId)) {
    return res.status(400).json({ error: 'A valid department is required for this role.' });
  }
  if (db.users.findOne({ email: String(email).toLowerCase() })) {
    return res.status(409).json({ error: 'Email already registered.' });
  }
  const user = db.users.insert({
    name, email: String(email).toLowerCase(), role,
    departmentId: role === ROLES.ADMIN ? null : departmentId,
    employeeId: employeeId || null,
    passwordHash: bcrypt.hashSync(String(password || 'Worker@123'), 8),
    trustScore: 1, reportsFiled: 0, verifiedReports: 0
  });
  res.status(201).json({ user: publicUser(user) });
});

router.get('/demo-accounts', (_req, res) => {
  res.json(DEMO_ACCOUNTS.map(({ name, email, password, role, departmentId }) =>
    ({ name, email, password, role, departmentId: departmentId || null })));
});

export default router;
