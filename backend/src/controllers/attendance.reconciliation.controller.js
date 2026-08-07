import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

// ═════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═════════════════════════════════════════════════════════════════════════
// None of the existing attendance code ever writes status: 'absent'
// automatically. Attendance rows only get created by:
//   - clockIn() / punch()   → always 'present' or 'late'
//   - create() / bulkImport() → defaults to 'present' if no status given
//
// So a scheduled employee who never clocks in and is never manually logged
// gets ZERO attendance row for that date — not present, not absent, nothing.
// That means:
//   - analytics_controller undercounts absences (it only counts rows that
//     exist)
//   - getToday()'s `total_employees - present - late` guess overcounts
//     absences (it doesn't check who was actually scheduled)
//   - only Driver-position employees get a live no-show check, and even
//     that never writes back to `attendance`
//
// This file closes that gap with ONE reconciliation pass that:
//   1. Looks at who was actually SCHEDULED for a date (shift_assignments)
//   2. Compares against who actually has an attendance row
//   3. Flags the difference as a candidate absence, with a clear reason
//   4. Either just SHOWS you the list (dry run) or WRITES it (commit)
//
// Reusable for any position — not just drivers.
// ═════════════════════════════════════════════════════════════════════════

const DEFAULT_GRACE_MINUTES = Number(process.env.ATTENDANCE_GRACE_MINUTES || 20);

function getManilaNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, minutes: Number(v.hour) * 60 + Number(v.minute) };
}

function minutesSinceMidnight(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

// "09:00:00" → "9:00 AM" — used to keep notes readable for anyone viewing
// the timesheet (HR, employees), not just whoever's debugging the reconciler.
function formatTime12h(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// Builds the note stored on an auto-marked absence row. Kept factual and
// free of internal terms ("reconciler", "grace period", "cron") so it reads
// cleanly on a timesheet an employee or HR might see.
function buildAbsenceNote(shiftStart) {
  return shiftStart
    ? `No clock-in recorded for the scheduled ${formatTime12h(shiftStart)} shift. Status automatically set to Absent.`
    : `No clock-in recorded for the scheduled shift. Status automatically set to Absent.`;
}

// ─────────────────────────────────────────────────────────────────────────
// STEP 1: figure out who SHOULD have worked on this date
// ─────────────────────────────────────────────────────────────────────────
async function getScheduledEmployees(date) {
  const { data, error } = await supabase
    .from('shift_assignments')
    .select('employee_id, role_id, shift_templates:roles(name, start_time)')
    .eq('date', date)
    .eq('is_day_off', false)
    .not('role_id', 'is', null);
  if (error) throw error;
  return data || [];
}

// ─────────────────────────────────────────────────────────────────────────
// STEP 2: who already HAS an attendance row, and who is on approved leave
// ─────────────────────────────────────────────────────────────────────────
async function getAttendanceMap(date, employeeIds) {
  if (employeeIds.length === 0) return {};
  const { data, error } = await supabase
    .from('attendance')
    .select('employee_id, status, clock_in')
    .eq('date', date)
    .in('employee_id', employeeIds);
  if (error) throw error;
  return Object.fromEntries((data || []).map(r => [r.employee_id, r]));
}

async function getApprovedLeaveSet(date, employeeIds) {
  if (employeeIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('leaves')
    .select('employee_id')
    .eq('status', 'approved')
    .lte('start_date', date)
    .gte('end_date', date)
    .in('employee_id', employeeIds);
  if (error) throw error;
  return new Set((data || []).map(r => r.employee_id));
}

// ─────────────────────────────────────────────────────────────────────────
// STEP 3: build the list of candidates — one clear reason per employee, so
// the output reads like a report, not raw rows.
// ─────────────────────────────────────────────────────────────────────────
async function buildReconciliationReport(date) {
  const scheduled = await getScheduledEmployees(date);
  const employeeIds = [...new Set(scheduled.map(s => s.employee_id))];

  const [attendanceMap, onLeave] = await Promise.all([
    getAttendanceMap(date, employeeIds),
    getApprovedLeaveSet(date, employeeIds),
  ]);

  // Employee details (name/department) fetched once, batched — matches the
  // pattern already used elsewhere in this codebase.
  let empMap = {};
  if (employeeIds.length > 0) {
    const { data: employees, error } = await supabase
      .from('employees')
      .select('id, name, employee_id, department, position')
      .in('id', employeeIds);
    if (error) throw error;
    empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));
  }

  const now = getManilaNow();
  const isToday = date === now.date;
  const isPastDate = date < now.date;

  const candidates = [];      // scheduled, no clock-in, past grace deadline → should be marked absent
  const stillPending = [];    // scheduled today, grace window hasn't passed yet → too early to call it
  const alreadyHandled = [];  // already has a status (present/late/absent) or clocked in
  const skippedOnLeave = [];  // scheduled but on approved leave (shouldn't normally happen — createAssignment blocks this — but this is a safety net for data written outside that path, e.g. leave approved after the shift was already assigned)

  for (const s of scheduled) {
    const emp = empMap[s.employee_id] || { name: 'Unknown', department: 'Unknown' };
    const attendance = attendanceMap[s.employee_id];
    const shiftStart = s.shift_templates?.start_time || null;
    const shiftName = s.shift_templates?.name || null;

    const entry = {
      employee_id: s.employee_id,
      name: emp.name,
      department: emp.department,
      position: emp.position,
      shift_name: shiftName,
      shift_start: shiftStart,
    };

    if (onLeave.has(s.employee_id)) {
      skippedOnLeave.push({ ...entry, reason: 'On approved leave — should not have an active shift assignment; flagging as a data inconsistency to review' });
      continue;
    }

    if (attendance?.clock_in) {
      alreadyHandled.push({ ...entry, reason: `Already clocked in (${attendance.status})` });
      continue;
    }

    if (attendance && !attendance.clock_in) {
      // A row exists (e.g. manually created or bulk-imported) but with no
      // clock-in — respect whatever status is already recorded rather than
      // overwriting it.
      alreadyHandled.push({ ...entry, reason: `Attendance row already exists with status "${attendance.status}"` });
      continue;
    }

    // No attendance row at all — the actual gap this file exists to catch.
    if (isPastDate) {
      candidates.push({ ...entry, reason: 'No clock-in recorded for a past scheduled date' });
      continue;
    }

    if (isToday) {
      const deadline = minutesSinceMidnight(shiftStart) + DEFAULT_GRACE_MINUTES;
      if (shiftStart && now.minutes >= deadline) {
        candidates.push({ ...entry, reason: `No clock-in — ${DEFAULT_GRACE_MINUTES}-min grace period after ${shiftStart} has passed` });
      } else {
        stillPending.push({ ...entry, reason: shiftStart ? `Shift starts ${shiftStart} — grace period not yet over` : 'No shift start time to check against yet' });
      }
      continue;
    }

    // Future date — nothing to reconcile yet.
    stillPending.push({ ...entry, reason: 'Scheduled for a future date' });
  }

  return {
    date,
    checked_at: new Date().toISOString(),
    summary: {
      total_scheduled: scheduled.length,
      to_mark_absent: candidates.length,
      still_pending: stillPending.length,
      already_handled: alreadyHandled.length,
      leave_conflicts: skippedOnLeave.length,
    },
    by_department: groupByDepartment(candidates),
    to_mark_absent: candidates,
    still_pending: stillPending,
    leave_conflicts: skippedOnLeave,
    // already_handled is intentionally left out of the default payload — it's
    // the "boring" bucket (people who did what they were supposed to do).
    // Pass ?verbose=true on the route to include it.
  };
}

function groupByDepartment(candidates) {
  const map = {};
  for (const c of candidates) {
    const dept = c.department || 'Unknown';
    if (!map[dept]) map[dept] = { department: dept, count: 0, employees: [] };
    map[dept].count++;
    map[dept].employees.push({ name: c.name, employee_id: c.employee_id, reason: c.reason });
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}

// ═════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════

// GET /attendance/reconcile/preview?date=2026-08-06
// Read-only. Shows exactly what WOULD be marked absent, grouped by
// department, with a plain-English reason per person. Nothing is written.
// This is the "easy to analyze" view — check this before ever calling commit.
export async function previewReconciliation(req, res) {
  const date = req.query.date || getManilaNow().date;
  try {
    const report = await buildReconciliationReport(date);
    if (req.query.verbose === 'true') {
      const scheduled = await getScheduledEmployees(date);
      const employeeIds = [...new Set(scheduled.map(s => s.employee_id))];
      const attendanceMap = await getAttendanceMap(date, employeeIds);
      report.already_handled_detail = Object.entries(attendanceMap).map(([id, a]) => ({ employee_id: id, ...a }));
    }
    res.json(report);
  } catch (error) {
    return handleError(res, error);
  }
}

// POST /attendance/reconcile/commit  { date, employee_ids? }
// Writes status: 'absent' rows for the reconciliation candidates.
// Pass employee_ids to only commit a subset (e.g. after an admin reviews
// the preview and excludes a couple of edge cases) — omit it to commit
// every candidate for the date.
export async function commitReconciliation(req, res) {
  const { date = getManilaNow().date, employee_ids } = req.body || {};

  let report;
  try {
    report = await buildReconciliationReport(date);
  } catch (error) {
    return handleError(res, error);
  }

  let toCommit = report.to_mark_absent;
  if (Array.isArray(employee_ids) && employee_ids.length > 0) {
    const allow = new Set(employee_ids);
    toCommit = toCommit.filter(c => allow.has(c.employee_id));
  }

  if (toCommit.length === 0) {
    return res.json({ date, marked_absent: 0, message: 'Nothing to commit.', report });
  }

  const rows = toCommit.map(c => ({
    employee_id: c.employee_id,
    date,
    status: 'absent',
    clock_in: null,
    clock_out: null,
    hours_worked: null,
    notes: buildAbsenceNote(c.shift_start),
  }));

  const { data, error } = await supabase
    .from('attendance')
    .upsert(rows, { onConflict: 'employee_id,date' })
    .select();
  if (error) return handleError(res, error);

  res.status(201).json({
    date,
    marked_absent: data.length,
    employees: toCommit.map(c => ({ employee_id: c.employee_id, name: c.name, department: c.department, reason: c.reason })),
  });
}

// POST /attendance/reconcile/run-range  { start_date, end_date }
// Convenience for backfilling a whole cutoff period at once — e.g. run this
// right before generating a getCutoffReport/getCutoffDetails so analytics
// aren't silently missing no-shows. Only touches PAST dates (never "today"
// or future, where the grace period hasn't necessarily passed).
export async function commitReconciliationRange(req, res) {
  const { start_date, end_date } = req.body || {};
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date and end_date are required' });
  }

  const today = getManilaNow().date;
  const dates = [];
  const cur = new Date(start_date);
  const end = new Date(Math.min(new Date(end_date), new Date(today) - 86400000)); // stop before today
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }

  const results = [];
  try {
    for (const date of dates) {
      const report = await buildReconciliationReport(date);
      if (report.to_mark_absent.length === 0) {
        results.push({ date, marked_absent: 0 });
        continue;
      }
      const rows = report.to_mark_absent.map(c => ({
        employee_id: c.employee_id,
        date,
        status: 'absent',
        clock_in: null,
        clock_out: null,
        hours_worked: null,
        notes: buildAbsenceNote(c.shift_start),
      }));
      const { data, error } = await supabase.from('attendance').upsert(rows, { onConflict: 'employee_id,date' }).select();
      if (error) throw error;
      results.push({ date, marked_absent: data.length });
    }
    res.json({
      start_date,
      end_date: dates[dates.length - 1] || start_date,
      total_marked_absent: results.reduce((sum, r) => sum + r.marked_absent, 0),
      by_date: results,
    });
  } catch (error) {
    return handleError(res, error);
  }
}