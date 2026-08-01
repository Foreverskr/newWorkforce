import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

const PAGE_SIZE = 1000; // Supabase/PostgREST caps a single response at 1000 rows

// Fetches every attendance row in the date range, paging past Supabase's
// default 1000-row response cap so totals stay correct on wide date ranges.
async function fetchAllAttendance(start, end) {
  let all = [];
  let from = 0;
  let totalCount = 0;

  while (true) {
    const { data, error, count } = await supabase
      .from('attendance')
      .select('status, hours_worked, date, employee_id, notes', { count: 'exact' }) // Removed the 'employees' join
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;

    all = all.concat(data);
    totalCount = count || 0;
    if (!data.length || all.length >= totalCount) break;
    from += PAGE_SIZE;
  }

  // 🟢 MANUAL FETCH: Get employee names and departments separately
  const empIds = [...new Set(all.map(a => a.employee_id).filter(Boolean))];
  let empMap = {};
  if (empIds.length > 0) {
    // Match attendance.employee_id (UUID) against employees.id (UUID), not employees.employee_id (text)
    const { data: employees } = await supabase
      .from('employees')
      .select('id, name, department') 
      .in('id', empIds);
    empMap = Object.fromEntries((employees || []).map(e => [e.id, e]));
  }

  // Merge the data manually
  const result = all.map(r => ({
    ...r,
    employees: empMap[r.employee_id] || null
  }));

  return result;
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

// ============================================
// 🆕 CUTOFF PERIOD REPORTING (15-day cycles)
// ============================================

// Calculate 15-day cutoff periods (1-15, 16-end of month)
function getCutoffPeriods(year, month) {
  const firstCutoffStart = new Date(year, month, 1);
  const firstCutoffEnd = new Date(year, month, 15);
  
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  const secondCutoffStart = new Date(year, month, 16);
  const secondCutoffEnd = new Date(year, month, lastDayOfMonth);

  return [
    {
      period: `${year}-${String(month + 1).padStart(2, '0')}-01 to 15`,
      start: firstCutoffStart.toISOString().split('T')[0],
      end: firstCutoffEnd.toISOString().split('T')[0],
      cutoffNumber: 1
    },
    {
      period: `${year}-${String(month + 1).padStart(2, '0')}-16 to ${lastDayOfMonth}`,
      start: secondCutoffStart.toISOString().split('T')[0],
      end: secondCutoffEnd.toISOString().split('T')[0],
      cutoffNumber: 2
    }
  ];
}

// Calculate comprehensive statistics for a dataset
function calculateStats(data) {
  const totalRecords = data.length;
  const present = data.filter(r => r.status === 'present').length;
  const late = data.filter(r => r.status === 'late').length;
  const absent = data.filter(r => r.status === 'absent').length;
  const excused = data.filter(r => r.status === 'absent' && r.notes?.includes('approved')).length;
  const unexcused = absent - excused;
  const totalHours = data.reduce((sum, r) => sum + (r.hours_worked || 0), 0);
  const avgHoursPerDay = totalRecords > 0 ? totalHours / totalRecords : 0;

  return {
    totalRecords,
    present,
    late,
    absent,
    excused,
    unexcused,
    totalHours: Number(totalHours.toFixed(1)),
    avgHoursPerDay: Number(avgHoursPerDay.toFixed(1)),
    attendanceRate: totalRecords ? Math.round(((present + late) / totalRecords) * 100) : 0,
  };
}

// Get stats by department
function getByDepartment(data) {
  const deptMap = {};
  data.forEach(r => {
    const dept = r.employees?.department || 'Unknown';
    if (!deptMap[dept]) {
      deptMap[dept] = { present: 0, late: 0, absent: 0, total: 0, totalHours: 0 };
    }
    deptMap[dept][r.status] = (deptMap[dept][r.status] || 0) + 1;
    deptMap[dept].total++;
    deptMap[dept].totalHours += r.hours_worked || 0;
  });

  return Object.entries(deptMap).map(([dept, stats]) => ({
    department: dept,
    ...stats,
    totalHours: Number(stats.totalHours.toFixed(1)),
    attendanceRate: stats.total ? Math.round(((stats.present + stats.late) / stats.total) * 100) : 0,
  }));
}

// Get stats by employee
function getByEmployee(data) {
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

  return Object.values(empMap)
    .map(e => ({
      ...e,
      totalHours: Number(e.totalHours.toFixed(1)),
      avgHoursPerDay: e.total ? Number((e.totalHours / e.total).toFixed(1)) : 0,
      rate: e.total ? Math.round(((e.present + e.late) / e.total) * 100) : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Generate HR recommendations based on data
function generateRecommendations(data, employees) {
  const recommendations = [];

  // Check attendance rate
  const avgAttendance = employees.length > 0 
    ? Math.round(employees.reduce((sum, e) => sum + e.rate, 0) / employees.length)
    : 0;

  if (avgAttendance < 80) {
    recommendations.push({
      type: 'warning',
      message: `Average attendance rate is ${avgAttendance}%. Consider reviewing leave policies or scheduling.`,
    });
  }

  // Check for chronic absenteeism
  const chronicallyAbsent = employees.filter(e => e.unexcused >= 2);
  if (chronicallyAbsent.length > 0) {
    recommendations.push({
      type: 'critical',
      message: `${chronicallyAbsent.length} employee(s) have 2+ unexcused absences. HR follow-up recommended.`,
      employees: chronicallyAbsent.map(e => ({ name: e.name, unexcused: e.unexcused })),
    });
  }

  // Check for consistently late employees
  const frequently_late = employees.filter(e => e.late >= 3);
  if (frequently_late.length > 0) {
    recommendations.push({
      type: 'info',
      message: `${frequently_late.length} employee(s) were late 3+ times. Consider schedule review.`,
      employees: frequently_late.map(e => ({ name: e.name, late: e.late })),
    });
  }

  // Highlight top performers
  const topPerformers = employees.filter(e => e.rate === 100 && e.total >= 8);
  if (topPerformers.length > 0) {
    recommendations.push({
      type: 'positive',
      message: `${topPerformers.length} employee(s) have perfect attendance this cutoff.`,
      employees: topPerformers.map(e => ({ name: e.name, rate: e.rate })),
    });
  }

  return recommendations;
}

// 🆕 Get monthly cutoff report (both cutoff periods)
export async function getCutoffReport(req, res) {
  const { year, month } = req.query;
  
  const now = new Date();
  const reportYear = year ? parseInt(year) : now.getFullYear();
  const reportMonth = month ? parseInt(month) - 1 : now.getMonth(); // month is 0-indexed

  const cutoffs = getCutoffPeriods(reportYear, reportMonth);
  
  let cutoffReports = [];

  try {
    for (const cutoff of cutoffs) {
      const data = await fetchAllAttendance(cutoff.start, cutoff.end);
      const employees = getByEmployee(data);
      
      cutoffReports.push({
        cutoff: cutoff.period,
        cutoffNumber: cutoff.cutoffNumber,
        dateRange: { start: cutoff.start, end: cutoff.end },
        totals: calculateStats(data),
        byDepartment: getByDepartment(data),
        byEmployee: employees,
        summary: {
          topPerformers: employees
            .filter(e => e.total > 0)
            .sort((a, b) => b.rate - a.rate)
            .slice(0, 5),
          needsAttention: employees
            .filter(e => e.unexcused > 0 || e.rate < 70)
            .sort((a, b) => a.rate - b.rate),
        },
      });
    }

    res.json({
      month: `${reportYear}-${String(reportMonth + 1).padStart(2, '0')}`,
      generatedAt: new Date().toISOString(),
      cutoffs: cutoffReports,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// 🆕 Get specific cutoff period detailed report (with recommendations)
export async function getCutoffDetails(req, res) {
  const { year, month, cutoff } = req.query;

  if (!year || !month || !cutoff) {
    return res.status(400).json({ error: 'year, month, and cutoff parameters required' });
  }

  const reportYear = parseInt(year);
  const reportMonth = parseInt(month) - 1;
  const cutoffNumber = parseInt(cutoff);

  const cutoffs = getCutoffPeriods(reportYear, reportMonth);
  const selectedCutoff = cutoffs.find(c => c.cutoffNumber === cutoffNumber);

  if (!selectedCutoff) {
    return res.status(400).json({ error: 'Invalid cutoff number (1 or 2)' });
  }

  try {
    const data = await fetchAllAttendance(selectedCutoff.start, selectedCutoff.end);
    const employees = getByEmployee(data);

    res.json({
      cutoff: selectedCutoff.period,
      dateRange: { start: selectedCutoff.start, end: selectedCutoff.end },
      generatedAt: new Date().toISOString(),
      summary: calculateStats(data),
      byDepartment: getByDepartment(data),
      byEmployee: employees,
      recommendations: generateRecommendations(data, employees),
    });
  } catch (error) {
    return handleError(res, error);
  }
}