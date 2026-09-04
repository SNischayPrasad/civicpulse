/**
 * Real-time alert bus.
 * Every AI classification result is pushed live over Socket.IO to the room of
 * the department that owns the category, to the reporting citizen, and to the
 * city-wide control room - no polling, no refresh.
 */
import db from '../db.js';

let io = null;
export function attachIo(server) { io = server; }

export const rooms = {
  dept: (id) => `dept:${id}`,
  user: (id) => `user:${id}`,
  city: 'city:control',
  issue: (id) => `issue:${id}`
};

function emit(room, event, payload) {
  if (!io) return;
  io.to(room).emit(event, payload);
}

export function toDepartment(departmentId, event, payload) {
  emit(rooms.dept(departmentId), event, payload);
  emit(rooms.city, event, payload);
}

export function toUser(userId, event, payload) {
  emit(rooms.user(userId), event, payload);
}

export function toIssue(issueId, event, payload) {
  emit(rooms.issue(issueId), event, payload);
  emit(rooms.city, event, payload);
}

export function broadcast(event, payload) {
  if (io) io.emit(event, payload);
}

/**
 * Raise a department alert. This is the "AI -> department" hand-off:
 * persisted (so it survives reload), pushed live, and mirrored to the citizen.
 */
export function raiseAlert({ issueId, departmentId, level = 'info', title, message, meta = {} }) {
  const alert = db.alerts.insert({
    issueId, departmentId, level, title, message, meta,
    read: false, channel: 'realtime+dashboard'
  });
  toDepartment(departmentId, 'alert:new', alert);
  if (issueId) toIssue(issueId, 'alert:new', alert);
  return alert;
}

export function notifyUser(userId, { issueId, title, message, level = 'info' }) {
  const n = db.notifications.insert({ userId, issueId, title, message, level, read: false });
  toUser(userId, 'notification:new', n);
  return n;
}

export function audit(issueId, actor, action, detail = {}) {
  const entry = db.audit.insert({
    issueId,
    actorId: actor?.id || null,
    actorName: actor?.name || 'System',
    actorRole: actor?.role || 'system',
    action,
    detail
  });
  toIssue(issueId, 'issue:audit', entry);
  return entry;
}

export default { attachIo, raiseAlert, notifyUser, audit, toDepartment, toUser, toIssue, broadcast, rooms };
