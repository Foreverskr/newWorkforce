// utils/session.js
//
// Wraps localStorage with two independent timeouts:
//  - SESSION_DURATION_MS: absolute max lifetime of a session (e.g. 8hr shift)
//  - IDLE_TIMEOUT_MS: logs out sooner if there's no user activity at all
//
// Storage shape (single key, easy to inspect in devtools):
// {
//   admin: { id, username },
//   token: '<jwt>',              // sent as Authorization: Bearer <token>
//   loginAt: 1690000000000,      // when they logged in
//   lastActivityAt: 1690003600000
// }
//
// Note: SESSION_DURATION_MS here should match the backend's JWT expiry
// (see TOKEN_EXPIRY in auth.controller.js) so the two stay in sync. The
// backend is the real enforcement point — this just lets the UI react
// without waiting for a failed API call.

const STORAGE_KEY = 'at_auth';

export const SESSION_DURATION_MS = 2 * 60 * 1000; // 2 minutes (testing only!)
export const IDLE_TIMEOUT_MS = 30 * 1000;         // 30 seconds idle (testing only!)

export function saveSession(admin, token) {
  const now = Date.now();
  const session = { admin, token, loginAt: now, lastActivityAt: now };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function getToken() {
  return getSession()?.token ?? null;
}

export function getSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function touchSession() {
  const session = getSession();
  if (!session) return;
  session.lastActivityAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Returns null if the session is still valid, or a reason string
 * ('expired' | 'idle') if it should be logged out.
 */
export function getSessionInvalidReason(session) {
  if (!session) return null;
  const now = Date.now();
  if (now - session.loginAt > SESSION_DURATION_MS) return 'expired';
  if (now - session.lastActivityAt > IDLE_TIMEOUT_MS) return 'idle';
  return null;
}