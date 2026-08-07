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