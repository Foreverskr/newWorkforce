import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

export async function getSummary(req, res) {
  const { start_date, end_date } = req.query;
  const start = start_date || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const end = end_date || new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('attendance')
    .select('status, hours_worked, date, employee_id, employees(name, department)')
    .gte('date', start)
    .lte('date', end);

  if (error) return handleError(res, error);

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
}
