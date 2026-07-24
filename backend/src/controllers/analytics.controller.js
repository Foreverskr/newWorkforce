import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

const PAGE_SIZE = 1000; // Supabase/PostgREST caps a single response at 1000 rows

// Fetches every attendance row in the date range, paging past Supabase's
// default 1000-row response cap so totals stay correct on wide date ranges.
async function fetchAllAttendance(start, end) {
  let all = [];
  let from = 0;

  while (true) {
    const { data, error, count } = await supabase
      .from('attendance')
      .select('status, hours_worked, date, employee_id, notes, employees(name, department)', { count: 'exact' })
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;

    all = all.concat(data);
    if (!data.length || all.length >= count) break;
    from += PAGE_SIZE;
  }

  return all;
}

export async function getSummary(req, res) {
  const { start_date, end_date } = req.query;
  const start = start_date || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const end = end_date || new Date().toISOString().split('T')[0];

  let data;
  try {
    data = await fetchAllAttendance(start, end);
  } catch (error) {
    return handleError(res, error);
  }

  const totalRecords = data.length;
  const present = data.filter(r => r.status === 'present').length;
  const late = data.filter(r => r.status === 'late').length;
  const absent = data.filter(r => r.status === 'absent').length;
  const excused = data.filter(r => r.status === 'absent' && r.notes?.includes('approved')).length;
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

  // Attendance by employee
  const empMap = {};
  data.forEach(r => {
    const empId = r.employee_id;
    if (!empId) return;

    if (!empMap[empId]) {
      empMap[empId] = {
        employee_id: empId,
        name: r.employees?.name || 'Unknown',
        department: r.employees?.department || 'Unknown',
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
        unexcused: 0,
        totalHours: 0,
        total: 0,
      };
    }

    const e = empMap[empId];
    if (r.status === 'present') {
      e.present++;
    } else if (r.status === 'late') {
      e.late++;
    } else if (r.status === 'absent') {
      e.absent++;
      if (r.notes?.includes('approved')) e.excused++;
      else e.unexcused++;
    }
    e.totalHours += r.hours_worked || 0;
    e.total++;
  });

  const byEmployee = Object.values(empMap)
    .map(e => ({
      ...e,
      totalHours: Number(e.totalHours.toFixed(1)),
      rate: e.total ? Math.round(((e.present + e.late) / e.total) * 100) : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Daily trend (last 14 days within range)
  const dailyMap = {};
  data.forEach(r => {
    if (!dailyMap[r.date]) dailyMap[r.date] = { present: 0, late: 0, absent: 0 };
    dailyMap[r.date][r.status] = (dailyMap[r.date][r.status] || 0) + 1;
  });

  res.json({
    period: { start, end },
    totals: { totalRecords, present, late, absent, excused, unexcused, totalHours: totalHours.toFixed(1) },
    byDepartment: Object.entries(deptMap).map(([dept, stats]) => ({ department: dept, ...stats })),
    byEmployee,
    dailyTrend: Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([date, stats]) => ({ date, ...stats })),
  });
}