import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

export function todayDateString(timeZone = 'Asia/Manila') {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

// ── Shift templates (roles table) ──
export async function listTemplates(req, res) {
  const { data, error } = await supabase
    .from('roles')
    .select('*')
    .order('start_time', { ascending: true });
  if (error) return handleError(res, error);
  res.json(data);
}

export async function createTemplate(req, res) {
  const { name, start_time, end_time, color } = req.body;
  if (!name || !start_time || !end_time) {
    return res.status(400).json({ error: 'name, start_time, and end_time are required' });
  }
  const { data, error } = await supabase
    .from('roles')
    .insert([{ name, start_time, end_time, color: color || '#3b82f6' }])
    .select()
    .single();
  if (error) return handleError(res, error);
  res.status(201).json(data);
}

export async function updateTemplate(req, res) {
  const { name, start_time, end_time, color } = req.body;
  const { data, error } = await supabase
    .from('roles')
    .update({ name, start_time, end_time, color })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return handleError(res, error);
  res.json(data);
}

export async function deleteTemplate(req, res) {
  const { error } = await supabase.from('roles').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Shift template deleted' });
}

// ── Schedule (shift assignments) ──
const ASSIGNMENT_SELECT = '*, shift_templates:roles(name, start_time, end_time, color)';

export async function getSchedule(req, res) {
  const { start_date, end_date, employee_id } = req.query;
  const start = start_date || new Date().toISOString().split('T')[0];
  const end = end_date || start;

  let query = supabase
    .from('shift_assignments')
    .select(ASSIGNMENT_SELECT)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true });
  if (employee_id) query = query.eq('employee_id', employee_id);

  const { data, error } = await query;
  if (error) return handleError(res, error);
  
  // 🟢 GHOST BUSTER: Filter out any rows with invalid/null employee_id BEFORE fetching names
  const validData = data.filter(a => a.employee_id && a.employee_id !== 'undefined' && a.employee_id !== 'null' && a.employee_id.trim() !== '');
  
  // 🟢 Fetch employee names separately (Expecting the ID stored in shift_assignments to be employees.id)
  const employeeIds = [...new Set(validData.map(a => a.employee_id))];
  let empMap = {};
  if (employeeIds.length > 0) {
    const { data: employees } = await supabase
      .from('employees')
      .select('id, name, employee_id, department, position')
      .in('id', employeeIds);
    empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));
  }

  // Attach the employee data manually
  const result = validData.map(a => ({
    ...a,
    employees: empMap[a.employee_id] || null
  }));

  res.json(result);
}

// 🟢 STAFFING GUARD: a staffing_requirements row must exist matching this
// employee's position for this shift_template_id + date, and it must not
// already be full. This applies to every position, including Driver — a
// shift/date with no requirement defined is blocked, not silently approved.
async function checkStaffingCapacity({ shift_template_id, date, employeePosition, employee_id }) {
  const { data: requirements, error: reqErr } = await supabase
    .from('staffing_requirements')
    .select('id, position_id, required_count')
    .eq('shift_template_id', shift_template_id)
    .eq('date', date);
  if (reqErr) return { error: reqErr };

  const posIds = [...new Set((requirements || []).map(r => r.position_id))];
  let posMap = {};
  if (posIds.length > 0) {
    const { data: positions } = await supabase.from('positions').select('id, name').in('id', posIds);
    posMap = Object.fromEntries((positions || []).map(p => [p.id, p.name]));
  }

  const matchingReq = (requirements || []).find(r => posMap[r.position_id] === employeePosition);
  if (!matchingReq) {
    return {
      blocked: `No staffing requirement exists for position "${employeePosition}" on this shift for ${date} — cannot assign. Add a staffing requirement first, or check the employee's position.`
    };
  }

  const { data: existingAssignments, error: countErr } = await supabase
    .from('shift_assignments')
    .select('employee_id')
    .eq('role_id', shift_template_id)
    .eq('date', date)
    .eq('position', employeePosition)
    .eq('is_day_off', false)
    .neq('employee_id', employee_id);
  if (countErr) return { error: countErr };

  const assignedCount = (existingAssignments || []).length;
  if (assignedCount >= matchingReq.required_count) {
    return {
      blocked: `Staffing requirement for "${employeePosition}" on this shift for ${date} is already full (${assignedCount}/${matchingReq.required_count}). Increase required_count or remove another assignment first.`
    };
  }

  return { ok: true };
}

// Dispatch to the capacity rule. Every position — including Driver — is
// governed by the staffing_requirements model, so a shift/date without a
// matching requirement is blocked rather than approved.
async function checkAssignmentCapacity({ shift_template_id, date, employeePosition, employee_id }) {
  return checkStaffingCapacity({ shift_template_id, date, employeePosition, employee_id });
}

export async function createAssignment(req, res) {
  const { employee_id, shift_template_id, date, notes, is_day_off } = req.body;
  const dayOff = !!is_day_off;

  // 🟢 HARDENED VALIDATION: Block empty strings and "undefined"
  // String(employee_id) avoids a TypeError if a client ever sends a non-string
  // (e.g. a number) — .trim() alone would throw before we get to respond 400.
  if (!employee_id || employee_id === 'undefined' || employee_id === 'null' || String(employee_id).trim() === '') {
    return res.status(400).json({ error: 'A valid employee_id is required.' });
  }

  if (!date || (!dayOff && !shift_template_id)) {
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
    if (leaveErr) return handleError(res, leaveErr);
    if (conflict) {
      const empName = conflict.employees?.name || 'This employee';
      return res.status(409).json({
        error: `${empName} is on approved ${conflict.type} leave from ${conflict.start_date} to ${conflict.end_date} — cannot assign a working shift on ${date} while that leave is active.`,
      });
    }
  }

  let employeePosition = null;
  if (!dayOff) {
    const { data: empData } = await supabase
      .from('employees')
      .select('position')
      .eq('id', employee_id)
      .single();
    employeePosition = empData?.position || null;
  }

  if (!dayOff && !employeePosition) {
    return res.status(400).json({
      error: `Cannot assign shift. The employee does not have a Position set. Please set their position in Employee Management first.`
    });
  }

  // 🟢 CAPACITY GUARD: Drivers use the simple one-per-shift rule; every other
  // position uses the staffing_requirements/positions capacity model.
  if (!dayOff) {
    const { error: capacityErr, blocked } = await checkAssignmentCapacity({
      shift_template_id,
      date,
      employeePosition,
      employee_id,
    });
    if (capacityErr) return handleError(res, capacityErr);
    if (blocked) return res.status(409).json({ error: blocked });
  }

  const { data, error } = await supabase
    .from('shift_assignments')
    .upsert([{
      employee_id,
      role_id: dayOff ? null : shift_template_id,
      position: dayOff ? null : employeePosition,
      date,
      notes,
      is_day_off: dayOff,
      updated_at: new Date().toISOString(),
    }], { onConflict: 'employee_id,date' })
    .select(ASSIGNMENT_SELECT)
    .single();
  if (error) return handleError(res, error);
  res.status(201).json(data);
}

export async function createRecurring(req, res) {
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
    if (leaveErr) return handleError(res, leaveErr);
    overlappingLeaves = leaveRows || [];
    const isOnApprovedLeave = (d) => overlappingLeaves.some(l => l.start_date <= d && d <= l.end_date);
    skipped = candidateDates.filter(isOnApprovedLeave);
    usableDates = candidateDates.filter(d => !isOnApprovedLeave(d));
  }

  if (usableDates.length === 0) {
    const empName = overlappingLeaves[0]?.employees?.name || 'This employee';
    const leaveDescriptions = overlappingLeaves.map(l => `${l.type} leave (${l.start_date} to ${l.end_date})`).join(', ');
    return res.status(400).json({
      error: `${empName} is on approved leave for every matching date — ${leaveDescriptions}.`
    });
  }

  let employeePosition = null;
  if (!dayOff) {
    const { data: empData } = await supabase
      .from('employees')
      .select('position')
      .eq('id', employee_id)
      .single();
    employeePosition = empData?.position || null;
    if (!employeePosition) {
      return res.status(400).json({ error: `Cannot assign recurring shift. Employee has no Position set.` });
    }
  }

  // 🟢 CAPACITY GUARD: batched across usableDates. Every position — including
  // Driver — requires a matching staffing_requirements row for the given
  // shift_template_id + date; dates with no matching requirement are skipped
  // rather than approved.
  let staffingSkipped = [];
  if (!dayOff) {
    const { data: requirements, error: reqErr } = await supabase
      .from('staffing_requirements')
      .select('id, position_id, required_count, date')
      .eq('shift_template_id', shift_template_id)
      .in('date', usableDates);
    if (reqErr) return handleError(res, reqErr);

    const posIds = [...new Set((requirements || []).map(r => r.position_id))];
    let posMap = {};
    if (posIds.length > 0) {
      const { data: positions } = await supabase.from('positions').select('id, name').in('id', posIds);
      posMap = Object.fromEntries((positions || []).map(p => [p.id, p.name]));
    }

    // one matching requirement per date, for this employee's position
    const reqByDate = {};
    for (const r of requirements || []) {
      if (posMap[r.position_id] === employeePosition) reqByDate[r.date] = r;
    }

    const { data: existingAssignments, error: countErr } = await supabase
      .from('shift_assignments')
      .select('employee_id, date')
      .eq('role_id', shift_template_id)
      .eq('position', employeePosition)
      .eq('is_day_off', false)
      .in('date', usableDates)
      .neq('employee_id', employee_id);
    if (countErr) return handleError(res, countErr);

    const countByDate = {};
    for (const a of existingAssignments || []) {
      countByDate[a.date] = (countByDate[a.date] || 0) + 1;
    }

    const stillUsable = [];
    for (const d of usableDates) {
      const req = reqByDate[d];
      if (!req) {
        staffingSkipped.push({ date: d, reason: `No staffing requirement for position "${employeePosition}"` });
        continue;
      }
      const assigned = countByDate[d] || 0;
      if (assigned >= req.required_count) {
        staffingSkipped.push({ date: d, reason: `Staffing requirement full (${assigned}/${req.required_count})` });
        continue;
      }
      stillUsable.push(d);
    }

    usableDates = stillUsable;

    if (usableDates.length === 0) {
      return res.status(400).json({
        error: `No dates available — every matching date is blocked by staffing requirements.`,
        skipped_leave: skipped,
        skipped_staffing: staffingSkipped,
      });
    }
  }

  const records = usableDates.map(date => ({
    employee_id,
    role_id: dayOff ? null : shift_template_id,
    position: dayOff ? null : employeePosition,
    date,
    notes: notes || null,
    is_day_off: dayOff,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('shift_assignments')
    .upsert(records, { onConflict: 'employee_id,date' })
    .select(ASSIGNMENT_SELECT);
  if (error) return handleError(res, error);
  res.status(201).json({ created: data.length, skipped, skipped_staffing: staffingSkipped, assignments: data });
}

export async function deleteAssignment(req, res) {
  const { error } = await supabase.from('shift_assignments').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Shift assignment removed' });
}

// ─── FLEET DRIVER REASSIGNMENT ───────────────────────────────────────────────
// Fleet drivers are employees with position = 'Driver'. This is entirely
// separate from the external `drivers` table (drivers.controller.js), which
// just tracks third-party drivers' license/trip status. Fleet drivers clock
// in/out and take leave like any employee.
//
// FLEET MODEL: a driver's role for a given date is read off that day's
// shift_assignments row rather than a fixed employee attribute, so when the
// admin reassigns who covers mornings/nights/reserve, the role moves with
// them automatically. There's no separate "reserve" flag on the employee —
// it's whoever is assigned that day to a shift template named Reserve /
// "Available Anytime". Drivers with NO shift assigned for the date (unfilled
// for the week, day off, not yet rostered) are 'unscheduled', not 'reserve' —
// with more than three drivers on the roster, "no shift today" is common and
// must not make every unscheduled driver look like an eligible replacement.
//
// A driver needs replacement if EITHER is true:
//   - attendance.status === 'absent' for today
//   - driver_availability === 'unavailable' (manual override, e.g. vehicle
//     issue, called out before clocking in, pulled for another task)
//   - on approved leave
//   - missed the clock-in grace window (default 20 min) after shift start
// A driver is available to cover a shift only if BOTH are true:
//   - clocked in today (attendance present/late)
//   - driver_availability === 'available'
//
// The Reserve Driver (whoever's on the "Available Anytime" shift for the
// date) is the ONLY eligible replacement — the admin picks them manually via
// the Replace/Override button (reassignDriver). Nothing gets assigned
// automatically on page load; autoAssignReserveCoverage/autoReassignDrivers
// below exist only as an explicit "auto-assign now" action, not something
// that runs implicitly when the roster is fetched.
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

    const shiftName = (shift?.shift_templates?.name || '').toLowerCase();
    const driverRole = (!shift || shift.is_day_off)
      ? 'unscheduled'
      : shiftName.includes('morning') ? 'morning'
      : shiftName.includes('night') ? 'night'
      : (shiftName.includes('reserve') || shiftName.includes('available anytime')) ? 'reserve'
      : 'other';

    let effectiveAvailability = 'not_available';
    let availabilityReason = 'Not scheduled';
    let canCoverWithoutCoverage;

    if (driverRole === 'reserve') {
      if (employee.status !== 'active') availabilityReason = 'Inactive employee';
      else if (onLeave.has(employee.id)) availabilityReason = 'On approved leave';
      else if (attendanceRecord?.status === 'absent') availabilityReason = 'Marked absent';
      else if (override) availabilityReason = override.reason || 'Manual operational override';
      else if (!attendanceRecord?.clock_in) availabilityReason = 'Not clocked in';
      else if (covering.has(employee.id)) availabilityReason = 'Already covering another driver';
      else { effectiveAvailability = 'available'; availabilityReason = 'Reserve driver on standby'; }

      // Clock-in is required here too, not just at assignment creation
      // (reassignDriver checks replAttendance?.clock_in) — otherwise deleting
      // an attendance record leaves a stale "Covered by X" badge, since
      // revalidateDriverCoverage reads can_cover_without_coverage from here.
      canCoverWithoutCoverage = employee.status === 'active' && !onLeave.has(employee.id) && attendanceRecord?.status !== 'absent' && !override && Boolean(attendanceRecord?.clock_in);
    } else if (driverRole === 'unscheduled') {
      if (employee.status !== 'active') availabilityReason = 'Inactive employee';
      else if (onLeave.has(employee.id)) availabilityReason = 'On approved leave';
      else availabilityReason = 'Not scheduled this week';

      canCoverWithoutCoverage = false;
    } else {
      if (employee.status !== 'active') availabilityReason = 'Inactive employee';
      else if (onLeave.has(employee.id)) availabilityReason = 'On approved leave';
      else if (attendanceRecord?.status === 'absent') availabilityReason = 'Absent';
      else if (override) availabilityReason = override.reason || 'Manual operational override';
      else if (covering.has(employee.id)) availabilityReason = 'Covering another driver';
      else if (attendanceRecord?.clock_out) availabilityReason = 'Clocked out';
      else if (missedClockIn) availabilityReason = `Missed clock-in deadline (${DRIVER_CLOCK_IN_GRACE_MINUTES} minutes)`;
      else if (clockedInLate) availabilityReason = `Clocked in after the ${DRIVER_CLOCK_IN_GRACE_MINUTES}-minute deadline`;
      else if (!attendanceRecord?.clock_in) availabilityReason = 'Not clocked in';
      else { effectiveAvailability = 'available'; availabilityReason = 'Clocked in and unassigned'; }

      canCoverWithoutCoverage = employee.status === 'active' && !onLeave.has(employee.id) && attendanceRecord?.status !== 'absent' && !override && Boolean(attendanceRecord?.clock_in) && !attendanceRecord?.clock_out && !clockedInLate;
    }

    const coverage = coverageByOriginal.get(employee.id);
    const needsReplacement = effectiveAvailability !== 'available' && Boolean(shift && !shift.is_day_off) && !covered.has(employee.id) && (onLeave.has(employee.id) || attendanceRecord?.status === 'absent' || Boolean(override) || missedClockIn || clockedInLate);
    return {
      ...employee,
      attendance_status: attendanceRecord?.status || 'no_record',
      clock_in: attendanceRecord?.clock_in || null,
      shift_name: shift?.shift_templates?.name || null,
      shift_start: shiftStart || null,
      driver_role: driverRole,
      effective_availability: effectiveAvailability,
      availability_reason: availabilityReason,
      needs_replacement: needsReplacement,
      can_cover: effectiveAvailability === 'available',
      can_cover_without_coverage: canCoverWithoutCoverage,
      coverage_status: coverage?.status || null,
      coverage_invalid_reason: coverage?.invalid_reason || null,
      replacement_name: coverage ? employeesById[coverage.replacement_employee_id]?.name || 'Unknown driver' : null,
    };
  });
}

async function autoAssignReserveCoverage(date) {
  const roster = await getDriverRoster(date);
  const reserve = roster.find(driver => driver.driver_role === 'reserve' && driver.can_cover);
  const assigned = [];

  for (const driver of roster) {
    if (!driver.needs_replacement) continue;
    if (!reserve || reserve.id === driver.id) continue;

    const { data: existing } = await supabase
      .from('employee_reassignments')
      .select('id')
      .eq('date', date)
      .eq('original_employee_id', driver.id)
      .eq('status', 'active')
      .maybeSingle();
    if (existing) continue;

    const { data, error } = await supabase
      .from('employee_reassignments')
      .insert([{
        date,
        original_employee_id: driver.id,
        replacement_employee_id: reserve.id,
        reason: driver.availability_reason,
        assigned_automatically: true,
      }])
      .select('id')
      .single();
    if (!error) assigned.push(data.id);
  }

  return assigned;
}

// ============================================================================
// ✅ FIXED: revalidateDriverCoverage function
// ============================================================================
// Uses can_cover property which is already computed by getDriverRoster()
// and includes all eligibility checks
// ============================================================================
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
    
    // Use can_cover_without_coverage, NOT can_cover, here.
    // can_cover is false whenever `covering` includes this employee — and
    // `covering` is built from this exact active coverage row, so a reserve
    // driver validating their own in-progress assignment would always read
    // as "already covering another driver" and get invalidated on every
    // revalidation pass. can_cover_without_coverage runs the same eligibility
    // checks (active status, not on leave, not absent, not overridden, and
    // for regular drivers: clocked in / not clocked out / not late) minus
    // that self-referential covering check.
    if (replacement?.can_cover_without_coverage) continue;  // ← Valid coverage, keep it active

    const reason = (replacement?.availability_reason && replacement.availability_reason !== 'Already covering another driver' && replacement.availability_reason !== 'Covering another driver')
      ? replacement.availability_reason
      : 'Replacement is no longer eligible to work';
    
    const { data, error: updateError } = await supabase
      .from('employee_reassignments')
      .update({ 
        status: 'invalid', 
        invalid_reason: reason, 
        invalidated_at: new Date().toISOString() 
      })
      .eq('id', coverage.id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    
    if (updateError) throw updateError;
    if (data) invalidated.push({ coverage_id: data.id, reason });
  }
  return invalidated;
}

export async function autoReassignDrivers(req, res) {
  try {
    const date = req.body?.date || getManilaNow().date;
    await revalidateDriverCoverage(date);
    const assignedIds = await autoAssignReserveCoverage(date);
    return res.json({ date, assigned: assignedIds.length, reassignment_ids: assignedIds });
  } catch (error) {
    return handleError(res, error);
  }
}

export async function getFleetDrivers(req, res) {
  try {
    const date = req.query.date || getManilaNow().date;
    await revalidateDriverCoverage(date);
    return res.json(await getDriverRoster(date));
  } catch (error) {
    return handleError(res, error);
  }
}

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

export async function getAvailableDrivers(req, res) {
  try {
    const date = req.query.date || getManilaNow().date;
    await revalidateDriverCoverage(date);
    const roster = await getDriverRoster(date);
    return res.json(roster.filter(driver => driver.driver_role === 'reserve' && driver.can_cover && driver.id !== req.query.exclude_employee_id));
  } catch (error) {
    return handleError(res, error);
  }
}

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

  if (availability === 'unavailable' && reason) {
    console.log(`Driver ${employee.id} marked unavailable for ${date}: ${reason}`);
  }

  res.json(data);
}

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

// ============================================================================
// ✅ FIXED: reassignDriver function
// ============================================================================
// Added check to prevent a replacement driver from covering multiple drivers
// on the same date (one driver can only cover one shift at a time)
// ============================================================================
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
  
  if (replacementState?.driver_role !== 'reserve') {
    return res.status(400).json({ error: 'Only the Reserve Driver (Available Anytime) can cover another driver\'s shift.' });
  }
  if (!replacementState?.can_cover) {
    return res.status(400).json({ error: `Reserve Driver is not eligible right now: ${replacementState?.availability_reason || 'not available'}` });
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

  // ✅ NEW CHECK: Prevent replacement from covering multiple drivers on same date
  const { data: replacementAlreadyCovering } = await supabase
    .from('employee_reassignments')
    .select('id, original_employee_id, original:original_employee_id(name)')
    .eq('date', date)
    .eq('replacement_employee_id', replacement_employee_id)
    .eq('status', 'active')
    .maybeSingle();

  if (replacementAlreadyCovering) {
    return res.status(409).json({ 
      error: `${replacementState?.name || 'This driver'} is already covering ${replacementAlreadyCovering.original?.name || 'another driver'} on ${date}. One driver cannot cover multiple shifts at the same time.`,
      already_covering: replacementAlreadyCovering
    });
  }

  // Check if the original driver already has coverage
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