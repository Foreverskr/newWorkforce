import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

export async function getAll(req, res) {
  const { employee_id, date, start_date, end_date, status } = req.query;

  let query = supabase
    .from('attendance')
    .select('*, employees(name, employee_id, department, position, shift_start, shift_end)')
    .order('date', { ascending: false })
    .order('clock_in', { ascending: false });

  if (employee_id) query = query.eq('employee_id', employee_id);
  if (date) query = query.eq('date', date);
  if (start_date) query = query.gte('date', start_date);
  if (end_date) query = query.lte('date', end_date);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return handleError(res, error);
  res.json(data);
}

export async function getToday(req, res) {
  const today = new Date().toISOString().split('T')[0];

  const { data: attendanceData, error: attendanceError } = await supabase
    .from('attendance')
    .select('*, employees(name, employee_id, department, shift_start, shift_end)')
    .eq('date', today);

  if (attendanceError) return handleError(res, attendanceError);

  const { data: totalEmployees, error: empError } = await supabase
    .from('employees')
    .select('id', { count: 'exact' })
    .eq('status', 'active');

  if (empError) return handleError(res, empError);

  const present = attendanceData.filter(r => r.status === 'present').length;
  const late = attendanceData.filter(r => r.status === 'late').length;
  const absent = (totalEmployees?.length || 0) - present - late;

  res.json({
    date: today,
    total_employees: totalEmployees?.length || 0,
    present,
    late,
    absent: absent < 0 ? 0 : absent,
    records: attendanceData,
  });
}

export async function clockIn(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = new Date().toISOString().split('T')[0];
  const now = new Date();
  const clockInTime = now.toTimeString().slice(0, 8);

  // Block clock-in if employee has an approved leave covering today
  const { data: activeLeave } = await supabase
    .from('leaves')
    .select('id, type, start_date, end_date')
    .eq('employee_id', employee_id)
    .eq('status', 'approved')
    .lte('start_date', today)
    .gte('end_date', today)
    .maybeSingle();

  if (activeLeave) {
    return res.status(403).json({
      error: `Employee is on approved ${activeLeave.type} leave today (${activeLeave.start_date} → ${activeLeave.end_date})`,
    });
  }

  // Block clock-in if the employee has no shift scheduled for today.
  // No row at all = admin hasn't rostered them for this date. A row with
  // is_day_off true = explicitly given the day off. Either way, only an
  // admin-assigned working shift (shift_template_id set, is_day_off false)
  // permits a clock-in — mirrors the roster semantics used across
  // getWorkingDaysInRange and the schedule routes.
  const { data: todaysShift } = await supabase
    .from('shift_assignments')
    .select('id, is_day_off, shift_template_id')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .maybeSingle();

  if (!todaysShift || todaysShift.is_day_off || !todaysShift.shift_template_id) {
    return res.status(403).json({
      error: 'No shift scheduled for today — contact your admin to get scheduled before clocking in.',
    });
  }

  // Check if already clocked in today
  const { data: existing } = await supabase
    .from('attendance')
    .select('id, clock_in, clock_out')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .single();

  if (existing?.clock_in) {
    return res.status(409).json({ error: 'Already clocked in today', record: existing });
  }

  // Get employee shift info to determine late status
  const { data: employee } = await supabase
    .from('employees')
    .select('shift_start')
    .eq('id', employee_id)
    .single();

  let status = 'present';
  if (employee?.shift_start) {
    const [shiftH, shiftM] = employee.shift_start.split(':').map(Number);
    const shiftDate = new Date(now);
    shiftDate.setHours(shiftH, shiftM + 15, 0); // 15 min grace period
    if (now > shiftDate) status = 'late';
  }

  const { data, error } = await supabase
    .from('attendance')
    .upsert(
      [{ employee_id, date: today, clock_in: clockInTime, clock_out: null, hours_worked: null, status, notes: null }],
      { onConflict: 'employee_id,date' }
    )
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return handleError(res, error);
  res.status(201).json(data);
}

export async function clockOut(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = new Date().toISOString().split('T')[0];
  const clockOutTime = new Date().toTimeString().slice(0, 8);

  const { data: record } = await supabase
    .from('attendance')
    .select('id, clock_in, clock_out, lunch_start, lunch_end, coffee_start, coffee_end')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .single();

  if (!record) return res.status(404).json({ error: 'No clock-in record found for today' });
  if (record.clock_out) return res.status(409).json({ error: 'Already clocked out today' });

  // Block if currently on a break
  if (record.lunch_start && !record.lunch_end)
    return res.status(409).json({ error: 'Employee is currently on lunch break — end break first' });
  if (record.coffee_start && !record.coffee_end)
    return res.status(409).json({ error: 'Employee is currently on coffee break — end break first' });

  // Calculate gross hours
  const clockIn  = new Date(`${today}T${record.clock_in}`);
  const clockOut = new Date(`${today}T${clockOutTime}`);
  const grossMinutes = (clockOut - clockIn) / 60000;

  // Calculate actual break minutes taken
  let breakMinutes = 0;
  if (record.lunch_start && record.lunch_end) {
    const ls = new Date(`${today}T${record.lunch_start}`);
    const le = new Date(`${today}T${record.lunch_end}`);
    breakMinutes += Math.round((le - ls) / 60000);
  }
  if (record.coffee_start && record.coffee_end) {
    const cs = new Date(`${today}T${record.coffee_start}`);
    const ce = new Date(`${today}T${record.coffee_end}`);
    breakMinutes += Math.round((ce - cs) / 60000);
  }

  const netMinutes   = grossMinutes - breakMinutes;
  const hoursWorked  = parseFloat((grossMinutes / 60).toFixed(2));
  const netHours     = parseFloat((netMinutes   / 60).toFixed(2));

  const { data, error } = await supabase
    .from('attendance')
    .update({
      clock_out:        clockOutTime,
      hours_worked:     hoursWorked,
      break_minutes:    breakMinutes,
      net_hours_worked: netHours,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', record.id)
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return handleError(res, error);
  res.json(data);
}

// ─── BREAKS ──────────────────────────────────────────────────────────────────

// POST — called by break room RFID scanner on entry
export async function breakStart(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toTimeString().slice(0, 8);

  const { data: record } = await supabase
    .from('attendance')
    .select('id, clock_in, clock_out, lunch_start, lunch_end, coffee_start, coffee_end')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .maybeSingle();

  if (!record?.clock_in)  return res.status(404).json({ error: 'Employee has not clocked in today' });
  if (record.clock_out)   return res.status(409).json({ error: 'Employee has already clocked out' });

  // Already on a break?
  if (record.lunch_start  && !record.lunch_end)  return res.status(409).json({ error: 'Already on lunch break' });
  if (record.coffee_start && !record.coffee_end) return res.status(409).json({ error: 'Already on coffee break' });

  // Decide which break to assign:
  // lunch first if not yet taken, then coffee, else no breaks left
  let breakType = null;
  let updatePayload = {};

  if (!record.lunch_start) {
    breakType = 'lunch';
    updatePayload = { lunch_start: now };
  } else if (!record.coffee_start) {
    breakType = 'coffee';
    updatePayload = { coffee_start: now };
  } else {
    return res.status(409).json({ error: 'All breaks already used for today' });
  }

  const { data, error } = await supabase
    .from('attendance')
    .update({ ...updatePayload, updated_at: new Date().toISOString() })
    .eq('id', record.id)
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return handleError(res, error);
  res.json({ breakType, record: data });
}

// POST — called by break room RFID scanner on exit
export async function breakEnd(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = new Date().toISOString().split('T')[0];
  const now   = new Date().toTimeString().slice(0, 8);

  const { data: record } = await supabase
    .from('attendance')
    .select('id, clock_in, clock_out, lunch_start, lunch_end, coffee_start, coffee_end')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .maybeSingle();

  if (!record?.clock_in) return res.status(404).json({ error: 'Employee has not clocked in today' });
  if (record.clock_out)  return res.status(409).json({ error: 'Employee has already clocked out' });

  let breakType = null;
  let updatePayload = {};

  if (record.lunch_start && !record.lunch_end) {
    breakType = 'lunch';
    updatePayload = { lunch_end: now };
  } else if (record.coffee_start && !record.coffee_end) {
    breakType = 'coffee';
    updatePayload = { coffee_end: now };
  } else {
    return res.status(409).json({ error: 'No active break to end' });
  }

  const { data, error } = await supabase
    .from('attendance')
    .update({ ...updatePayload, updated_at: new Date().toISOString() })
    .eq('id', record.id)
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return handleError(res, error);
  res.json({ breakType, record: data });
}

// POST manual attendance (admin)
export async function create(req, res) {
  const { employee_id, date, clock_in, clock_out, status, notes } = req.body;
  if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

  let hoursWorked = null;
  if (clock_in && clock_out) {
    const ci = new Date(`${date}T${clock_in}`);
    const co = new Date(`${date}T${clock_out}`);
    hoursWorked = parseFloat(((co - ci) / 3600000).toFixed(2));
  }

  const { data, error } = await supabase
    .from('attendance')
    .upsert([{ employee_id, date, clock_in, clock_out, status: status || 'present', notes, hours_worked: hoursWorked }], { onConflict: 'employee_id,date' })
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return handleError(res, error);
  res.status(201).json(data);
}

// POST bulk import (from Excel/Google Sheets upload, parsed client-side)
// Expects: { records: [{ employee_id, date, clock_in, clock_out, status, notes }, ...] }
// employee_id here must already be resolved to the internal employees.id UUID —
// resolution from a human-readable code/name happens in the frontend before this is called.
export async function bulkImport(req, res) {
  const { records } = req.body;

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required' });
  }

  const invalid = records.findIndex(r => !r.employee_id || !r.date);
  if (invalid !== -1) {
    return res.status(400).json({ error: `Row ${invalid + 1} is missing employee_id or date` });
  }

  const rows = records.map(r => {
    let hoursWorked = null;
    if (r.clock_in && r.clock_out) {
      const ci = new Date(`${r.date}T${r.clock_in}`);
      const co = new Date(`${r.date}T${r.clock_out}`);
      if (!isNaN(ci) && !isNaN(co)) hoursWorked = parseFloat(((co - ci) / 3600000).toFixed(2));
    }
    return {
      employee_id: r.employee_id,
      date: r.date,
      clock_in: r.clock_in || null,
      clock_out: r.clock_out || null,
      status: r.status || 'present',
      notes: r.notes || null,
      hours_worked: hoursWorked,
    };
  });

  const { data, error } = await supabase
    .from('attendance')
    .upsert(rows, { onConflict: 'employee_id,date' })
    .select('*, employees(name, employee_id, department)');

  if (error) return handleError(res, error);
  res.status(201).json({ imported: data.length, records: data });
}

export async function remove(req, res) {
  const { error } = await supabase.from('attendance').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Record deleted' });
}

// ─── DEVICE KIOSK (fingerprint, no buttons) ─────────────────────────────────
// POST — called by the fingerprint kiosk after it resolves a scan to an
// employee_id via /fingerprints/identify. No human input beyond placing a
// finger, so THIS function decides clock-in vs clock-out automatically by
// checking today's existing record. Reuses the same leave/schedule rules as
// clockIn, and the same hours/break math as clockOut.
export async function punch(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = new Date().toISOString().split('T')[0];
  const now = new Date();

  const { data: record } = await supabase
    .from('attendance')
    .select('id, clock_in, clock_out, lunch_start, lunch_end, coffee_start, coffee_end')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .maybeSingle();

  // Already completed today — nothing to do
  if (record?.clock_in && record?.clock_out) {
    return res.status(409).json({
      action: 'already_done',
      error: 'Already clocked in and out today',
      record,
    });
  }

  // ── CLOCK OUT branch ──────────────────────────────────────────────
  if (record?.clock_in && !record?.clock_out) {
    if (record.lunch_start && !record.lunch_end) {
      return res.status(409).json({ error: 'Employee is currently on lunch break' });
    }
    if (record.coffee_start && !record.coffee_end) {
      return res.status(409).json({ error: 'Employee is currently on coffee break' });
    }

    const clockOutTime = now.toTimeString().slice(0, 8);
    const clockIn  = new Date(`${today}T${record.clock_in}`);
    const clockOut = new Date(`${today}T${clockOutTime}`);
    const grossMinutes = (clockOut - clockIn) / 60000;

    let breakMinutes = 0;
    if (record.lunch_start && record.lunch_end) {
      breakMinutes += Math.round(
        (new Date(`${today}T${record.lunch_end}`) - new Date(`${today}T${record.lunch_start}`)) / 60000
      );
    }
    if (record.coffee_start && record.coffee_end) {
      breakMinutes += Math.round(
        (new Date(`${today}T${record.coffee_end}`) - new Date(`${today}T${record.coffee_start}`)) / 60000
      );
    }

    const netMinutes  = grossMinutes - breakMinutes;
    const hoursWorked = parseFloat((grossMinutes / 60).toFixed(2));
    const netHours    = parseFloat((netMinutes / 60).toFixed(2));

    const { data, error } = await supabase
      .from('attendance')
      .update({
        clock_out: clockOutTime,
        hours_worked: hoursWorked,
        break_minutes: breakMinutes,
        net_hours_worked: netHours,
        updated_at: new Date().toISOString(),
      })
      .eq('id', record.id)
      .select('*, employees(name, employee_id, department)')
      .single();

    if (error) return handleError(res, error);
    return res.json({ action: 'clock_out', ...data });
  }

  // ── CLOCK IN branch ───────────────────────────────────────────────
  const { data: activeLeave } = await supabase
    .from('leaves')
    .select('id, type, start_date, end_date')
    .eq('employee_id', employee_id)
    .eq('status', 'approved')
    .lte('start_date', today)
    .gte('end_date', today)
    .maybeSingle();

  if (activeLeave) {
    return res.status(403).json({
      error: `Employee is on approved ${activeLeave.type} leave today (${activeLeave.start_date} → ${activeLeave.end_date})`,
    });
  }

  const { data: todaysShift } = await supabase
    .from('shift_assignments')
    .select('id, is_day_off, shift_template_id')
    .eq('employee_id', employee_id)
    .eq('date', today)
    .maybeSingle();

  if (!todaysShift || todaysShift.is_day_off || !todaysShift.shift_template_id) {
    return res.status(403).json({
      error: 'No shift scheduled for today',
    });
  }

  const { data: employee } = await supabase
    .from('employees')
    .select('shift_start')
    .eq('id', employee_id)
    .single();

  let status = 'present';
  if (employee?.shift_start) {
    const [shiftH, shiftM] = employee.shift_start.split(':').map(Number);
    const shiftDate = new Date(now);
    shiftDate.setHours(shiftH, shiftM + 15, 0); // 15 min grace period
    if (now > shiftDate) status = 'late';
  }

  const clockInTime = now.toTimeString().slice(0, 8);

  const { data, error } = await supabase
    .from('attendance')
    .upsert(
      [{ employee_id, date: today, clock_in: clockInTime, clock_out: null, hours_worked: null, status, notes: null }],
      { onConflict: 'employee_id,date' }
    )
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return handleError(res, error);
  return res.status(201).json({ action: 'clock_in', ...data });
}


// ─────────────────────────────────────────────────────────────────────────
// ADD to controllers/fingerprints.controller.js
// ─────────────────────────────────────────────────────────────────────────

// GET /api/device/fingerprints/pending-sync?device_id=kiosk-front-door-01
// Called by the attendance kiosk (e.g. on boot, or on a timer) to ask:
// "which enrolled employees do I not have a local template for yet?"
export async function pendingSync(req, res) {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });

  // All enrolled fingerprints that HAVE template bytes saved (i.e. came from
  // a device that successfully extracted them), grouped by employee.
  const { data: allEnrolled, error } = await supabase
    .from('employee_fingerprints')
    .select('employee_id, slot_label, device_id, template_data, employees(name)')
    .not('template_data', 'is', null);

  if (error) return handleError(res, error);

  // Group by employee_id + slot_label so we know, per (employee, slot),
  // which device_ids already have it.
  const bySlot = {};
  for (const row of allEnrolled) {
    const key = `${row.employee_id}:${row.slot_label}`;
    if (!bySlot[key]) bySlot[key] = { employee_id: row.employee_id, slot_label: row.slot_label, name: row.employees.name, template_data: row.template_data, devices: [] };
    bySlot[key].devices.push(row.device_id);
  }

  // Anything this device_id isn't already in the devices list for = pending
  const pending = Object.values(bySlot)
    .filter(entry => !entry.devices.includes(device_id))
    .map(({ employee_id, slot_label, name, template_data }) => ({ employee_id, slot_label, name, template_data }));

  res.json({ device_id, pending });
}

// POST /api/device/fingerprints/register-synced
// body: { employee_id, slot_label, device_id, sensor_slot_id }
// Called by the attendance kiosk AFTER it has successfully written a synced
// template into its own sensor's local memory at sensor_slot_id.
export async function registerSynced(req, res) {
  const { employee_id, slot_label, device_id, sensor_slot_id } = req.body;

  if (!employee_id || !slot_label || !device_id || sensor_slot_id === undefined) {
    return res.status(400).json({ error: 'employee_id, slot_label, device_id, sensor_slot_id are required' });
  }

  // Copy the template_data forward too, so THIS device could itself act as
  // a source for a third device down the line if you ever add one.
  const { data: source } = await supabase
    .from('employee_fingerprints')
    .select('template_data')
    .eq('employee_id', employee_id)
    .eq('slot_label', slot_label)
    .not('template_data', 'is', null)
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from('employee_fingerprints')
    .insert([{
      employee_id,
      slot_label,
      device_id,
      sensor_slot_id,
      template_data: source?.template_data || null,
    }])
    .select()
    .single();

  if (error) return handleError(res, error);
  res.status(201).json(data);
}