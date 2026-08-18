import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';
import XlsxPopulate from 'xlsx-populate';
import { broadcastSseEvent } from '../utils/sse.js';
import {
  getBreakPolicies,
  getNextAction,
  creditedBreakMinutes,
  invalidateBreakPolicyCache,
  minutesElapsedAcrossMidnight,
} from '../services/breakEngine.js';

export function todayDateString(timeZone = 'Asia/Manila') {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ─── kiosk scan safety: serialize + debounce ───────────────────────────────
// Two scans for the same employee arriving close together (a finger
// lingering on the sensor, a device retry, an unsure double-tap) can both
// read the punch list before either insert lands, then both compute the
// SAME "next action" and both write — corrupting the sequence (e.g. a break
// gets logged twice instead of the cycle advancing). Two things fix this:
//   1. withEmployeeLock() serializes recordPunch() calls per employee so a
//      second call always sees the first call's write.
//   2. The debounce check below then treats a second scan that lands within
//      DEBOUNCE_SECONDS of the last recorded punch as an accidental repeat,
//      not a new step, and just echoes back the current state.
// Note: the lock is in-process only — fine for a single kiosk backend
// instance, but won't coordinate across multiple server processes.
const DEBOUNCE_SECONDS = 5; // 5 minutes (was 4s) — testing a longer duplicate-scan window
const employeeLocks = new Map();

function withEmployeeLock(employee_id, fn) {
  const prior = employeeLocks.get(employee_id) || Promise.resolve();
  const run = prior.then(fn, fn);
  employeeLocks.set(employee_id, run.catch(() => { }));
  return run;
}

function secondsBetween(t1, t2) {
  const toSeconds = t => {
    const [h, m, s] = t.split(':').map(Number);
    return h * 3600 + m * 60 + (s || 0);
  };
  return Math.abs(toSeconds(t1) - toSeconds(t2));
}

// ─── break time tracking helpers ────────────────────────────────────────────

// `attendance` only has fixed columns for these two breaks. break_policies
// is admin-editable free text, so its `name` can drift away from these
// column names (that drift is exactly what caused the
// "Could not find the 'coffee_morning_end' column" error). Keep this map as
// the single source of truth for which break types have a home in
// `attendance`, and treat anything else as "log the punch, skip the summary
// column" instead of crashing clock-out.
const BREAK_COLUMN_MAP = {
  lunch: ['lunch_start', 'lunch_end'],
  coffee: ['coffee_start', 'coffee_end'],
};

/**
 * Extract break start/end times from punches and return as an object
 * keyed by real `attendance` column names (e.g. lunch_start, coffee_end).
 * Break types with no entry in BREAK_COLUMN_MAP are skipped with a warning
 * instead of producing an update payload Supabase will reject.
 */
function getBreakTimesFromPunches(punches) {
  const breakTimes = {};

  if (!punches || punches.length === 0) return breakTimes;

  // Find matching pairs of break OUT and IN punches
  for (let i = 0; i < punches.length - 1; i++) {
    const punch = punches[i];
    if (punch.punch_type === 'out' && punch.break_type && !punch.is_final) {
      // Look for matching IN punch for this break
      for (let j = i + 1; j < punches.length; j++) {
        const nextPunch = punches[j];
        if (nextPunch.punch_type === 'in' && nextPunch.break_type === punch.break_type && !nextPunch.is_final) {
          // Found matching pair
          const cols = BREAK_COLUMN_MAP[punch.break_type];
          if (cols) {
            const [startCol, endCol] = cols;
            breakTimes[startCol] = punch.punch_time;
            breakTimes[endCol] = nextPunch.punch_time;
          } else {
            console.warn(
              `[getBreakTimesFromPunches] Unknown break_type "${punch.break_type}" — ` +
              `no matching attendance columns, skipping summary write for this break. ` +
              `(Check break_policies.name matches one of: ${Object.keys(BREAK_COLUMN_MAP).join(', ')})`
            );
          }
          break;
        }
      }
    }
  }

  return breakTimes;
}

// ─── manual/admin hour calculation helper ──────────────────────────────────

// Used by create() and bulkImport() to compute hours_worked from raw
// clock_in/clock_out time strings typed or imported by an admin.
//
// The previous implementation built two `Date` objects on the SAME `date`
// (`new Date(`${date}T${clock_in}`)` / `...T${clock_out}`) and subtracted
// them directly. That's fine for a same-day shift, but for any shift that
// crosses midnight (e.g. 6PM–3AM) it produces a NEGATIVE duration, because
// 3:00 AM is numerically earlier in the day than 6:00 PM even though it's
// really ~9 hours later, on the next calendar day. minutesElapsedAcrossMidnight
// already solves exactly this for the kiosk/auto-clock-out paths — reuse it
// here instead of re-deriving the same logic with Date math.
//
// Returns null (rather than throwing) if either time string is missing or
// malformed, so a bad row just gets hours_worked: null instead of crashing
// the whole create/import call.
function computeHoursWorked(clockIn, clockOut) {
  if (!clockIn || !clockOut) return null;
  try {
    const grossMinutes = minutesElapsedAcrossMidnight(clockIn, clockOut);
    return parseFloat((grossMinutes / 60).toFixed(2));
  } catch {
    return null;
  }
}

// ─── shared helpers ─────────────────────────────────────────────────────────

async function getPunches(attendance_id) {
  const { data, error } = await supabase
    .from('attendance_punches')
    .select('*')
    .eq('attendance_id', attendance_id)
    .order('sequence', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getTodaysAttendanceWithPunches(employee_id, date) {
  const { data: attendance, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('employee_id', employee_id)
    .eq('date', date)
    .maybeSingle();
  if (error) throw error;
  if (!attendance) return { attendance: null, punches: [] };
  const punches = await getPunches(attendance.id);
  return { attendance, punches };
}

async function getEmployeeShiftForDate(employee_id, date) {
  const { data: todaysShift } = await supabase
    .from('shift_assignments')
    .select('id, is_day_off, role_id, shift_templates:roles(start_time, end_time)')
    .eq('employee_id', employee_id)
    .eq('date', date)
    .maybeSingle();
  return todaysShift;
}

async function resolveShiftStart(employee_id, todaysShift) {
  let shiftStart = todaysShift?.shift_templates?.start_time;
  if (!shiftStart) {
    const { data: employee } = await supabase
      .from('employees')
      .select('shift_start')
      .eq('id', employee_id)
      .single();
    shiftStart = employee?.shift_start;
  }
  return shiftStart;
}

async function fetchEmployeeSummary(employee_id) {
  const { data } = await supabase
    .from('employees')
    .select('name, employee_id, department')
    .eq('id', employee_id)
    .single();
  return data || null;
}

// Batch-attach punches to a list of attendance-shaped records (skips
// synthesized "unrecorded-*" absent placeholders, which have no real row).
async function attachPunches(records) {
  const ids = records.map(r => r.id).filter(id => typeof id === 'string' && !id.startsWith('unrecorded-'));
  if (ids.length === 0) return records.map(r => ({ ...r, punches: [] }));

  const { data: allPunches, error } = await supabase
    .from('attendance_punches')
    .select('*')
    .in('attendance_id', ids)
    .order('sequence', { ascending: true });
  if (error) throw error;

  const byAttendance = {};
  for (const p of allPunches || []) {
    (byAttendance[p.attendance_id] ||= []).push(p);
  }
  return records.map(r => ({ ...r, punches: byAttendance[r.id] || [] }));
}

/**
 * Insert the next punch for an employee/date and update the attendance
 * summary row accordingly. This is the single engine behind clockIn,
 * clockOut, breakStart, breakEnd, and the kiosk punch() endpoint.
 *
 * `validateAction(action) => string | null` — optional guard. Receives the
 * auto-detected next action BEFORE anything is written; return an error
 * string to reject (used by the legacy endpoints to enforce that "Clock
 * Out" can't accidentally end a break, etc). Return null/undefined to allow.
 * Omit entirely for auto-detect-only callers (the kiosk).
 */
async function recordPunch(args) {
  // Serialize all punches for this employee so two near-simultaneous scans
  // can never both read the same "current" state and both write.
  return withEmployeeLock(args.employee_id, () => recordPunchLocked(args));
}

async function recordPunchLocked({ employee_id, date, punchTime, validateAction = null, isAutomatic = false }) {
  const policies = await getBreakPolicies();
  const { attendance, punches } = await getTodaysAttendanceWithPunches(employee_id, date);

  // A scan that lands within DEBOUNCE_SECONDS of the last recorded punch is
  // treated as an accidental repeat (lingering finger / device retry), not
  // a new step — echo back the current state instead of advancing.
  if (punches.length > 0) {
    const lastPunch = punches[punches.length - 1];
    if (secondsBetween(lastPunch.punch_time, punchTime) < DEBOUNCE_SECONDS) {
      return {
        attendance,
        punches,
        action: { punch_type: null, break_type: null, is_final: false, meaning: 'duplicate_ignored' },
        duplicate: true,
      };
    }
  }

  const action = getNextAction(punches, policies);

  if (action.meaning === 'already_finalized') {
    const err = new Error('Attendance already finalized for today');
    err.status = 409;
    throw err;
  }

  if (validateAction) {
    const message = validateAction(action);
    if (message) {
      const err = new Error(message);
      err.status = 409;
      err.nextAction = action.meaning;
      throw err;
    }
  }

  let attendanceRow = attendance;

  // First punch of the day: enforce leave and shift guards, and create/update attendance row
  if (punches.length === 0) {
    const { data: activeLeave } = await supabase
      .from('leaves')
      .select('id, type, start_date, end_date')
      .eq('employee_id', employee_id)
      .eq('status', 'approved')
      .lte('start_date', date)
      .gte('end_date', date)
      .maybeSingle();
    if (activeLeave) {
      const err = new Error(`Employee is on approved ${activeLeave.type} leave today (${activeLeave.start_date} → ${activeLeave.end_date})`);
      err.status = 403;
      throw err;
    }

    const todaysShift = await getEmployeeShiftForDate(employee_id, date);
    if (!todaysShift || todaysShift.is_day_off || !todaysShift.role_id) {
      const err = new Error('No shift scheduled for today — contact your admin to get scheduled before clocking in.');
      err.status = 403;
      throw err;
    }

    const shiftStart = await resolveShiftStart(employee_id, todaysShift);
    let status = 'present';
    if (shiftStart) {
      const graceLimitMinutes = timeToMinutes(shiftStart.slice(0, 5)) + 15;
      if (timeToMinutes(punchTime.slice(0, 5)) > graceLimitMinutes) status = 'late';
    }

    if (attendanceRow) {
      const { data: updated, error: updateError } = await supabase
        .from('attendance')
        .update({
          clock_in: punchTime,
          status,
          notes: null,
          source_leave_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', attendanceRow.id)
        .select()
        .single();
      if (updateError) throw updateError;
      attendanceRow = updated;
    } else {
      const { data: created, error: createError } = await supabase
        .from('attendance')
        .insert([{
          employee_id, date, clock_in: punchTime, clock_out: null,
          hours_worked: null, break_minutes: 0, net_hours_worked: null,
          status, notes: null, auto_clock_out: false, is_finalized: false,
        }])
        .select()
        .single();
      if (createError) throw createError;
      attendanceRow = created;
    }
  }

  const nextSequence = punches.length + 1;
  const { data: punchRow, error: punchError } = await supabase
    .from('attendance_punches')
    .insert([{
      attendance_id: attendanceRow.id,
      sequence: nextSequence,
      punch_type: action.punch_type,
      punch_time: punchTime,
      break_type: action.break_type,
      is_final: action.is_final,
      is_automatic: isAutomatic,
    }])
    .select()
    .single();
  if (punchError) throw punchError;

  const allPunches = [...punches, punchRow];

  if (action.is_final) {
    // Final OUT → close out the day's summary numbers.
    const firstIn = allPunches[0];
    // Overnight-safe: a shift that runs past midnight (e.g. 19:00 → 03:00)
    // would otherwise produce a negative duration here, since punchTime's
    // clock-time-of-day is numerically smaller than firstIn's.
    const grossMinutes = minutesElapsedAcrossMidnight(firstIn.punch_time, punchTime);
    const credited = creditedBreakMinutes(allPunches, policies);
    const netMinutes = grossMinutes - credited;

    // Get all break times from punches (only for known break types —
    // see BREAK_COLUMN_MAP above)
    const breakTimes = getBreakTimesFromPunches(allPunches);

    const { data: updated, error: updateError } = await supabase
      .from('attendance')
      .update({
        clock_out: punchTime,
        hours_worked: parseFloat((grossMinutes / 60).toFixed(2)),
        break_minutes: credited,
        net_hours_worked: parseFloat((netMinutes / 60).toFixed(2)),
        is_finalized: true,
        auto_clock_out: isAutomatic,
        updated_at: new Date().toISOString(),
        ...breakTimes, // Spread break times into update
      })
      .eq('id', attendanceRow.id)
      .select()
      .single();
    if (updateError) throw updateError;
    attendanceRow = updated;
  } else if (action.punch_type === 'in' && action.break_type) {
    // A break just ended — keep break_minutes current for the live dashboard
    // and update the specific break end time column
    const creditedSoFar = creditedBreakMinutes(allPunches, policies);
    const breakTimes = getBreakTimesFromPunches(allPunches);

    const { data: updated, error: updateError } = await supabase
      .from('attendance')
      .update({
        break_minutes: creditedSoFar,
        updated_at: new Date().toISOString(),
        ...breakTimes, // Spread break times into update
      })
      .eq('id', attendanceRow.id)
      .select()
      .single();
    if (updateError) throw updateError;
    attendanceRow = updated;
  }

  return { attendance: attendanceRow, punches: allPunches, action };
}

// ─── read endpoints ─────────────────────────────────────────────────────────

export async function getAll(req, res) {
  const { employee_id, date, start_date, end_date, status } = req.query;

  let query = supabase
    .from('attendance')
    .select('*')
    .order('date', { ascending: false })
    .order('clock_in', { ascending: false });

  if (employee_id) query = query.eq('employee_id', employee_id);
  if (date) query = query.eq('date', date);
  if (start_date) query = query.gte('date', start_date);
  if (end_date) query = query.lte('date', end_date);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return handleError(res, error);

  const empIds = [...new Set(data.map(r => r.employee_id).filter(Boolean))];
  let empMap = {};
  if (empIds.length > 0) {
    const { data: employees, error: empError } = await supabase
      .from('employees')
      .select('id, employee_id, name, department, position, shift_start, shift_end')
      .in('id', empIds);
    if (empError) return handleError(res, empError);
    empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));
  }

  try {
    const withPunches = await attachPunches(data);
    const result = withPunches.map(record => ({
      ...record,
      employees: empMap[record.employee_id] || null,
    }));
    res.json(result);
  } catch (err) {
    return handleError(res, err);
  }
}

export async function getToday(req, res) {
  const today = todayDateString();

  const { data: totalEmployees, error: empError } = await supabase
    .from('employees')
    .select('id', { count: 'exact' })
    .eq('status', 'active');
  if (empError) return handleError(res, empError);

  const { data: assignments, error: assignError } = await supabase
    .from('shift_assignments')
    .select('employee_id, role_id, shift_templates:roles(start_time, end_time)')
    .eq('date', today)
    .eq('is_day_off', false)
    .not('role_id', 'is', null);
  if (assignError) return handleError(res, assignError);

  const assignmentMap = Object.fromEntries((assignments || []).map(a => [a.employee_id, a]));
  const scheduledEmployeeIds = [...new Set((assignments || []).map(a => a.employee_id).filter(Boolean))];

  const { data: attendanceData, error: attendanceError } = await supabase
    .from('attendance')
    .select('*')
    .eq('date', today);
  if (attendanceError) return handleError(res, attendanceError);

  const empIds = [...new Set([
    ...attendanceData.map(r => r.employee_id),
    ...scheduledEmployeeIds,
  ].filter(Boolean))];
  let empMap = {};
  if (empIds.length > 0) {
    const { data: employees, error: empLookupError } = await supabase
      .from('employees')
      .select('id, employee_id, name, department, position, shift_start, shift_end')
      .in('id', empIds);
    if (empLookupError) return handleError(res, empLookupError);
    empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));
  }

  // Determine current time in Asia/Manila for shift start comparison
  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const nowObj = Object.fromEntries(nowParts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const nowMinutes = Number(nowObj.hour) * 60 + Number(nowObj.minute);

  try {
    const attendanceWithPunches = await attachPunches(attendanceData);
    const attendanceByEmployee = Object.fromEntries(attendanceWithPunches.map(r => [r.employee_id, r]));

    // Start with all existing attendance records (both scheduled and unscheduled)
    const recordedIds = new Set();
    const records = attendanceWithPunches.map(record => {
      recordedIds.add(record.employee_id);
      return {
        ...record,
        employees: empMap[record.employee_id] || null,
      };
    });

    // Add unrecorded scheduled employees
    for (const employeeId of scheduledEmployeeIds) {
      if (recordedIds.has(employeeId)) continue;

      const shiftStart = assignmentMap[employeeId]?.shift_templates?.start_time || empMap[employeeId]?.shift_start;
      let status = 'scheduled';

      if (shiftStart) {
        const shiftStartMinutes = timeToMinutes(shiftStart.slice(0, 5));
        const graceLimit = shiftStartMinutes + 15;
        // If current time is past shift start + 15 min grace period, mark absent
        if (nowMinutes >= graceLimit) {
          status = 'absent';
        }
      }

      records.push({
        id: `unrecorded-${employeeId}`,
        employee_id: employeeId,
        date: today,
        clock_in: null,
        clock_out: null,
        status,
        punches: [],
        employees: empMap[employeeId] || null,
      });
    }

    const present = records.filter(r => r.status === 'present').length;
    const late = records.filter(r => r.status === 'late').length;
    const absent = records.filter(r => r.status === 'absent').length;
    const scheduled = records.filter(r => r.status === 'scheduled').length;

    res.json({
      date: today,
      total_employees: totalEmployees?.length || 0,
      scheduled_count: scheduledEmployeeIds.length,
      present,
      late,
      absent,
      scheduled,
      records,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─── punch endpoints (web dashboard buttons) ───────────────────────────────

export async function clockIn(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = todayDateString();
  const punchTime = new Date().toTimeString().slice(0, 8);

  try {
    const { attendance, punches } = await recordPunch({
      employee_id, date: today, punchTime,
      validateAction: action => action.meaning !== 'shift_start'
        ? `Already clocked in for today — next valid action is "${action.meaning}"`
        : null,
    });
    const empData = await fetchEmployeeSummary(employee_id);
    const payload = { ...attendance, employees: empData, punches };
    broadcastSseEvent('attendance:updated', { type: 'clock-in', record: payload, timestamp: new Date().toISOString() });
    res.status(201).json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, nextAction: err.nextAction });
    return handleError(res, err);
  }
}

export async function clockOut(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = todayDateString();
  const punchTime = new Date().toTimeString().slice(0, 8);

  try {
    const { attendance, punches } = await recordPunch({
      employee_id, date: today, punchTime,
      validateAction: action => {
        if (!action.punch_type) return 'No clock-in record found for today';
        if (!action.is_final) return `Employee still has "${action.meaning}" pending before final clock-out`;
        return null;
      },
    });
    const empData = await fetchEmployeeSummary(employee_id);
    const payload = { ...attendance, employees: empData, punches };
    broadcastSseEvent('attendance:updated', { type: 'clock-out', record: payload, timestamp: new Date().toISOString() });
    res.json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, nextAction: err.nextAction });
    return handleError(res, err);
  }
}

// ─── BREAKS ─────────────────────────────────────────────────────────────────

export async function breakStart(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = todayDateString();
  const punchTime = new Date().toTimeString().slice(0, 8);

  try {
    const { attendance, punches, action } = await recordPunch({
      employee_id, date: today, punchTime,
      validateAction: action => {
        if (!action.punch_type) return 'Employee has not clocked in today';
        if (action.punch_type !== 'out' || action.is_final) return `Next valid action is "${action.meaning}", not a break start`;
        return null;
      },
    });
    const empData = await fetchEmployeeSummary(employee_id);
    const payload = { ...attendance, employees: empData, punches };
    broadcastSseEvent('attendance:updated', { type: 'break-change', record: payload, timestamp: new Date().toISOString() });
    res.json({ breakType: action.break_type, record: payload });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, nextAction: err.nextAction });
    return handleError(res, err);
  }
}

export async function breakEnd(req, res) {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  const today = todayDateString();
  const punchTime = new Date().toTimeString().slice(0, 8);

  try {
    const { attendance, punches, action } = await recordPunch({
      employee_id, date: today, punchTime,
      validateAction: action => {
        if (!action.punch_type) return 'Employee has not clocked in today';
        if (action.punch_type !== 'in' || !action.break_type) return `Next valid action is "${action.meaning}", not a break end`;
        return null;
      },
    });
    const empData = await fetchEmployeeSummary(employee_id);
    const payload = { ...attendance, employees: empData, punches };
    broadcastSseEvent('attendance:updated', { type: 'break-change', record: payload, timestamp: new Date().toISOString() });
    res.json({ breakType: action.break_type, record: payload });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, nextAction: err.nextAction });
    return handleError(res, err);
  }
}

// ─── admin: manual create / bulk import / delete ────────────────────────────

export async function create(req, res) {
  const { employee_id, date, clock_in, clock_out, status, notes, lunch_start, lunch_end, coffee_start, coffee_end } = req.body;
  if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

  // Overnight-safe: see computeHoursWorked() above. A plain same-day Date
  // diff previously went negative for any shift crossing midnight
  // (e.g. clock_in 18:00, clock_out 03:00 -> was producing -11.03h).
  const hoursWorked = computeHoursWorked(clock_in, clock_out);

  const { data, error } = await supabase
    .from('attendance')
    .upsert([{
      employee_id, date, clock_in, clock_out, status: status || 'present', notes,
      hours_worked: hoursWorked, is_finalized: !!clock_out,
      lunch_start: lunch_start || null,
      lunch_end: lunch_end || null,
      coffee_start: coffee_start || null,
      coffee_end: coffee_end || null,
    }], { onConflict: 'employee_id,date' })
    .select()
    .single();

  if (error) return handleError(res, error);

  const empData = await fetchEmployeeSummary(employee_id);

  broadcastSseEvent('attendance:updated', {
    type: 'manual-create',
    record: { ...data, employees: empData || null },
    timestamp: new Date().toISOString(),
  });

  res.status(201).json({ ...data, employees: empData || null });
}

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
    // Overnight-safe: see computeHoursWorked() above.
    const hoursWorked = computeHoursWorked(r.clock_in, r.clock_out);
    return {
      employee_id: r.employee_id,
      date: r.date,
      clock_in: r.clock_in || null,
      clock_out: r.clock_out || null,
      status: r.status || 'present',
      notes: r.notes || null,
      hours_worked: hoursWorked,
      is_finalized: !!r.clock_out,
      lunch_start: r.lunch_start || null,
      lunch_end: r.lunch_end || null,
      coffee_start: r.coffee_start || null,
      coffee_end: r.coffee_end || null,
    };
  });

  const { data, error } = await supabase
    .from('attendance')
    .upsert(rows, { onConflict: 'employee_id,date' })
    .select();

  if (error) return handleError(res, error);

  const empIds = [...new Set(data.map(a => a.employee_id).filter(Boolean))];
  let empMap = {};
  if (empIds.length > 0) {
    const { data: employees, error: empLookupError } = await supabase
      .from('employees')
      .select('id, employee_id, name, department')
      .in('id', empIds);
    if (empLookupError) return handleError(res, empLookupError);
    empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));
  }

  const result = data.map(a => ({ ...a, employees: empMap[a.employee_id] || null }));

  broadcastSseEvent('attendance:updated', {
    type: 'bulk-import',
    records: result,
    timestamp: new Date().toISOString(),
  });

  res.status(201).json({ imported: data.length, records: result });
}

// ─── PASSWORD-PROTECTED EXCEL EXPORT ───────────────────────────────────────

export async function exportExcel(req, res) {
  const { rows, password, filename } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to export' });
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'A password of at least 4 characters is required' });
  }

  try {
    const workbook = await XlsxPopulate.fromBlankAsync();
    const sheet = workbook.sheet(0).name('Attendance');

    const headers = Object.keys(rows[0]);
    headers.forEach((header, col) => {
      const cell = sheet.cell(1, col + 1);
      cell.value(header);
      cell.style({ bold: true });
    });

    rows.forEach((row, r) => {
      headers.forEach((header, c) => {
        sheet.cell(r + 2, c + 1).value(row[header] ?? '');
      });
    });

    headers.forEach((_, col) => sheet.column(col + 1).width(18));

    const buffer = await workbook.outputAsync({ password });

    const safeName = (filename || 'attendance_export.xlsx').replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (error) {
    return handleError(res, error);
  }
}

export async function remove(req, res) {
  const { error } = await supabase.from('attendance').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  broadcastSseEvent('attendance:updated', {
    type: 'delete',
    id: req.params.id,
    timestamp: new Date().toISOString(),
  });

  res.json({ message: 'Record deleted' });
}

// ─── DEVICE KIOSK (fingerprint, no buttons) ────────────────────────────────
// Every punch auto-detects its own meaning via the break-policy state
// machine — first punch of the day is IN, then alternating OUT/IN through
// each configured break, then a final OUT once all breaks are used.

export async function punch(req, res) {
  const { employee_id, client_timestamp } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

  let today = todayDateString();
  let punchTime = new Date().toTimeString().slice(0, 8);

  // Offline-queued punches replayed by the kiosk carry the REAL scan time
  // in client_timestamp ("YYYY-MM-DD HH:MM:SS" — see punchTimestampNow()
  // in the firmware). Previously this field was received but never read,
  // so every offline punch got stamped with whatever time the sync call
  // happened to land at, instead of the time the person actually scanned.
  // If the device's clock hadn't synced with NTP yet, client_timestamp
  // will instead be an "UNSYNCED-uptime-<seconds>s" string with no space
  // in it — that fails the split check below and safely falls through to
  // using "now", same as before.
  if (client_timestamp) {
    const [datePart, timePart] = client_timestamp.split(' ');
    if (datePart && timePart) {
      today = datePart;
      punchTime = timePart.length === 5 ? `${timePart}:00` : timePart;
    }
  }

  try {
    const { attendance, punches, action, duplicate } = await recordPunch({ employee_id, date: today, punchTime });
    const empData = await fetchEmployeeSummary(employee_id);
    const payload = { ...attendance, employees: empData, punches };

    if (duplicate) {
      // Nothing changed — don't broadcast, just tell the kiosk what state
      // the employee is already in so it can show the right message.
      return res.status(200).json({ action: action.meaning, ...payload });
    }

    const sseType = action.is_final ? 'clock-out' : (punches.length === 1 ? 'clock-in' : 'break-change');
    broadcastSseEvent('attendance:updated', { type: sseType, record: payload, timestamp: new Date().toISOString() });

    const statusCode = action.meaning === 'shift_start' ? 201 : 200;
    res.status(statusCode).json({ action: action.meaning, ...payload });
  } catch (err) {
    if (err.status) {
      // recordPunchLocked() throws 403 for two reasons: no shift scheduled
      // for the date, or an approved leave covering the date. Neither can
      // ever resolve by retrying — the missing shift/leave record won't
      // appear on its own. For a LIVE kiosk punch (no client_timestamp —
      // see punchAttendance() in the firmware, which never sends that
      // field) this is fine as-is: the employee sees "No shift today" on
      // the kiosk screen immediately and it's never queued.
      //
      // For an OFFLINE REPLAY (client_timestamp present — only
      // syncPendingPunches() sends it) this is different: nobody is
      // standing at the kiosk to see the error, and the firmware would
      // otherwise keep this line in pending_punches.csv and resend the
      // exact same request every SYNC_INTERVAL_MS forever. Log it to
      // unresolved_kiosk_punches for admin review and respond 422 so the
      // firmware treats it as resolved (see the HTTP 422 branch in
      // syncPendingPunches()) and drops it from the queue — the event
      // itself isn't lost, it just stops being auto-retried.
      const isTerminalValidationFailure = err.status === 403;
      if (isTerminalValidationFailure && client_timestamp) {
        const { error: logError } = await supabase.from('unresolved_kiosk_punches').insert([{
          employee_id,
          date: today,
          punch_time: punchTime,
          reason: err.message,
          device_client_timestamp: client_timestamp,
        }]);
        if (logError) {
          // Logging failed too — don't silently eat the punch by returning
          // 422 in that case, fall back to the old behavior (device keeps
          // retrying) so nothing is lost even though it's stuck.
          console.error('[punch] failed to log unresolved offline punch:', logError);
          return res.status(err.status).json({ error: err.message, nextAction: err.nextAction });
        }
        return res.status(422).json({ action: 'needs_review', error: err.message });
      }
      return res.status(err.status).json({ error: err.message, nextAction: err.nextAction });
    }
    return handleError(res, err);
  }
}

// ─── break policy config (admin) ───────────────────────────────────────────

export async function getBreakPolicyConfig(req, res) {
  const { data, error } = await supabase
    .from('break_policies')
    .select('*')
    .order('sequence', { ascending: true });
  if (error) return handleError(res, error);
  res.json(data);
}

export async function updateBreakPolicyConfig(req, res) {
  const { policies } = req.body; // [{ name, label, duration_minutes, sequence, active }]
  if (!Array.isArray(policies) || policies.length === 0) {
    return res.status(400).json({ error: 'policies array is required' });
  }

  // Guard rail: `name` must map to a real attendance column (see
  // BREAK_COLUMN_MAP above) or clock-out will fail with a schema-cache
  // error the next time this break is used. Reject the save early instead.
  const badNames = policies.map(p => p.name).filter(name => !BREAK_COLUMN_MAP[name]);
  if (badNames.length > 0) {
    return res.status(400).json({
      error: `Invalid break policy name(s): ${badNames.join(', ')}. ` +
        `Allowed names: ${Object.keys(BREAK_COLUMN_MAP).join(', ')}.`,
    });
  }

  const { data, error } = await supabase
    .from('break_policies')
    .upsert(policies, { onConflict: 'name' })
    .select();
  if (error) return handleError(res, error);
  invalidateBreakPolicyCache();
  res.json(data);
}

// ─── unresolved offline punches (admin review) ─────────────────────────────
// Offline punches that failed with a terminal validation error (no shift /
// on leave) when replayed from a kiosk's SD queue land here instead of
// being retried forever or silently dropped — see the punch() catch block
// above. Needs a matching route registered, e.g.:
//   router.get('/unresolved-kiosk-punches', getUnresolvedKioskPunches);
//   router.delete('/unresolved-kiosk-punches/:id', dismissUnresolvedKioskPunch);

export async function getUnresolvedKioskPunches(req, res) {
  const { data, error } = await supabase
    .from('unresolved_kiosk_punches')
    .select('*, employees(name, employee_id, department)')
    .order('created_at', { ascending: false });
  if (error) return handleError(res, error);
  res.json(data);
}

// Admin has looked at it and either fixed the underlying issue manually
// (e.g. added a backdated shift assignment + a manual attendance row via
// create()) or decided to write it off — either way, dismiss it from the
// review queue.
export async function dismissUnresolvedKioskPunch(req, res) {
  const { error } = await supabase
    .from('unresolved_kiosk_punches')
    .delete()
    .eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Dismissed' });
}

// ─── fingerprint enrollment sync ───────────────────────────────────────────

export async function pendingSync(req, res) {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });

  const { data: allEnrolled, error } = await supabase
    .from('employee_fingerprints')
    .select('employee_id, slot_label, device_id, template_data, employees(name)')
    .not('template_data', 'is', null);

  if (error) return handleError(res, error);

  const bySlot = {};
  for (const row of allEnrolled) {
    const key = `${row.employee_id}:${row.slot_label}`;
    if (!bySlot[key]) bySlot[key] = { employee_id: row.employee_id, slot_label: row.slot_label, name: row.employees.name, template_data: row.template_data, devices: [] };
    bySlot[key].devices.push(row.device_id);
  }

  const pending = Object.values(bySlot)
    .filter(entry => !entry.devices.includes(device_id))
    .map(({ employee_id, slot_label, name, template_data }) => ({ employee_id, slot_label, name, template_data }));

  res.json({ device_id, pending });
}

export async function registerSynced(req, res) {
  const { employee_id, slot_label, device_id, sensor_slot_id } = req.body;

  if (!employee_id || !slot_label || !device_id || sensor_slot_id === undefined) {
    return res.status(400).json({ error: 'employee_id, slot_label, device_id, sensor_slot_id are required' });
  }

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