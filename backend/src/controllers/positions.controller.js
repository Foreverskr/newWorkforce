import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

export async function listPositions(req, res) {
  // Fetch all positions from the 'positions' table
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .order('name', { ascending: true });
    
  if (error) return handleError(res, error);
  res.json(data);
}

export async function createPosition(req, res) {
  const { name, description, max_weekly_hours } = req.body;
  if (!name) return res.status(400).json({ error: 'Position name is required' });
  
  const { data, error } = await supabase
    .from('positions')
    .insert([{ name, description, max_weekly_hours }])
    .select()
    .single();
    
  if (error) return handleError(res, error);
  res.status(201).json(data);
}