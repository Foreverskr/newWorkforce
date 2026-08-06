import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';
import { getWorkingDaysInRange } from '../utils/dateHelpers.js';

// Leave counting and auto-generated absence records respect each employee's
// ACTUAL rest days (shift_assignments.is_day_off) instead of hardcoding
// Sat/Sun — an employee scheduled Tue-Sat, for example, is correctly charged
// for a Saturday and not charged for their real Mon/Sun off. Falls back to
// the Sat/Sun assumption only for dates that have no schedule data at all.
// See utils/dateHelpers.js -> getWorkingDaysInRange.
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

export async function getAll(req, res) {
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
  if (error) return handleError(res, error);
  res.json(data);
}

export async function create(req, res) {
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

  if (error) return handleError(res, error);
  res.status(201).json(data);
}

// PATCH approve or reject a leave request
export async function updateStatus(req, res) {
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

  if (error) return handleError(res, error);

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
        role_id: null,          // 🟢 FIXED: changed from shift_template_id to role_id
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
}

// DELETE leave request — also removes any attendance/schedule rows that were
// auto-created by its approval, so deleting a leave doesn't leave orphaned
// "absent" records or phantom rest days behind with nothing to explain them.
export async function remove(req, res) {
  const { error: attCleanupErr } = await supabase.from('attendance').delete().eq('source_leave_id', req.params.id);
  if (attCleanupErr) console.error('Attendance cleanup error:', attCleanupErr.message);
  const { error: schedCleanupErr } = await supabase.from('shift_assignments').delete().eq('source_leave_id', req.params.id);
  if (schedCleanupErr) console.error('Schedule cleanup error:', schedCleanupErr.message);

  const { error } = await supabase.from('leaves').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);
  res.json({ message: 'Leave request deleted' });
}