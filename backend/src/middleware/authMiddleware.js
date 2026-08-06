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
