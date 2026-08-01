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

// 🟢 STAFFING GUARD: Check that (a) a staffing_requirements row exists matching this
// employee's position for this shift_template_id + date, and (b) it isn't already full.
// Manual fetch + in-JS join, same pattern as staffingrequirements.controller.js — avoids
// relying on PostgREST relationship embedding for position_id (no FK declared for it).
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

export async function createAssignment(req, res) {
  const { employee_id, shift_template_id, date, notes, is_day_off } = req.body;
  const dayOff = !!is_day_off;

  // 🟢 HARDENED VALIDATION: Block empty strings and "undefined"
  if (!employee_id || employee_id === 'undefined' || employee_id === 'null' || employee_id.trim() === '') {
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

  // 🟢 STAFFING GUARD: enforce position match + capacity against staffing_requirements
  if (!dayOff) {
    const { error: staffingErr, blocked } = await checkStaffingCapacity({
      shift_template_id,
      date,
      employeePosition,
      employee_id,
    });
    if (staffingErr) return handleError(res, staffingErr);
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

  // 🟢 STAFFING GUARD: batched position-match + capacity check across usableDates
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