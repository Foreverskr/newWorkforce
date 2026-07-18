import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

// Two tables: shift_templates (reusable, e.g. "Morning Shift" 06:00-14:00) and
// shift_assignments (which employee has which template on which specific date —
// one row per employee per day; UNIQUE(employee_id, date) prevents double-booking).
// Recurring assignment ("Mon/Wed/Fri") is NOT stored as a recurrence rule — it's
// expanded server-side into individual date rows via createRecurring below.
// This keeps lookups simple (no rule evaluation) and lets each day be edited or
// removed independently without touching a pattern that affects other days.
//
// NOTE: unrelated to employees.shift_start/shift_end, which is just a default
// used only for the late/present clock-in check in attendance.controller.js —
// this is the real roster.

// ── Shift templates ──

export async function listTemplates(req, res) {
  const { data, error } = await supabase
    .from('shift_templates')
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
    .from('shift_templates')
    .insert([{ name, start_time, end_time, color: color || '#3b82f6' }])
    .select()
    .single();
  if (error) return handleError(res, error);
  res.status(201).json(data);
}

export async function updateTemplate(req, res) {
  const { name, start_time, end_time, color } = req.body;
  const { data, error } = await supabase
    .from('shift_templates')
    .update({ name, start_time, end_time, color })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return handleError(res, error);
  res.json(data);
}

export async function deleteTemplate(req, res) {
  const { error } = await supabase.from('shift_templates').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Shift template deleted' });
}

// ── Schedule (shift assignments) ──
// A row can represent either a worked shift (shift_template_id set,
// is_day_off false) or an explicit rest day / day off (shift_template_id
// null, is_day_off true). This lets the UI distinguish "intentionally off"
// from "just hasn't been scheduled yet" (no row at all), instead of both
// looking like an empty cell.
//
// Requires this migration on the shift_assignments table:
//   alter table shift_assignments add column is_day_off boolean not null default false;
//   alter table shift_assignments alter column shift_template_id drop not null;

// GET assignments in a date range, optionally filtered by employee
export async function getSchedule(req, res) {
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
  if (error) return handleError(res, error);
  res.json(data);
}

// POST single assignment — upsert so re-assigning the same employee/date just replaces it.
// Pass is_day_off: true to mark an explicit rest day instead of a worked shift;
// shift_template_id is ignored (stored as null) in that case.
//
// Assigning an actual working shift (dayOff false) is blocked if the employee
// has an approved leave covering that date — otherwise a schedule change can
// silently contradict an already-approved leave (see leaves.controller.js,
// which syncs approved leave into shift_assignments as a rest day). Marking
// a day off is always allowed since it can't conflict with a leave.
export async function createAssignment(req, res) {
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
    if (leaveErr) return handleError(res, leaveErr);
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
  if (error) return handleError(res, error);
  res.status(201).json(data);
}

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
  if (error) return handleError(res, error);
  res.status(201).json({ created: data.length, skipped, assignments: data });
}

// DELETE a single assignment (e.g. remove one day from a recurring block)
export async function deleteAssignment(req, res) {
  const { error } = await supabase.from('shift_assignments').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Shift assignment removed' });
}
