import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';
import { notifyHr1 } from '../utils/notifyHr1.js';

const INACTIVITY_DAYS_THRESHOLD = 7;

export async function getAll(req, res) {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .order('name', { ascending: true });
  if (error) return handleError(res, error);
  res.json(data);
}

export async function create(req, res) {
  const { name, driver_id, license_number, license_expiry, vehicle_plate, last_trip_date } = req.body;
  if (!name || !driver_id) {
    return res.status(400).json({ error: 'name and driver_id are required' });
  }
  const { data, error } = await supabase
    .from('drivers')
    .insert([{ name, driver_id, license_number, license_expiry, vehicle_plate, last_trip_date, status: 'active' }])
    .select()
    .single();
  if (error) return handleError(res, error);
  res.status(201).json(data);
}

export async function update(req, res) {
  const { name, license_number, license_expiry, vehicle_plate, last_trip_date, status } = req.body;
  const { data, error } = await supabase
    .from('drivers')
    .update({ name, license_number, license_expiry, vehicle_plate, last_trip_date, status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return handleError(res, error);
  res.json(data);
}

export async function remove(req, res) {
  const { error } = await supabase.from('drivers').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Driver deleted' });
}

export async function getInactivityLogs(req, res) {
  const { data, error } = await supabase
    .from('driver_inactivity_logs')
    .select('*, drivers(name, driver_id)')
    .order('detected_at', { ascending: false })
    .limit(100);
  if (error) return handleError(res, error);
  res.json(data);
}

// Scans all drivers for: license expired OR no trips logged in last 7 days.
// For each newly-flagged driver: marks status='inactive', logs the event, and
// notifies HR1 via webhook (if HR1_WEBHOOK_URL is configured).
export async function checkInactivity(req, res) {
  const { data: drivers, error } = await supabase.from('drivers').select('*');
  if (error) return handleError(res, error);

  const today = new Date();
  const results = [];

  for (const driver of drivers) {
    const reasons = [];
    const details = {};

    // Signal 1: license expired
    if (driver.license_expiry && new Date(driver.license_expiry) < today) {
      reasons.push('license_expired');
      details.license_expiry = driver.license_expiry;
    }

    // Signal 2: no trips logged in last N days
    let daysSinceTrip = null;
    if (driver.last_trip_date) {
      daysSinceTrip = Math.floor((today - new Date(driver.last_trip_date)) / 86400000);
    }
    if (daysSinceTrip === null || daysSinceTrip > INACTIVITY_DAYS_THRESHOLD) {
      reasons.push('no_trips');
      details.last_trip_date = driver.last_trip_date || null;
      details.days_since_trip = daysSinceTrip;
    }

    const isInactive = reasons.length > 0;

    // Skip drivers that are already marked inactive — don't re-notify every check
    if (isInactive && driver.status !== 'inactive') {
      // Mark driver inactive
      await supabase
        .from('drivers')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('id', driver.id);

      // Notify HR1 via webhook
      const { hr1Notified, hr1Response } = await notifyHr1(driver, reasons, details);

      // Log the event regardless of webhook outcome
      await supabase.from('driver_inactivity_logs').insert([{
        driver_id:    driver.id,
        reason:       reasons.join(','),
        details,
        hr1_notified: hr1Notified,
        hr1_response: hr1Response,
      }]);

      results.push({ driver: driver.name, driver_id: driver.driver_id, reasons, hr1_notified: hr1Notified, hr1_response });
    }
  }

  res.json({
    checked: drivers.length,
    newly_flagged: results.length,
    flagged: results,
  });
}
