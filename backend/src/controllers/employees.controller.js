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

// The availability panel uses employees.position as its only driver source.
// `driver_availability` remains a manual operational/safety override; it is
// never enough on its own to make an employee available.
const DRIVER_POSITION = 'Driver';
const DRIVER_CLOCK_IN_GRACE_MINUTES = Number(process.env.DRIVER_CLOCK_IN_GRACE_MINUTES || 20);

function getManilaNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, minutes: Number(value.hour) * 60 + Number(value.minute) };
}

function minutesSinceMidnight(time) {
  if (!time) return null;
  const [hours, minutes] = time.slice(0, 5).split(':').map(Number);
  return hours * 60 + minutes;
}

async function getDriverRoster(date) {
  const { data: drivers, error: driversError } = await supabase
    .from('employees').select('*').ilike('position', DRIVER_POSITION).order('name', { ascending: true });
  if (driversError) throw driversError;
  if (!drivers.length) return [];

  const ids = drivers.map(driver => driver.id);
  const [attendanceResult, shiftsResult, leaveResult, coverageResult, overrideResult] = await Promise.all([
    supabase.from('attendance').select('employee_id, status, clock_in, clock_out').eq('date', date).in('employee_id', ids),
    supabase.from('shift_assignments').select('employee_id, is_day_off, shift_templates:roles(name, start_time)').eq('date', date).in('employee_id', ids),
    supabase.from('leaves').select('employee_id').eq('status', 'approved').lte('start_date', date).gte('end_date', date).in('employee_id', ids),
    supabase.from('employee_reassignments').select('id, original_employee_id, replacement_employee_id, status, invalid_reason, created_at').eq('date', date).order('created_at', { ascending: false }),
    supabase.from('driver_availability_overrides').select('employee_id, availability, reason, expires_at').eq('date', date).in('employee_id', ids),
  ]);
  for (const result of [attendanceResult, shiftsResult, leaveResult, coverageResult, overrideResult]) if (result.error) throw result.error;

  const attendance = Object.fromEntries((attendanceResult.data || []).map(row => [row.employee_id, row]));
  const shifts = Object.fromEntries((shiftsResult.data || []).map(row => [row.employee_id, row]));
  const overrides = Object.fromEntries((overrideResult.data || []).filter(row => !row.expires_at || new Date(row.expires_at) > new Date()).map(row => [row.employee_id, row]));
  const onLeave = new Set((leaveResult.data || []).map(row => row.employee_id));
  const coverageByOriginal = new Map();
  const activeCoverage = (coverageResult.data || []).filter(row => row.status === 'active');
  for (const row of coverageResult.data || []) {
    if (!coverageByOriginal.has(row.original_employee_id)) coverageByOriginal.set(row.original_employee_id, row);
  }
  const covered = new Set(activeCoverage.map(row => row.original_employee_id));
  const covering = new Set(activeCoverage.map(row => row.replacement_employee_id));
  const employeesById = Object.fromEntries(drivers.map(driver => [driver.id, driver]));
  const now = getManilaNow();

  return drivers.map(employee => {
    const attendanceRecord = attendance[employee.id];
    const shift = shifts[employee.id];
    const shiftStart = shift?.shift_templates?.start_time || employee.shift_start;
    const deadline = minutesSinceMidnight(shiftStart) + DRIVER_CLOCK_IN_GRACE_MINUTES;
    const missedClockIn = date <= now.date && Boolean(shift && !shift.is_day_off) && !attendanceRecord?.clock_in && now.minutes >= deadline;
    const clockedInLate = Boolean(attendanceRecord?.clock_in) && date <= now.date && Boolean(shift && !shift.is_day_off) && minutesSinceMidnight(attendanceRecord.clock_in) > deadline;
    const override = overrides[employee.id];
    let effectiveAvailability = 'not_available';
    let availabilityReason = 'Not scheduled';

    if (employee.status !== 'active') availabilityReason = 'Inactive employee';
    else if (onLeave.has(employee.id)) availabilityReason = 'On approved leave';
    else if (attendanceRecord?.status === 'absent') availabilityReason = 'Absent';
    else if (!shift || shift.is_day_off) availabilityReason = 'Not scheduled';
    else if (override) availabilityReason = override.reason || 'Manual operational override';
    else if (covering.has(employee.id)) availabilityReason = 'Covering another driver';
    else if (attendanceRecord?.clock_out) availabilityReason = 'Clocked out';
    else if (missedClockIn) availabilityReason = `Missed clock-in deadline (${DRIVER_CLOCK_IN_GRACE_MINUTES} minutes)`;
    else if (clockedInLate) availabilityReason = `Clocked in after the ${DRIVER_CLOCK_IN_GRACE_MINUTES}-minute deadline`;
    else if (!attendanceRecord?.clock_in) availabilityReason = 'Not clocked in';
    else { effectiveAvailability = 'available'; availabilityReason = 'Clocked in and unassigned'; }

    const canCoverWithoutCoverage = employee.status === 'active' && Boolean(shift && !shift.is_day_off) && !onLeave.has(employee.id) && attendanceRecord?.status !== 'absent' && !override && Boolean(attendanceRecord?.clock_in) && !attendanceRecord?.clock_out && !clockedInLate;
    const coverage = coverageByOriginal.get(employee.id);
    const needsReplacement = effectiveAvailability !== 'available' && Boolean(shift && !shift.is_day_off) && !covered.has(employee.id) && (onLeave.has(employee.id) || attendanceRecord?.status === 'absent' || Boolean(override) || missedClockIn || clockedInLate);
    return { ...employee, attendance_status: attendanceRecord?.status || 'no_record', clock_in: attendanceRecord?.clock_in || null, shift_name: shift?.shift_templates?.name || null, shift_start: shiftStart || null, effective_availability: effectiveAvailability, availability_reason: availabilityReason, needs_replacement: needsReplacement, can_cover: effectiveAvailability === 'available', can_cover_without_coverage: canCoverWithoutCoverage, coverage_status: coverage?.status || null, coverage_invalid_reason: coverage?.invalid_reason || null, replacement_name: coverage ? employeesById[coverage.replacement_employee_id]?.name || 'Unknown driver' : null };
  });
}

// An active coverage record is valid only while its replacement remains able
// to work. Invalid records stay in history but no longer hide the original
// driver's need for a replacement.
export async function revalidateDriverCoverage(date = getManilaNow().date) {
  const roster = await getDriverRoster(date);
  const byId = Object.fromEntries(roster.map(driver => [driver.id, driver]));
  const { data: activeCoverage, error } = await supabase
    .from('employee_reassignments')
    .select('id, replacement_employee_id')
    .eq('date', date)
    .eq('status', 'active');
  if (error) throw error;

  const invalidated = [];
  for (const coverage of activeCoverage || []) {
    const replacement = byId[coverage.replacement_employee_id];
    if (replacement?.can_cover_without_coverage) continue;
    const reason = replacement?.availability_reason || 'Replacement is no longer a Driver role employee';
    const { data, error: updateError } = await supabase
      .from('employee_reassignments')
      .update({ status: 'invalid', invalid_reason: reason, invalidated_at: new Date().toISOString() })
      .eq('id', coverage.id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    if (updateError) throw updateError;
    if (data) invalidated.push({ coverage_id: data.id, reason });
  }
  return invalidated;
}

// GET full fleet-driver roster with today's computed status (for the availability panel)
export async function getFleetDrivers(req, res) {
  try {
    const date = req.query.date || getManilaNow().date;
    await revalidateDriverCoverage(date);
    return res.json(await getDriverRoster(date));
  } catch (error) {
    return handleError(res, error);
  }
}

// GET fleet-driver employees who need replacement today (absent OR manually unavailable) and don't yet have coverage
export async function getAbsentDrivers(req, res) {
  try {
    const date = req.query.date || getManilaNow().date;
    await revalidateDriverCoverage(date);
    const roster = await getDriverRoster(date);
    return res.json(roster.filter(driver => driver.needs_replacement));
  } catch (error) {
    return handleError(res, error);
  }
}

// GET fleet-driver employees available to cover a shift on a given date
// (clocked in — present/late — manually marked available, and not already assigned elsewhere that day)
export async function getAvailableDrivers(req, res) {
  try {
    const date = req.query.date || getManilaNow().date;
    await revalidateDriverCoverage(date);
    const roster = await getDriverRoster(date);
    return res.json(roster.filter(driver => driver.can_cover && driver.id !== req.query.exclude_employee_id));
  } catch (error) {
    return handleError(res, error);
  }
}

// PATCH manually set a fleet driver's availability (independent of attendance)
export async function setDriverAvailability(req, res) {
  const { availability, reason, date = getManilaNow().date, expires_at = null } = req.body;
  if (!['available', 'unavailable'].includes(availability)) {
    return res.status(400).json({ error: "availability must be 'available' or 'unavailable'" });
  }

  const { data: employee, error: empError } = await supabase
    .from('employees')
    .select('id, position')
    .eq('id', req.params.id)
    .single();
  if (empError || !employee) return res.status(404).json({ error: 'Employee not found' });
  if (employee.position?.toLowerCase() !== DRIVER_POSITION.toLowerCase()) return res.status(400).json({ error: 'Employee position must be Driver' });

  if (availability === 'available') {
    const { error } = await supabase.from('driver_availability_overrides').delete()
      .eq('employee_id', req.params.id).eq('date', date);
    if (error) return handleError(res, error);
    return res.json({ employee_id: req.params.id, date, availability: 'available' });
  }
  if (!reason?.trim()) return res.status(400).json({ error: 'reason is required when marking a driver unavailable' });

  const { data, error } = await supabase
    .from('driver_availability_overrides')
    .upsert([{ employee_id: req.params.id, date, availability, reason: reason.trim(), expires_at }], { onConflict: 'employee_id,date' })
    .select()
    .single();
  if (error) return handleError(res, error);

  // Optional audit trail alongside the manual toggle — reuses the reassignments
  // log's `reason` field pattern; only recorded when marking unavailable with a note.
  if (availability === 'unavailable' && reason) {
    console.log(`Driver ${employee.id} marked unavailable for ${date}: ${reason}`);
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

  let roster;
  try {
    roster = await getDriverRoster(date);
  } catch (error) {
    return handleError(res, error);
  }
  const originalState = roster.find(driver => driver.id === original_employee_id);
  const replacementState = roster.find(driver => driver.id === replacement_employee_id);
  if (!originalState) return res.status(404).json({ error: 'Original employee is not an active Driver role record' });
  // Manual override: a manager can assign coverage for ANY driver (not scheduled,
  // already available, before the clock-in deadline, etc.) — not just ones the
  // system's automatic rules flagged with needs_replacement. The replacement
  // driver must still be genuinely eligible to work, though.
  if (!replacementState?.can_cover) {
    return res.status(400).json({ error: `Replacement driver is not eligible: ${replacementState?.availability_reason || 'not a Driver role record'}` });
  }

  const { data: original, error: origError } = await supabase
    .from('employees')
    .select('*')
    .eq('id', original_employee_id)
    .ilike('position', DRIVER_POSITION)
    .single();
  if (origError || !original) return res.status(404).json({ error: 'Fleet driver not found' });

  const { data: replacement, error: replError } = await supabase
    .from('employees')
    .select('*')
    .eq('id', replacement_employee_id)
    .ilike('position', DRIVER_POSITION)
    .eq('status', 'active')
    .single();
  if (replError || !replacement) return res.status(404).json({ error: 'Replacement must be an active fleet driver currently marked available' });

  const { data: replAttendance } = await supabase
    .from('attendance')
    .select('status, clock_in')
    .eq('employee_id', replacement_employee_id)
    .eq('date', date)
    .maybeSingle();
  if (!replAttendance?.clock_in) {
    return res.status(400).json({ error: 'Replacement driver is not clocked in on this date' });
  }

  const { data: existingCoverage } = await supabase
    .from('employee_reassignments')
    .select('id')
    .eq('date', date)
    .eq('original_employee_id', original_employee_id)
    .eq('status', 'active')
    .maybeSingle();
  if (existingCoverage) return res.status(409).json({ error: 'This driver already has replacement coverage' });

  const { data, error } = await supabase
    .from('employee_reassignments')
    .insert([{ date, original_employee_id, replacement_employee_id, reason }])
    .select('*, original:original_employee_id(name, employee_id), replacement:replacement_employee_id(name, employee_id)')
    .single();
  if (error) return handleError(res, error);

  res.status(201).json(data);
}

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