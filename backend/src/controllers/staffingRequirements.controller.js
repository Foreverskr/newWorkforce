import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

export async function listRequirements(req, res) {
  const { start_date, end_date } = req.query;
  const start = start_date || new Date().toISOString().split('T')[0];
  const end = end_date || start;

  let query = supabase
    .from('staffing_requirements')
    .select('*')
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true });

  const { data, error } = await query;
  if (error) return handleError(res, error);
  
  // 🟢 Manually fetch positions and roles to avoid cache errors
  const posIds = [...new Set(data.map(r => r.position_id))];
  const roleIds = [...new Set(data.map(r => r.shift_template_id))];
  
  const [{ data: positions }, { data: roles }] = await Promise.all([
    supabase.from('positions').select('*').in('id', posIds),
    supabase.from('roles').select('*').in('id', roleIds)
  ]);

  const posMap = Object.fromEntries((positions || []).map(p => [p.id, p]));
  const roleMap = Object.fromEntries((roles || []).map(r => [r.id, r]));

  const result = data.map(r => ({
    ...r,
    positions: posMap[r.position_id] || null,
    roles: roleMap[r.shift_template_id] || null
  }));

  res.json(result);
}

export async function createRequirement(req, res) {
  const { position_id, shift_template_id, date, required_count, notes } = req.body;
  if (!position_id || !shift_template_id || !date || !required_count) {
    return res.status(400).json({ error: 'position_id, shift_template_id, date, and required_count (>= 1) are required' });
  }
  if (required_count < 1) {
    return res.status(400).json({ error: 'required_count must be at least 1 — delete the requirement instead of setting it to 0' });
  }

  const { data, error } = await supabase
    .from('staffing_requirements')
    .upsert([{
      position_id,
      shift_template_id,
      date,
      required_count,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    }], { onConflict: 'position_id,shift_template_id,date' })
    .select()
    .single();
  if (error) return handleError(res, error);
  res.status(201).json(data);
}

export async function createRecurringRequirement(req, res) {
  const { position_id, shift_template_id, start_date, end_date, days_of_week, required_count, notes } = req.body;
  if (!position_id || !shift_template_id || !start_date || !end_date || !Array.isArray(days_of_week) || days_of_week.length === 0 || !required_count) {
    return res.status(400).json({ error: 'position_id, shift_template_id, start_date, end_date, days_of_week[], and required_count (>= 1) are required' });
  }
  if (required_count < 1) return res.status(400).json({ error: 'required_count must be at least 1' });

  const dowSet = new Set(days_of_week.map(Number));
  const dates = [];
  const cur = new Date(start_date);
  const end = new Date(end_date);
  while (cur <= end) {
    if (dowSet.has(cur.getDay())) dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  if (dates.length === 0) return res.status(400).json({ error: 'No matching dates found for the given days_of_week in that range' });

  const records = dates.map(date => ({
    position_id,
    shift_template_id,
    date,
    required_count,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('staffing_requirements')
    .upsert(records, { onConflict: 'position_id,shift_template_id,date' })
    .select();
  if (error) return handleError(res, error);
  res.status(201).json({ created: data.length, requirements: data });
}

export async function updateRequirement(req, res) {
  const { required_count, notes } = req.body;
  if (required_count === undefined && notes === undefined) {
    return res.status(400).json({ error: 'Nothing to update — provide required_count and/or notes' });
  }
  const update = { updated_at: new Date().toISOString() };
  if (required_count !== undefined) {
    if (required_count < 1) return res.status(400).json({ error: 'required_count must be at least 1' });
    update.required_count = required_count;
  }
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await supabase
    .from('staffing_requirements')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return handleError(res, error);
  res.json(data);
}

export async function deleteRequirement(req, res) {
  // 🟢 CASCADE: fetch the requirement first so we know which assignments it maps to.
  // shift_assignments doesn't get staffing_requirement_id populated in practice
  // (createAssignment matches by role_id/position/date), so we match the same way here.
  const { data: requirement, error: fetchErr } = await supabase
    .from('staffing_requirements')
    .select('id, position_id, shift_template_id, date')
    .eq('id', req.params.id)
    .single();
  if (fetchErr) return handleError(res, fetchErr);

  // Resolve position_id -> name manually (assignments store position as text, not position_id)
  const { data: position } = await supabase
    .from('positions')
    .select('name')
    .eq('id', requirement.position_id)
    .single();

  const { error } = await supabase.from('staffing_requirements').delete().eq('id', req.params.id);
  if (error) return handleError(res, error);

  let removedAssignments = [];
  if (position?.name) {
    const { data: deleted, error: delAsgErr } = await supabase
      .from('shift_assignments')
      .delete()
      .eq('role_id', requirement.shift_template_id)
      .eq('date', requirement.date)
      .eq('position', position.name)
      .eq('is_day_off', false)
      .select('id, employee_id');
    if (delAsgErr) return handleError(res, delAsgErr);
    removedAssignments = deleted || [];
  }

  res.json({
    message: 'Staffing requirement removed',
    removed_assignments_count: removedAssignments.length,
    removed_assignments: removedAssignments,
  });
}

export async function getCoverage(req, res) {
  const { start_date, end_date } = req.query;
  const start = start_date || new Date().toISOString().split('T')[0];
  const end = end_date || start;

  // 1. Get Requirements
  const { data: requirements, error: reqErr } = await supabase
    .from('staffing_requirements')
    .select('*')
    .gte('date', start)
    .lte('date', end);
  if (reqErr) return handleError(res, reqErr);

  // 2. Fetch Positions for Requirements
  const posIds = [...new Set(requirements.map(r => r.position_id))];
  const { data: positions } = await supabase.from('positions').select('*').in('id', posIds);
  const posMap = Object.fromEntries((positions || []).map(p => [p.id, p]));

  // 3. Fetch Roles for Requirements
  const roleIds = [...new Set(requirements.map(r => r.shift_template_id))];
  const { data: roles } = await supabase.from('roles').select('*').in('id', roleIds);
  const roleMap = Object.fromEntries((roles || []).map(r => [r.id, r]));

  // 4. Get Assignments
  const { data: assignments, error: asgErr } = await supabase
    .from('shift_assignments')
    .select('employee_id, date, role_id, position')
    .eq('is_day_off', false)
    .gte('date', start)
    .lte('date', end);
  if (asgErr) return handleError(res, asgErr);

  // 5. Get Employee Data for Assignments
  const empIds = [...new Set(assignments.map(a => a.employee_id))];
  const { data: employees } = await supabase.from('employees').select('id, name, position').in('id', empIds);
  const empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));

  // 6. Map Assignments by Key (Position Name + Role ID + Date)
  const key = (posName, roleId, date) => `${posName}|${roleId}|${date}`;
  const assignedByKey = {};
  for (const a of assignments || []) {
    const emp = empMap[a.employee_id];
    const posName = a.position || emp?.position; // Use assignment position, or fallback to employee position
    if (!posName || !a.role_id) continue;
    const k = key(posName, a.role_id, a.date);
    (assignedByKey[k] ||= []).push({ id: a.employee_id, name: emp?.name });
  }

  // 7. Calculate Coverage
  const coverage = (requirements || []).map(r => {
    const posName = posMap[r.position_id]?.name;
    if (!posName) return { ...r, positions: null, roles: null, assigned_count: 0, assigned_employees: [], gap: r.required_count, status: 'understaffed' };

    const k = key(posName, r.shift_template_id, r.date);
    const assigned = assignedByKey[k] || [];
    const gap = r.required_count - assigned.length;
    return {
      ...r,
      positions: posMap[r.position_id] || null,
      roles: roleMap[r.shift_template_id] || null,
      assigned_count: assigned.length,
      assigned_employees: assigned,
      gap,
      status: gap > 0 ? 'understaffed' : gap < 0 ? 'overstaffed' : 'full',
    };
  }).sort((a, b) => (a.date === b.date ? (a.positions?.name || '').localeCompare(b.positions?.name || '') : a.date.localeCompare(b.date)));

  const totals = {
    total_required: coverage.reduce((s, c) => s + c.required_count, 0),
    total_assigned: coverage.reduce((s, c) => s + c.assigned_count, 0),
    understaffed_slots: coverage.filter(c => c.status === 'understaffed').length,
  };

  res.json({ coverage, totals });
}