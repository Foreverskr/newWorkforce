import { supabase } from '../config/supabase.js';

export async function check(req, res) {
  const { error } = await supabase.from('employees').select('id').limit(1);
  res.json({
    status: error ? 'error' : 'ok',
    supabase: error ? error.message : 'connected',
    timestamp: new Date().toISOString(),
  });
}
