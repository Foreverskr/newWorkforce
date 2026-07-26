import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '2m'; // testing only! // <- backend's source of truth for session length

export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!JWT_SECRET) {
    console.error('JWT_SECRET is not set in environment variables');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // 1. Find admin by username
  const { data: admin, error } = await supabase
    .from('admins')
    .select('*')
    .eq('username', username)
    .single();

  if (error || !admin) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // 2. Compare password with bcrypt hash
  const match = await bcrypt.compare(password, admin.password);
  if (!match) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // 3. Issue a signed token. The 8hr expiry lives INSIDE the token, so the
  // server itself will reject it after 8 hours — not just the frontend UI.
  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  res.json({
    success: true,
    token,
    admin: { id: admin.id, username: admin.username },
  });
}

// ← helper to generate a bcrypt hash (remove in production!)
export async function hashPassword(req, res) {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const hash = await bcrypt.hash(password, 10);
  res.json({ hash });
}