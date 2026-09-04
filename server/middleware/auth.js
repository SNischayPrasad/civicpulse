/**
 * Authentication + role gates.
 * Nothing in the platform is reachable without a valid token: the citizen app,
 * the department console and the control room all sit behind this.
 */
import jwt from 'jsonwebtoken';
import config from '../config.js';
import db from '../db.js';

export const ROLES = {
  CITIZEN: 'citizen',
  WORKER: 'worker',
  SUPERVISOR: 'supervisor',
  ADMIN: 'admin'
};

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, departmentId: user.departmentId || null },
    config.jwtSecret,
    { expiresIn: config.jwtExpiry }
  );
}

export function verifyToken(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch { return null; }
}

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function extract(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

export function requireAuth(req, res, next) {
  const token = extract(req);
  if (!token) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  const user = db.users.byId(payload.sub);
  if (!user || user.disabled) return res.status(401).json({ error: 'Account not found or disabled.' });
  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action needs one of: ${roles.join(', ')}.` });
    }
    next();
  };
}

/** Staff = anyone who works for a department. */
export const requireStaff = requireRole(ROLES.WORKER, ROLES.SUPERVISOR, ROLES.ADMIN);

export default { requireAuth, requireRole, requireStaff, signToken, verifyToken, publicUser, ROLES };
