import bcrypt from 'bcrypt';
import { supabase } from '../config/supabase.js';

export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
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

  // 3. Return success (store a simple token in frontend)
  res.json({
    success: true,
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
