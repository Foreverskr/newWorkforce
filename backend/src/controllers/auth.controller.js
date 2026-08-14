import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '8h'; // testing only! // <- backend's source of truth for session length

export async function login(req, res) {
  const { username, password } = req.body;
  console.log('Login attempt for username:', username);

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

  console.log('Supabase query result — admin:', admin, 'error:', error);

  if (error || !admin) {
    console.log('Login failed: admin not found or query error');
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // 2. Compare password with bcrypt hash
  const passwordMatches = await bcrypt.compare(password, admin.password);
  console.log('Password match result:', passwordMatches);

  if (!passwordMatches) {
    console.log('Login failed: password mismatch');
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // 2.5 Guard against a missing role before signing anything into the token
  if (!admin.role) {
    console.error('Admin record missing role:', admin.username);
    return res.status(500).json({ error: 'Account misconfigured — contact an administrator' });
  }

  // 3. Issue a signed token. The 8hr expiry lives INSIDE the token, so the
  // server itself will reject it after 8 hours — not just the frontend UI.
  const token = jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  res.json({
    success: true,
    token,
    admin: {
      id: admin.id,
      username: admin.username,
      name: admin.name || admin.full_name || admin.username,
      role: admin.role || admin.position || 'Admin',
      status: admin.status || (admin.is_active === false ? 'inactive' : 'active'),
    },
  });
}

// ← helper to generate a bcrypt hash (remove in production!)
export async function hashPassword(req, res) {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const hash = await bcrypt.hash(password, 10);
  res.json({ hash });
}