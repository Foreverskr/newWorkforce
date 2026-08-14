import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

// Protects any router it's applied to. Expects: Authorization: Bearer <token>
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated', code: 'NO_TOKEN' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET); // throws if invalid or expired
    req.admin = payload; // { id, username, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid session', code: 'INVALID_TOKEN' });
  }
}

const PERMISSIONS = {
  admin: ['*'],

  hr_manager: [
    'employees:read',
    'attendance:read',
    'leaves:read', 'leaves:approve',
    'drivers:read',
    'positions:read',
    'staffingRequirements:read', 'staffingRequirements:propose', 'staffingRequirements:approve',
    'analytics:read',
    'schedule:read', 'schedule:propose', 'schedule:approve',
    'shiftTemplates:read',
  ],

  hr_staff: [
    'employees:read',
    'attendance:read',
    'leaves:read',
    'drivers:read',
    'positions:read',
    'staffingRequirements:read', 'staffingRequirements:propose',
    'schedule:read', 'schedule:propose',
    'fingerprints:enroll',
  ],
};

function hasPermission(role, permission) {
  const allowed = PERMISSIONS[role] || [];
  return allowed.includes('*') || allowed.includes(permission);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.admin?.role) {
      return res.status(403).json({ error: 'No role on session' });
    }
    if (!hasPermission(req.admin.role, permission)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

export { hasPermission };