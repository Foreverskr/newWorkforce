import bcrypt from 'bcrypt';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { supabase } from './supabase.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());


// ─── AUTH ─────────────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
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
});

// POST /api/auth/hash  ← helper to generate a bcrypt hash (remove in production!)
app.post('/api/auth/hash', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const hash = await bcrypt.hash(password, 10);
  res.json({ hash });
});


// ─── EMPLOYEES ────────────────────────────────────────────────────────────────

// GET all employees
app.get('/api/employees', async (req, res) => {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── EMPLOYEE ATTENDANCE INACTIVITY ─────────────────────────────────────────
// Flags active employees who have gone INACTIVITY_ATTENDANCE_DAYS_THRESHOLD
// consecutive *working* days with no attendance record at all. Approved leave
// already auto-inserts an 'absent' attendance row (see PATCH /leaves/:id/status),
// so an employee correctly on leave is NOT flagged — only a genuine gap with
// zero records (no clock-in, no leave, nothing logged) counts.
//
// Mirrors the /api/drivers/check-inactivity pattern below: manually triggered,
// not a cron job. Re-running skips employees already status='inactive' so it
// won't re-flag/re-log every call.
//
// NOTE: these literal routes must stay registered before GET /api/employees/:id
// further down, or Express will treat "check-inactivity" etc. as an :id value.

const INACTIVITY_ATTENDANCE_DAYS_THRESHOLD = 7;

function countWorkingDaysBetween(fromDateExclusive, toDateExclusive) {
  let count = 0;
  const cur = new Date(fromDateExclusive);
  cur.setDate(cur.getDate() + 1);
  while (cur < toDateExclusive) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// GET audit history of employees flagged for no attendance
app.get('/api/employees/inactivity-logs', async (req, res) => {
  const { data, error } = await supabase
    .from('employee_inactivity_logs')
    .select('*, employees(name, employee_id, department)')
    .order('detected_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/employees/check-inactivity
// Scans active employees for a 7+ working-day attendance gap. For each newly
// flagged employee: marks status='inactive', stores a readable notice on
// employees.inactivity_reason, and logs the event.
app.post('/api/employees/check-inactivity', async (req, res) => {
  const { data: employees, error } = await supabase
    .from('employees')
    .select('id, name, employee_id, status')
    .eq('status', 'active');
  if (error) return res.status(500).json({ error: error.message });

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

      results.push({
        employee_id: employee.employee_id,
        name: employee.name,
        last_attendance_date: lastAttendanceDate,
        days_since_attendance: daysSinceAttendance === Infinity ? null : daysSinceAttendance,
        message,
      });
    }
  }

  res.json({ checked: employees.length, newly_flagged: results.length, flagged: results });
});

// ─── FLEET DRIVER REASSIGNMENT ───────────────────────────────────────────────
// Fleet drivers are employees with is_fleet_driver = true. This is entirely
// separate from the external `drivers` table further down, which just tracks
// third-party drivers' license/trip status. Fleet drivers clock in/out and
// take leave like any employee.
//
// A driver needs replacement if EITHER is true:
//   - attendance.status === 'absent' for today
//   - driver_availability === 'unavailable' (manual override, e.g. vehicle
//     issue, called out before clocking in, pulled for another task)
// A driver is available to cover a shift only if BOTH are true:
//   - clocked in today (attendance present/late)
//   - driver_availability === 'available'
//
// NOTE: these literal routes must stay registered before GET /api/employees/:id
// below, or Express will treat "absent-drivers" etc. as an :id value.

// GET full fleet-driver roster with today's computed status (for the availability panel)
app.get('/api/employees/fleet-drivers', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const { data: fleetDrivers, error: empError } = await supabase
    .from('employees')
    .select('*')
    .eq('is_fleet_driver', true)
    .order('name', { ascending: true });
  if (empError) return res.status(500).json({ error: empError.message });

  const ids = fleetDrivers.map(e => e.id);
  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('employee_id, status')
    .eq('date', date)
    .in('employee_id', ids);
  if (attError) return res.status(500).json({ error: attError.message });
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
});

// GET fleet-driver employees who need replacement today (absent OR manually unavailable) and don't yet have coverage
app.get('/api/employees/absent-drivers', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const { data: fleetDrivers, error: empError } = await supabase
    .from('employees')
    .select('*')
    .eq('is_fleet_driver', true);
  if (empError) return res.status(500).json({ error: empError.message });

  const ids = fleetDrivers.map(e => e.id);
  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('employee_id, status')
    .eq('date', date)
    .in('employee_id', ids);
  if (attError) return res.status(500).json({ error: attError.message });

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
});

// GET fleet-driver employees available to cover a shift on a given date
// (clocked in — present/late — manually marked available, and not already assigned elsewhere that day)
app.get('/api/employees/available-drivers', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const excludeId = req.query.exclude_employee_id || null;

  const { data: fleetDrivers, error: empError } = await supabase
    .from('employees')
    .select('*')
    .eq('is_fleet_driver', true)
    .eq('status', 'active')
    .eq('driver_availability', 'available');
  if (empError) return res.status(500).json({ error: empError.message });

  const ids = fleetDrivers.map(e => e.id);
  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('employee_id, status')
    .eq('date', date)
    .in('employee_id', ids);
  if (attError) return res.status(500).json({ error: attError.message });

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
});

// PATCH manually set a fleet driver's availability (independent of attendance)
app.patch('/api/employees/:id/driver-availability', async (req, res) => {
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
  if (error) return res.status(500).json({ error: error.message });

  // Optional audit trail alongside the manual toggle — reuses the reassignments
  // log's `reason` field pattern; only recorded when marking unavailable with a note.
  if (availability === 'unavailable' && reason) {
    console.log(`Driver ${data.name} marked unavailable: ${reason}`);
  }

  res.json(data);
});

// GET reassignment history (optionally filtered by date)
app.get('/api/employees/reassignments', async (req, res) => {
  const { date } = req.query;
  let query = supabase
    .from('employee_reassignments')
    .select('*, original:original_employee_id(name, employee_id), replacement:replacement_employee_id(name, employee_id)')
    .order('created_at', { ascending: false });
  if (date) query = query.eq('date', date);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET single employee
app.get('/api/employees/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Employee not found' });
  res.json(data);
});

// POST create employee
app.post('/api/employees', async (req, res) => {
  const { name, email, department, position, employee_id, shift_start, shift_end, is_fleet_driver } = req.body;
  if (!name || !email || !employee_id) {
    return res.status(400).json({ error: 'name, email, and employee_id are required' });
  }
  const { data, error } = await supabase
    .from('employees')
    .insert([{ name, email, department, position, employee_id, shift_start: shift_start || '09:00', shift_end: shift_end || '18:00', status: 'active', is_fleet_driver: Boolean(is_fleet_driver) }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT update employee
app.put('/api/employees/:id', async (req, res) => {
  const { name, email, department, position, shift_start, shift_end, status, is_fleet_driver } = req.body;
  const { data, error } = await supabase
    .from('employees')
    .update({ name, email, department, position, shift_start, shift_end, status, is_fleet_driver: Boolean(is_fleet_driver), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE employee
app.delete('/api/employees/:id', async (req, res) => {
  const { error } = await supabase
    .from('employees')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Employee deleted' });
});

// ─── LEAVES ───────────────────────────────────────────────────────────────────
// Leave counting and auto-generated absence records now respect each
// employee's ACTUAL rest days (shift_assignments.is_day_off) instead of
// hardcoding Sat/Sun — an employee scheduled Tue-Sat, for example, will be
// correctly charged for a Saturday and not charged for their real Mon/Sun off.
// Falls back to the Sat/Sun assumption only for dates that have no schedule
// data at all.
//
// Approving a leave also upserts is_day_off rows into shift_assignments (not
// just attendance) so the Schedule page and driver-coverage views agree with
// leave status instead of still showing the employee as rostered to work.
//
// Every attendance/shift_assignments row auto-created by a leave approval is
// tagged with source_leave_id so it can be precisely cleaned up — and only
// those rows — if the leave is later deleted or reversed from approved to
// rejected. Requires this migration:
//   alter table attendance add column source_leave_id uuid references leaves(id);
//   alter table shift_assignments add column source_leave_id uuid references leaves(id);

// Returns the list of YYYY-MM-DD dates in [startDate, endDate] that count as
// working days for this employee: explicit shift_assignments data wins
// (is_day_off true/false for that exact date); any date with no row at all
// falls back to "not a weekend".
async function getWorkingDaysInRange(employeeId, startDate, endDate) {
  const { data: rows, error } = await supabase
    .from('shift_assignments')
    .select('date, is_day_off')
    .eq('employee_id', employeeId)
    .gte('date', startDate)
    .lte('date', endDate);
  if (error) throw error;

  const known = new Map((rows || []).map(r => [r.date, r.is_day_off]));
  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }

  return dates.filter(d => {
    if (known.has(d)) return !known.get(d);
    const dow = new Date(d + 'T00:00:00').getDay();
    return dow !== 0 && dow !== 6;
  });
}

// GET all leave requests (with optional filters)
app.get('/api/leaves', async (req, res) => {
  const { employee_id, status, type, start_date, end_date } = req.query;

  let query = supabase
    .from('leaves')
    .select('*, employees(name, employee_id, department)')
    .order('created_at', { ascending: false });

  if (employee_id) query = query.eq('employee_id', employee_id);
  if (status)      query = query.eq('status', status);
  if (type)        query = query.eq('type', type);
  if (start_date)  query = query.gte('start_date', start_date);
  if (end_date)    query = query.lte('end_date', end_date);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create leave request
app.post('/api/leaves', async (req, res) => {
  const { employee_id, type, start_date, end_date, reason } = req.body;
  if (!employee_id || !type || !start_date || !end_date) {
    return res.status(400).json({ error: 'employee_id, type, start_date, end_date are required' });
  }

  let days;
  try {
    days = (await getWorkingDaysInRange(employee_id, start_date, end_date)).length;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const { data, error } = await supabase
    .from('leaves')
    .insert([{ employee_id, type, start_date, end_date, days, reason, status: 'pending' }])
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH approve or reject a leave request
app.patch('/api/leaves/:id/status', async (req, res) => {
  const { status, notes } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or rejected' });
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('leaves')
    .select('id, status')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Leave request not found' });
  const wasApproved = existing.status === 'approved';

  const { data: leave, error } = await supabase
    .from('leaves')
    .update({ status, notes, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('*, employees(name, employee_id, department)')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (status === 'approved') {
    // ── Auto-create absent attendance + rest-day schedule rows for each
    // real working day, using this employee's actual schedule rather than
    // an assumed Sat/Sun weekend ──
    let workingDays = [];
    try {
      workingDays = await getWorkingDaysInRange(leave.employee_id, leave.start_date, leave.end_date);
    } catch (e) {
      console.error('Working-day lookup error:', e.message);
    }

    if (workingDays.length > 0) {
      const attendanceRecords = workingDays.map(date => ({
        employee_id:     leave.employee_id,
        date,
        status:           'absent',
        notes:            `On approved ${leave.type} leave${notes ? ': ' + notes : ''}`,
        clock_in:         null,
        clock_out:        null,
        hours_worked:     null,
        source_leave_id:  leave.id,
      }));
      const { error: attErr } = await supabase
        .from('attendance')
        .upsert(attendanceRecords, { onConflict: 'employee_id,date' });
      if (attErr) console.error('Attendance upsert error:', attErr.message);

      // Reflect the leave on the Schedule too, so it doesn't still show the
      // employee as rostered to work — this overwrites any shift assigned
      // for that specific date only; other dates are untouched.
      const scheduleRecords = workingDays.map(date => ({
        employee_id:      leave.employee_id,
        shift_template_id: null,
        date,
        notes:             `On approved ${leave.type} leave`,
        is_day_off:        true,
        source_leave_id:   leave.id,
        updated_at:        new Date().toISOString(),
      }));
      const { error: schedErr } = await supabase
        .from('shift_assignments')
        .upsert(scheduleRecords, { onConflict: 'employee_id,date' });
      if (schedErr) console.error('Schedule upsert error:', schedErr.message);
    }
  } else if (wasApproved && status === 'rejected') {
    // Reversing a previous approval — remove exactly the rows this leave
    // auto-created, and only those (manually-set rest days or attendance
    // edits are untouched since they don't carry this leave's source_leave_id).
    const { error: attCleanupErr } = await supabase.from('attendance').delete().eq('source_leave_id', leave.id);
    if (attCleanupErr) console.error('Attendance cleanup error:', attCleanupErr.message);
    const { error: schedCleanupErr } = await supabase.from('shift_assignments').delete().eq('source_leave_id', leave.id);
    if (schedCleanupErr) console.error('Schedule cleanup error:', schedCleanupErr.message);
  }

  res.json(leave);
});

// DELETE leave request — also removes any attendance/schedule rows that were
// auto-created by its approval, so deleting a leave doesn't leave orphaned
// "absent" records or phantom rest days behind with nothing to explain them.
app.delete('/api/leaves/:id', async (req, res) => {
  const { error: attCleanupErr } = await supabase.from('attendance').delete().eq('source_leave_id', req.params.id);
  if (attCleanupErr) console.error('Attendance cleanup error:', attCleanupErr.message);
  const { error: schedCleanupErr } = await supabase.from('shift_assignments').delete().eq('source_leave_id', req.params.id);
  if (schedCleanupErr) console.error('Schedule cleanup error:', schedCleanupErr.message);

  const { error } = await supabase.from('leaves').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Leave request deleted' });
});

// ─── ATTENDANCE ───────────────────────────────────────────────────────────────

// GET attendance records (with optional filters)
app.get('/api/attendance', async (req, res) => {
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
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET today's attendance summary
app.get('/api/attendance/today', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const { data: attendanceData, error: attendanceError } = await supabase
    .from('attendance')
    .select('*, employees(name, employee_id, department, shift_start, shift_end)')
    .eq('date', today);

  if (attendanceError) return res.status(500).json({ error: attendanceError.message });

  const { data: totalEmployees, error: empError } = await supabase
    .from('employees')
    .select('id', { count: 'exact' })
    .eq('status', 'active');

  if (empError) return res.status(500).json({ error: empError.message });

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
});

// POST clock in
app.post('/api/attendance/clock-in', async (req, res) => {
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
  // getWorkingDaysInRange and the /api/schedule routes above.
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

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT clock out
app.put('/api/attendance/clock-out', async (req, res) => {
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

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── BREAKS ──────────────────────────────────────────────────────────────────

// POST /api/attendance/break-start  — called by break room RFID scanner on entry
app.post('/api/attendance/break-start', async (req, res) => {
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

  if (error) return res.status(500).json({ error: error.message });
  res.json({ breakType, record: data });
});

// POST /api/attendance/break-end  — called by break room RFID scanner on exit
app.post('/api/attendance/break-end', async (req, res) => {
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

  if (error) return res.status(500).json({ error: error.message });
  res.json({ breakType, record: data });
});

// POST manual attendance (admin)
app.post('/api/attendance', async (req, res) => {
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

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE attendance record
app.delete('/api/attendance/:id', async (req, res) => {
  const { error } = await supabase.from('attendance').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Record deleted' });
});

// ─── FLEET DRIVER REASSIGNMENT (continued) ──────────────────────────────────
// The GET availability routes live earlier in the file, right after
// "GET all employees" — Express needs literal paths like /absent-drivers
// registered before the /:id param route or the param route swallows them.

// POST assign an available fleet driver to cover an absent one's shift
app.post('/api/employees/reassign-driver', async (req, res) => {
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
  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json(data);
});

// DELETE / undo a reassignment
app.delete('/api/employees/reassignments/:id', async (req, res) => {
  const { error } = await supabase.from('employee_reassignments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Reassignment removed' });
});

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

app.get('/api/analytics/summary', async (req, res) => {
  const { start_date, end_date } = req.query;
  const start = start_date || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const end = end_date || new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('attendance')
    .select('status, hours_worked, date, employee_id, employees(name, department)')
    .gte('date', start)
    .lte('date', end);

  if (error) return res.status(500).json({ error: error.message });

  const totalRecords = data.length;
  const present = data.filter(r => r.status === 'present').length;
  const late = data.filter(r => r.status === 'late').length;
  const absent = data.filter(r => r.status === 'absent').length;
  const excused   = data.filter(r => r.status === 'absent' && r.notes?.includes('approved')).length;
  const unexcused = absent - excused;
  const totalHours = data.reduce((sum, r) => sum + (r.hours_worked || 0), 0);

  // Attendance by department
  const deptMap = {};
  data.forEach(r => {
    const dept = r.employees?.department || 'Unknown';
    if (!deptMap[dept]) deptMap[dept] = { present: 0, late: 0, absent: 0, total: 0 };
    deptMap[dept][r.status] = (deptMap[dept][r.status] || 0) + 1;
    deptMap[dept].total++;
  });

  // Daily trend (last 7 days within range)
  const dailyMap = {};
  data.forEach(r => {
    if (!dailyMap[r.date]) dailyMap[r.date] = { present: 0, late: 0, absent: 0 };
    dailyMap[r.date][r.status] = (dailyMap[r.date][r.status] || 0) + 1;
  });

  res.json({
    period: { start, end },
    totals: { totalRecords, present, late, absent, excused, unexcused, totalHours: totalHours.toFixed(1) },
    byDepartment: Object.entries(deptMap).map(([dept, stats]) => ({ department: dept, ...stats })),
    dailyTrend: Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([date, stats]) => ({ date, ...stats })),
  });
});

// ─── SHIFT & SCHEDULE MANAGEMENT ─────────────────────────────────────────────
// Two tables: shift_templates (reusable, e.g. "Morning Shift" 06:00-14:00) and
// shift_assignments (which employee has which template on which specific date —
// one row per employee per day; UNIQUE(employee_id, date) prevents double-booking).
// Recurring assignment ("Mon/Wed/Fri") is NOT stored as a recurrence rule — it's
// expanded server-side into individual date rows via /api/schedule/recurring.
// This keeps lookups simple (no rule evaluation) and lets each day be edited or
// removed independently without touching a pattern that affects other days.
//
// NOTE: unrelated to employees.shift_start/shift_end, which is just a default
// used only for the late/present clock-in check — this is the real roster.

// ── Shift templates ──
app.get('/api/shift-templates', async (req, res) => {
  const { data, error } = await supabase
    .from('shift_templates')
    .select('*')
    .order('start_time', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/shift-templates', async (req, res) => {
  const { name, start_time, end_time, color } = req.body;
  if (!name || !start_time || !end_time) {
    return res.status(400).json({ error: 'name, start_time, and end_time are required' });
  }
  const { data, error } = await supabase
    .from('shift_templates')
    .insert([{ name, start_time, end_time, color: color || '#3b82f6' }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/api/shift-templates/:id', async (req, res) => {
  const { name, start_time, end_time, color } = req.body;
  const { data, error } = await supabase
    .from('shift_templates')
    .update({ name, start_time, end_time, color })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/shift-templates/:id', async (req, res) => {
  const { error } = await supabase.from('shift_templates').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Shift template deleted' });
});

// ── Schedule (shift assignments) ──
// A row can now represent either a worked shift (shift_template_id set,
// is_day_off false) or an explicit rest day / day off (shift_template_id
// null, is_day_off true). This lets the UI distinguish "intentionally off"
// from "just hasn't been scheduled yet" (no row at all), instead of both
// looking like an empty cell.
//
// Requires this migration on the shift_assignments table:
//   alter table shift_assignments add column is_day_off boolean not null default false;
//   alter table shift_assignments alter column shift_template_id drop not null;

// GET assignments in a date range, optionally filtered by employee
app.get('/api/schedule', async (req, res) => {
  const { start_date, end_date, employee_id } = req.query;
  const start = start_date || new Date().toISOString().split('T')[0];
  const end = end_date || start;

  let query = supabase
    .from('shift_assignments')
    .select('*, employees(name, employee_id, department), shift_templates(name, start_time, end_time, color)')
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true });
  if (employee_id) query = query.eq('employee_id', employee_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST single assignment — upsert so re-assigning the same employee/date just replaces it.
// Pass is_day_off: true to mark an explicit rest day instead of a worked shift;
// shift_template_id is ignored (stored as null) in that case.
//
// Assigning an actual working shift (dayOff false) is blocked if the employee
// has an approved leave covering that date — otherwise a schedule change can
// silently contradict an already-approved leave (see Leaves section above,
// which syncs approved leave into shift_assignments as a rest day). Marking
// a day off is always allowed since it can't conflict with a leave.
app.post('/api/schedule', async (req, res) => {
  const { employee_id, shift_template_id, date, notes, is_day_off } = req.body;
  const dayOff = !!is_day_off;
  if (!employee_id || !date || (!dayOff && !shift_template_id)) {
    return res.status(400).json({ error: 'employee_id, date, and (shift_template_id or is_day_off) are required' });
  }

  if (!dayOff) {
    const { data: conflict, error: leaveErr } = await supabase
      .from('leaves')
      .select('id, type, start_date, end_date, employees(name)')
      .eq('employee_id', employee_id)
      .eq('status', 'approved')
      .lte('start_date', date)
      .gte('end_date', date)
      .maybeSingle();
    if (leaveErr) return res.status(500).json({ error: leaveErr.message });
    if (conflict) {
      const empName = conflict.employees?.name || 'This employee';
      return res.status(409).json({
        error: `${empName} is on approved ${conflict.type} leave from ${conflict.start_date} to ${conflict.end_date} — cannot assign a working shift on ${date} while that leave is active. Reject or delete the leave first if this was a mistake.`,
      });
    }
  }

  const { data, error } = await supabase
    .from('shift_assignments')
    .upsert([{
      employee_id,
      shift_template_id: dayOff ? null : shift_template_id,
      date,
      notes,
      is_day_off: dayOff,
      updated_at: new Date().toISOString(),
    }], { onConflict: 'employee_id,date' })
    .select('*, employees(name, employee_id, department), shift_templates(name, start_time, end_time, color)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// POST recurring assignment — expands a weekday pattern over a date range into
// individual shift_assignments rows. e.g. days_of_week: [1,3,5] = Mon/Wed/Fri
// (0=Sun ... 6=Sat). Existing assignments on matching dates are overwritten.
// Pass is_day_off: true to mark those weekdays as recurring rest days
// (e.g. days_of_week: [0,6] to give an employee every Sat/Sun off) instead
// of assigning a shift template.
//
// When assigning a working shift (dayOff false), any candidate date that
// falls inside an approved leave for this employee is silently skipped
// (not overwritten) and reported back in `skipped` rather than failing the
// whole batch — same reasoning as the single-assignment guard above.
app.post('/api/schedule/recurring', async (req, res) => {
  const { employee_id, shift_template_id, start_date, end_date, days_of_week, notes, is_day_off } = req.body;
  const dayOff = !!is_day_off;
  if (!employee_id || !start_date || !end_date || !Array.isArray(days_of_week) || days_of_week.length === 0 || (!dayOff && !shift_template_id)) {
    return res.status(400).json({ error: 'employee_id, start_date, end_date, days_of_week[], and (shift_template_id or is_day_off) are required' });
  }

  const dowSet = new Set(days_of_week.map(Number));
  const candidateDates = [];
  const cur = new Date(start_date);
  const end = new Date(end_date);
  while (cur <= end) {
    if (dowSet.has(cur.getDay())) candidateDates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }

  if (candidateDates.length === 0) {
    return res.status(400).json({ error: 'No matching dates found for the given days_of_week in that range' });
  }

  let skipped = [];
  let usableDates = candidateDates;
  let overlappingLeaves = [];
  if (!dayOff) {
    const { data: leaveRows, error: leaveErr } = await supabase
      .from('leaves')
      .select('start_date, end_date, type, employees(name)')
      .eq('employee_id', employee_id)
      .eq('status', 'approved')
      .lte('start_date', end_date)
      .gte('end_date', start_date);
    if (leaveErr) return res.status(500).json({ error: leaveErr.message });
    overlappingLeaves = leaveRows || [];

    const isOnApprovedLeave = (d) => overlappingLeaves.some(l => l.start_date <= d && d <= l.end_date);
    skipped = candidateDates.filter(isOnApprovedLeave);
    usableDates = candidateDates.filter(d => !isOnApprovedLeave(d));
  }

  if (usableDates.length === 0) {
    const empName = overlappingLeaves[0]?.employees?.name || 'This employee';
    const leaveDescriptions = overlappingLeaves
      .map(l => `${l.type} leave (${l.start_date} to ${l.end_date})`)
      .join(', ');
    return res.status(400).json({
      error: `${empName} is on approved leave for every matching date — ${leaveDescriptions}. Reject or delete the leave first if this was a mistake.`,
    });
  }

  const records = usableDates.map(date => ({
    employee_id,
    shift_template_id: dayOff ? null : shift_template_id,
    date,
    notes: notes || null,
    is_day_off: dayOff,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('shift_assignments')
    .upsert(records, { onConflict: 'employee_id,date' })
    .select('*, employees(name, employee_id, department), shift_templates(name, start_time, end_time, color)');
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ created: data.length, skipped, assignments: data });
});

// DELETE a single assignment (e.g. remove one day from a recurring block)
app.delete('/api/schedule/:id', async (req, res) => {
  const { error } = await supabase.from('shift_assignments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Shift assignment removed' });
});

// ─── DRIVERS ──────────────────────────────────────────────────────────────────

const HR1_WEBHOOK_URL = process.env.HR1_WEBHOOK_URL || null;
const INACTIVITY_DAYS_THRESHOLD = 7;

// GET all drivers
app.get('/api/drivers', async (req, res) => {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create driver
app.post('/api/drivers', async (req, res) => {
  const { name, driver_id, license_number, license_expiry, vehicle_plate, last_trip_date } = req.body;
  if (!name || !driver_id) {
    return res.status(400).json({ error: 'name and driver_id are required' });
  }
  const { data, error } = await supabase
    .from('drivers')
    .insert([{ name, driver_id, license_number, license_expiry, vehicle_plate, last_trip_date, status: 'active' }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT update driver (e.g. log a new trip, update license)
app.put('/api/drivers/:id', async (req, res) => {
  const { name, license_number, license_expiry, vehicle_plate, last_trip_date, status } = req.body;
  const { data, error } = await supabase
    .from('drivers')
    .update({ name, license_number, license_expiry, vehicle_plate, last_trip_date, status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE driver
app.delete('/api/drivers/:id', async (req, res) => {
  const { error } = await supabase.from('drivers').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Driver deleted' });
});

// GET inactivity logs (for audit / HR1 review history)
app.get('/api/drivers/inactivity-logs', async (req, res) => {
  const { data, error } = await supabase
    .from('driver_inactivity_logs')
    .select('*, drivers(name, driver_id)')
    .order('detected_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/drivers/check-inactivity
// Scans all drivers for: license expired OR no trips logged in last 7 days.
// For each newly-flagged driver: marks status='inactive', logs the event, and
// notifies HR1 via webhook (if HR1_WEBHOOK_URL is configured).
app.post('/api/drivers/check-inactivity', async (req, res) => {
  const { data: drivers, error } = await supabase.from('drivers').select('*');
  if (error) return res.status(500).json({ error: error.message });

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
      let hr1Notified = false;
      let hr1Response = 'HR1_WEBHOOK_URL not configured — skipped';

      if (HR1_WEBHOOK_URL) {
        try {
          const resp = await fetch(HR1_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'driver_inactive',
              driver: {
                id: driver.id,
                name: driver.name,
                driver_id: driver.driver_id,
              },
              reasons,
              details,
              detected_at: new Date().toISOString(),
            }),
          });
          hr1Notified = resp.ok;
          hr1Response = `HTTP ${resp.status}`;
        } catch (err) {
          hr1Response = `Webhook error: ${err.message}`;
        }
      }

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
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/api/health', async (_, res) => {
  const { error } = await supabase.from('employees').select('id').limit(1);
  res.json({
    status: error ? 'error' : 'ok',
    supabase: error ? error.message : 'connected',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`✅  Attendance API running on http://localhost:${PORT}`));