import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';
import { countWorkingDaysBetween } from '../utils/dateHelpers.js';
import { sendInactivityEmail } from '../utils/mailer.js';

// ─── EMPLOYEE ATTENDANCE INACTIVITY ─────────────────────────────────────────
// Flags active employees who have gone INACTIVITY_ATTENDANCE_DAYS_THRESHOLD
// consecutive *working* days with no attendance record at all. Approved leave
// already auto-inserts an 'absent' attendance row (see PATCH /leaves/:id/status),
// so an employee correctly on leave is NOT flagged — only a genuine gap with
// zero records (no clock-in, no leave, nothing logged) counts.
//
// Mirrors the /api/drivers/check-inactivity pattern in drivers.controller.js:
// manually triggered, not a cron job. Re-running skips employees already
// status='inactive' so it won't re-flag/re-log every call.
const INACTIVITY_ATTENDANCE_DAYS_THRESHOLD = 7;

export async function getAll(req, res) {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return handleError(res, error);
  res.json(data);
}

export async function getInactivityLogs(req, res) {
  const { data, error } = await supabase
    .from('employee_inactivity_logs')
    .select('*, employees(name, employee_id, department)')
    .order('detected_at', { ascending: false })
    .limit(100);
  if (error) return handleError(res, error);
  res.json(data);
}

// Scans active employees for a 7+ working-day attendance gap. For each newly
// flagged employee: marks status='inactive', stores a readable notice on
// employees.inactivity_reason, and logs the event.
export async function checkInactivity(req, res) {
  const { data: employees, error } = await supabase
    .from('employees')
    .select('id, name, employee_id, email, status')
    .eq('status', 'active');
  if (error) return handleError(res, error);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results = [];

  for (const employee of employees) {
    const { data: lastRecord, error: recError } = await supabase
      .from('attendance')
      .select('date')
      .eq('employee_id', employee.id)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recError) continue;

    const lastAttendanceDate = lastRecord?.date || null;
    const daysSinceAttendance = lastAttendanceDate
      ? countWorkingDaysBetween(new Date(lastAttendanceDate), today)
      : Infinity;

    if (daysSinceAttendance >= INACTIVITY_ATTENDANCE_DAYS_THRESHOLD) {
      const message = lastAttendanceDate
        ? `${employee.name} has not clocked in for ${daysSinceAttendance} consecutive working days (last attendance: ${lastAttendanceDate}).`
        : `${employee.name} has no attendance records on file at all.`;

      const { error: updateError } = await supabase
        .from('employees')
        .update({ status: 'inactive', inactivity_reason: message, updated_at: new Date().toISOString() })
        .eq('id', employee.id);

      if (updateError) {
        // Don't report success if the write actually failed (e.g. inactivity_reason
        // column missing because the migration hasn't been run yet).
        console.error(`Failed to flag employee ${employee.id} inactive:`, updateError.message);
        continue;
      }

      await supabase.from('employee_inactivity_logs').insert([{
        employee_id: employee.id,
        reason: 'no_attendance',
        details: {
          last_attendance_date: lastAttendanceDate,
          days_since_attendance: daysSinceAttendance === Infinity ? null : daysSinceAttendance,
        },
      }]);

      // 🟢 NOTIFY: email the employee at the moment they're newly flagged.
      // Never let a mail failure block the rest of the scan — sendInactivityEmail
      // swallows its own errors and just reports { sent: false }.
      const { sent: emailSent } = await sendInactivityEmail(employee, {
        daysSinceAttendance: daysSinceAttendance === Infinity ? null : daysSinceAttendance,
        lastAttendanceDate,
      });

      results.push({
        employee_id: employee.employee_id,
        name: employee.name,
        last_attendance_date: lastAttendanceDate,
        days_since_attendance: daysSinceAttendance === Infinity ? null : daysSinceAttendance,
        message,
        email_sent: emailSent,
      });
    }
  }

  res.json({ checked: employees.length, newly_flagged: results.length, flagged: results });
}

// POST manually (re)send the inactivity notification email for an employee
// already sitting inactive — e.g. flagged by a previous checkInactivity run,
// which only emails at the moment of flagging and won't re-email on later
// scans. Meant for a per-row "notify" action in Employee Management.
export async function notifyInactive(req, res) {
  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, name, email, status, inactivity_reason')
    .eq('id', req.params.id)
    .single();
  if (error || !employee) return res.status(404).json({ error: 'Employee not found' });

  if (employee.status !== 'inactive') {
    return res.status(400).json({ error: 'Employee is not currently marked inactive' });
  }

  // Pull the structured day-count/date from this employee's most recent
  // inactivity log (populated by checkInactivity) so the resend uses the
  // same template fields, rather than re-parsing the free-text reason.
  const { data: log } = await supabase
    .from('employee_inactivity_logs')
    .select('details')
    .eq('employee_id', employee.id)
    .order('detected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const details = log?.details || {};

  const { sent, reason } = await sendInactivityEmail(employee, {
    daysSinceAttendance: details.days_since_attendance,
    lastAttendanceDate: details.last_attendance_date,
  });

  if (!sent) {
    return res.status(502).json({ error: `Failed to send notification email: ${reason || 'unknown error'}` });
  }

  res.json({ message: 'Notification email sent', employee_id: employee.id, email: employee.email });
}

// ─── FLEET DRIVER REASSIGNMENT ───────────────────────────────────────────────
// Fleet drivers are employees with is_fleet_driver = true. This is entirely
// separate from the external `drivers` table (drivers.controller.js), which
// just tracks third-party drivers' license/trip status. Fleet drivers clock
// in/out and take leave like any employee.
//
// A driver needs replacement if EITHER is true:
//   - attendance.status === 'absent' for today
//   - driver_availability === 'unavailable' (manual override, e.g. vehicle
//     issue, called out before clocking in, pulled for another task)
// A driver is available to cover a shift only if BOTH are true:
//   - clocked in today (attendance present/late)
//   - driver_availability === 'available'

// GET full fleet-driver roster with today's computed status (for the availability panel)
export async function getFleetDrivers(req, res) {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const { data: fleetDrivers, error: empError } = await supabase
    .from('employees')
    .select('*')
    .eq('is_fleet_driver', true)
    .order('name', { ascending: true });
  if (empError) return handleError(res, empError);

  const ids = fleetDrivers.map(e => e.id);
  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('employee_id, status')
    .eq('date', date)
    .in('employee_id', ids);
  if (attError) return handleError(res, attError);
  const attMap = Object.fromEntries(attendance.map(a => [a.employee_id, a.status]));

  const { data: reassignments } = await supabase
    .from('employee_reassignments')
    .select('original_employee_id, replacement_employee_id')
    .eq('date', date);
  const coveredIds = new Set((reassignments || []).map(r => r.original_employee_id));
  const assignedElsewhereIds = new Set((reassignments || []).map(r => r.replacement_employee_id));

  const roster = fleetDrivers.map(e => {
    const attendanceStatus = attMap[e.id] || 'no_record';
    const needsReplacement = (attendanceStatus === 'absent' || e.driver_availability === 'unavailable') && !coveredIds.has(e.id);
    const canCover = e.status === 'active'
      && e.driver_availability === 'available'
      && ['present', 'late'].includes(attendanceStatus)
      && !assignedElsewhereIds.has(e.id);

    // Effective availability for display — clocking in is a prerequisite.
    // A driver manually flagged 'available' who hasn't clocked in yet is
    // NOT available; they just haven't checked in for the day.
    let effectiveAvailability;
    if (attendanceStatus === 'absent') effectiveAvailability = 'absent';
    else if (!['present', 'late'].includes(attendanceStatus)) effectiveAvailability = 'not_clocked_in';
    else if (e.driver_availability === 'unavailable') effectiveAvailability = 'unavailable';
    else effectiveAvailability = 'available';

    return {
      ...e,
      attendance_status: attendanceStatus,
      effective_availability: effectiveAvailability,
      needs_replacement: needsReplacement,
      can_cover: canCover,
    };
  });

  res.json(roster);
}

// GET fleet-driver employees who need replacement today (absent OR manually unavailable) and don't yet have coverage
export async function getAbsentDrivers(req, res) {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const { data: fleetDrivers, error: empError } = await supabase
    .from('employees')
    .select('*')
    .eq('is_fleet_driver', true);
  if (empError) return handleError(res, empError);

  const ids = fleetDrivers.map(e => e.id);
  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('employee_id, status')
    .eq('date', date)
    .in('employee_id', ids);
  if (attError) return handleError(res, attError);

  const attMap = Object.fromEntries(attendance.map(a => [a.employee_id, a.status]));

  const { data: existing } = await supabase
    .from('employee_reassignments')
    .select('original_employee_id')
    .eq('date', date);
  const coveredIds = new Set((existing || []).map(r => r.original_employee_id));

  const needsReplacement = fleetDrivers.filter(e =>
    (attMap[e.id] === 'absent' || e.driver_availability === 'unavailable') && !coveredIds.has(e.id)
  );
  res.json(needsReplacement);
}

// GET fleet-driver employees available to cover a shift on a given date
// (clocked in — present/late — manually marked available, and not already assigned elsewhere that day)
export async function getAvailableDrivers(req, res) {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const excludeId = req.query.exclude_employee_id || null;

  const { data: fleetDrivers, error: empError } = await supabase
    .from('employees')
    .select('*')
    .eq('is_fleet_driver', true)
    .eq('status', 'active')
    .eq('driver_availability', 'available');
  if (empError) return handleError(res, empError);

  const ids = fleetDrivers.map(e => e.id);
  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('employee_id, status')
    .eq('date', date)
    .in('employee_id', ids);
  if (attError) return handleError(res, attError);

  const attMap = Object.fromEntries(attendance.map(a => [a.employee_id, a.status]));

  const { data: existing } = await supabase
    .from('employee_reassignments')
    .select('replacement_employee_id')
    .eq('date', date);
  const alreadyAssigned = new Set((existing || []).map(r => r.replacement_employee_id));

  const available = fleetDrivers.filter(e => {
    if (excludeId && e.id === excludeId) return false;
    if (alreadyAssigned.has(e.id)) return false;
    const status = attMap[e.id];
    return status === 'present' || status === 'late';
  });

  res.json(available);
}

// PATCH manually set a fleet driver's availability (independent of attendance)
export async function setDriverAvailability(req, res) {
  const { availability, reason } = req.body;
  if (!['available', 'unavailable'].includes(availability)) {
    return res.status(400).json({ error: "availability must be 'available' or 'unavailable'" });
  }

  const { data: employee, error: empError } = await supabase
    .from('employees')
    .select('id, is_fleet_driver')
    .eq('id', req.params.id)
    .single();
  if (empError || !employee) return res.status(404).json({ error: 'Employee not found' });
  if (!employee.is_fleet_driver) return res.status(400).json({ error: 'Employee is not flagged as a fleet driver' });

  const { data, error } = await supabase
    .from('employees')
    .update({ driver_availability: availability, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return handleError(res, error);

  // Optional audit trail alongside the manual toggle — reuses the reassignments
  // log's `reason` field pattern; only recorded when marking unavailable with a note.
  if (availability === 'unavailable' && reason) {
    console.log(`Driver ${data.name} marked unavailable: ${reason}`);
  }

  res.json(data);
}

// GET reassignment history (optionally filtered by date)
export async function getReassignments(req, res) {
  const { date } = req.query;
  let query = supabase
    .from('employee_reassignments')
    .select('*, original:original_employee_id(name, employee_id), replacement:replacement_employee_id(name, employee_id)')
    .order('created_at', { ascending: false });
  if (date) query = query.eq('date', date);

  const { data, error } = await query;
  if (error) return handleError(res, error);
  res.json(data);
}

// POST assign an available fleet driver to cover an absent one's shift
export async function reassignDriver(req, res) {
  const { date, original_employee_id, replacement_employee_id, reason } = req.body;
  if (!date || !original_employee_id || !replacement_employee_id) {
    return res.status(400).json({ error: 'date, original_employee_id, and replacement_employee_id are required' });
  }
  if (original_employee_id === replacement_employee_id) {
    return res.status(400).json({ error: 'Replacement must be a different employee' });
  }

  const { data: original, error: origError } = await supabase
    .from('employees')
    .select('*')
    .eq('id', original_employee_id)
    .eq('is_fleet_driver', true)
    .single();
  if (origError || !original) return res.status(404).json({ error: 'Fleet driver not found' });

  const { data: origAttendance } = await supabase
    .from('attendance')
    .select('status')
    .eq('employee_id', original_employee_id)
    .eq('date', date)
    .maybeSingle();
  const originalNeedsReplacement = origAttendance?.status === 'absent' || original.driver_availability === 'unavailable';
  if (!originalNeedsReplacement) {
    return res.status(400).json({ error: 'This driver is not marked absent or unavailable on this date' });
  }

  const { data: replacement, error: replError } = await supabase
    .from('employees')
    .select('*')
    .eq('id', replacement_employee_id)
    .eq('is_fleet_driver', true)
    .eq('status', 'active')
    .eq('driver_availability', 'available')
    .single();
  if (replError || !replacement) return res.status(404).json({ error: 'Replacement must be an active fleet driver currently marked available' });

  const { data: replAttendance } = await supabase
    .from('attendance')
    .select('status')
    .eq('employee_id', replacement_employee_id)
    .eq('date', date)
    .maybeSingle();
  if (!['present', 'late'].includes(replAttendance?.status)) {
    return res.status(400).json({ error: 'Replacement driver is not clocked in on this date' });
  }

  const { data, error } = await supabase
    .from('employee_reassignments')
    .insert([{ date, original_employee_id, replacement_employee_id, reason }])
    .select('*, original:original_employee_id(name, employee_id), replacement:replacement_employee_id(name, employee_id)')
    .single();
  if (error) return handleError(res, error);

  res.status(201).json(data);
}

// DELETE / undo a reassignment
export async function deleteReassignment(req, res) {
  const { error } = await supabase.from('employee_reassignments').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Reassignment removed' });
}

// ─── PLAIN CRUD (UPDATED FOR TEXT POSITION) ─────────────────────────────────

export async function getOne(req, res) {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Employee not found' });
  res.json(data);
}

export async function create(req, res) {
  const { name, email, department, position, employee_id, shift_start, shift_end, is_fleet_driver } = req.body;
  if (!name || !email || !employee_id) {
    return res.status(400).json({ error: 'name, email, and employee_id are required' });
  }

  // 🟢 AUTO-ADD POSITION TO POSITIONS TABLE IF IT DOESN'T EXIST
  if (position) {
    await supabase
      .from('positions')
      .upsert([{ name: position }], { onConflict: 'name' });
  }

  const { data, error } = await supabase
    .from('employees')
    .insert([{ name, email, department, position, employee_id, shift_start: shift_start || '09:00', shift_end: shift_end || '18:00', status: 'active', is_fleet_driver: Boolean(is_fleet_driver) }])
    .select()
    .single();
  if (error) {
    // 🟢 Friendlier message for the unique-email constraint instead of the raw
    // Postgres "duplicate key value violates unique constraint" text.
    if (error.code === '23505' && error.message?.includes('email')) {
      return res.status(409).json({ error: `The email "${email}" is already used by another employee.` });
    }
    return handleError(res, error);
  }
  res.status(201).json(data);
}

export async function update(req, res) {
  const { name, email, department, position, shift_start, shift_end, status, is_fleet_driver } = req.body;

  // 🟢 AUTO-ADD POSITION TO POSITIONS TABLE IF IT DOESN'T EXIST
  if (position) {
    await supabase
      .from('positions')
      .upsert([{ name: position }], { onConflict: 'name' });
  }

  const { data, error } = await supabase
    .from('employees')
    .update({ 
      name, 
      email, 
      department, 
      position, 
      shift_start, 
      shift_end, 
      status, 
      is_fleet_driver: Boolean(is_fleet_driver), 
      updated_at: new Date().toISOString() 
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    if (error.code === '23505' && error.message?.includes('email')) {
      return res.status(409).json({ error: `The email "${email}" is already used by another employee.` });
    }
    return handleError(res, error);
  }
  res.json(data);
}
export async function remove(req, res) {
  const { error } = await supabase
    .from('employees')
    .delete()
    .eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Employee deleted' });
}