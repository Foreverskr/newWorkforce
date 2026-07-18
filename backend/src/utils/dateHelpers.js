import { supabase } from '../config/supabase.js';

// Counts working (Mon-Fri) days strictly between two dates, exclusive of both
// endpoints. Used by the employee inactivity check to measure the gap since
// an employee's last attendance record.
export function countWorkingDaysBetween(fromDateExclusive, toDateExclusive) {
  let count = 0;
  const cur = new Date(fromDateExclusive);
  cur.setDate(cur.getDate() + 1);
  while (cur < toDateExclusive) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Returns the list of YYYY-MM-DD dates in [startDate, endDate] that count as
// working days for this employee: explicit shift_assignments data wins
// (is_day_off true/false for that exact date); any date with no row at all
// falls back to "not a weekend".
//
// Used by leave creation/approval (to count leave days and auto-generate
// absence records) and by the schedule recurring-assignment guard.
export async function getWorkingDaysInRange(employeeId, startDate, endDate) {
  const { data: rows, error } = await supabase
    .from('shift_assignments')
    .select('date, is_day_off')
    .eq('employee_id', employeeId)
    .gte('date', startDate)
    .lte('date', endDate);
  if (error) throw error;

  const known = new Map((rows || []).map(r => [r.date, r.is_day_off]));
  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }

  return dates.filter(d => {
    if (known.has(d)) return !known.get(d);
    const dow = new Date(d + 'T00:00:00').getDay();
    return dow !== 0 && dow !== 6;
  });
}
