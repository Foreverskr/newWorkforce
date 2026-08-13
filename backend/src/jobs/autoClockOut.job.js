// jobs/autoClockOut.js
//
// Server-side safety net for employees who forget their final clock-out.
// Runs on a schedule (independent of any browser tab) and finalizes any
// attendance record whose ASSIGNED shift (from shift_assignments, not the
// employee's default shift_start/shift_end) has already ended.
//
// Requires: npm install node-cron

import cron from 'node-cron';
import { supabase } from '../config/supabase.js';
import { broadcastSseEvent } from '../utils/sse.js';
import { getBreakPolicies, getNextAction, creditedBreakMinutes, minutesElapsedAcrossMidnight } from '../services/breakEngine.js';
import { todayDateString } from '../controllers/attendance.controller.js';

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Pure calendar-date arithmetic on the "YYYY-MM-DD" string itself — no
// timezone lookup needed here since we're just stepping the same date
// value back by one day, not asking "what day is it right now somewhere".
function previousDateString(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function getShiftForEmployee(employee_id, date) {
  const { data } = await supabase
    .from('shift_assignments')
    .select('id, is_day_off, role_id, shift_templates:roles(end_time)')
    .eq('employee_id', employee_id)
    .eq('date', date)
    .maybeSingle();
  return data;
}

export async function runAutoClockOut() {
  const today = todayDateString();
  const yesterday = previousDateString(today);
  const nowMinutes = timeToMinutes(new Date().toTimeString().slice(0, 5));

  // IMPORTANT: an overnight shift (e.g. 18:00 -> 03:00) is clocked in on
  // one calendar date but its attendance row only becomes eligible for
  // auto-clock-out AFTER midnight, once "today" has already rolled over
  // to the next date. Filtering strictly to `date = today` would make
  // that still-open row invisible forever the moment midnight passes —
  // this job would never be able to close it out. Pulling both `today`
  // and `yesterday` covers a still-open row regardless of which side of
  // midnight we're currently on; the shift-end comparison below (which
  // already handles the day rollover per-employee) decides whether it's
  // actually time to close each one.
  const { data: openAttendance, error } = await supabase
    .from('attendance')
    .select('id, employee_id, date, clock_in')
    .in('date', [yesterday, today])
    .eq('is_finalized', false)
    .not('clock_in', 'is', null);

  if (error) {
    console.error('[autoClockOut] failed to fetch open attendance', error);
    return;
  }
  if (!openAttendance || openAttendance.length === 0) return;

  const policies = await getBreakPolicies();

  for (const att of openAttendance) {
    try {
      // Look up the shift assigned for the date the employee actually
      // clocked in on (att.date) — NOT the outer `today` — since a
      // yesterday-dated row was scheduled against yesterday's shift
      // assignment, not today's.
      const todaysShift = await getShiftForEmployee(att.employee_id, att.date);
      const shiftEnd = todaysShift?.shift_templates?.end_time;
      if (!shiftEnd) continue; // no assigned shift end on record — nothing to auto-close against

      // Overnight-safe "has the shift ended?" check. Plain
      // `nowMinutes < shiftEndMinutes` breaks for any shift crossing
      // midnight (e.g. 19:00 → 03:00): at 13:23 this afternoon,
      // 03:00 looks numerically "in the past" even though the shift's
      // real end is tomorrow's 3am, not today's — which was causing
      // employees to get force-clocked-out mid-afternoon with a negative
      // duration. Anchor everything to the employee's actual clock-in
      // time so "now" and "shift end" are compared on the same timeline.
      const clockInMinutes = timeToMinutes(att.clock_in.slice(0, 5));
      let shiftEndMinutes = timeToMinutes(shiftEnd.slice(0, 5));
      const isOvernight = shiftEndMinutes <= clockInMinutes;
      if (isOvernight) shiftEndMinutes += 24 * 60;

      // If att.date is yesterday relative to `today`, the wall-clock
      // "now" has already crossed one midnight relative to their
      // clock-in, on top of whatever the shift's own overnight rollover
      // adds. Add that day back in so effectiveNowMinutes and
      // shiftEndMinutes stay on the same timeline.
      let effectiveNowMinutes = nowMinutes + (att.date === yesterday ? 24 * 60 : 0);
      if (isOvernight && effectiveNowMinutes < clockInMinutes) effectiveNowMinutes += 24 * 60;

      if (effectiveNowMinutes < shiftEndMinutes) continue; // shift hasn't ended yet

      const shiftEndTime = shiftEnd.length === 5 ? `${shiftEnd}:00` : shiftEnd;

      const { data: existingPunches, error: punchFetchError } = await supabase
        .from('attendance_punches')
        .select('*')
        .eq('attendance_id', att.id)
        .order('sequence', { ascending: true });
      if (punchFetchError) throw punchFetchError;

      let punches = existingPunches || [];
      let nextSeq = punches.length + 1;

      // If they're mid-break when the shift ends, close that break first —
      // at the shift-end time, never a fabricated earlier return time —
      // then continue to the final OUT below. Previous punches are untouched.
      let action = getNextAction(punches, policies);
      if (action.punch_type === 'in' && action.break_type) {
        const { data: breakCloser, error: breakCloseError } = await supabase
          .from('attendance_punches')
          .insert([{
            attendance_id: att.id,
            sequence: nextSeq,
            punch_type: 'in',
            punch_time: shiftEndTime,
            break_type: action.break_type,
            is_final: false,
            is_automatic: true,
          }])
          .select()
          .single();
        if (breakCloseError) throw breakCloseError;
        punches = [...punches, breakCloser];
        nextSeq += 1;
      }

      const { data: finalPunch, error: finalPunchError } = await supabase
        .from('attendance_punches')
        .insert([{
          attendance_id: att.id,
          sequence: nextSeq,
          punch_type: 'out',
          punch_time: shiftEndTime,
          break_type: null,
          is_final: true,
          is_automatic: true,
        }])
        .select()
        .single();
      if (finalPunchError) throw finalPunchError;
      punches = [...punches, finalPunch];

      const firstIn = punches[0];
      const grossMinutes = minutesElapsedAcrossMidnight(firstIn.punch_time, shiftEndTime);
      const credited = creditedBreakMinutes(punches, policies);
      const netMinutes = grossMinutes - credited;

      const { data: updated, error: updateError } = await supabase
        .from('attendance')
        .update({
          clock_out: shiftEndTime,
          hours_worked: parseFloat((grossMinutes / 60).toFixed(2)),
          break_minutes: credited,
          net_hours_worked: parseFloat((netMinutes / 60).toFixed(2)),
          is_finalized: true,
          auto_clock_out: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', att.id)
        .select()
        .single();
      if (updateError) throw updateError;

      broadcastSseEvent('attendance:updated', {
        type: 'auto-clock-out',
        record: { ...updated, punches },
        timestamp: new Date().toISOString(),
      });

      console.log(`[autoClockOut] finalized attendance ${att.id} (date ${att.date}) for employee ${att.employee_id} at ${shiftEndTime}`);
    } catch (err) {
      console.error(`[autoClockOut] failed for attendance ${att.id}`, err);
      // continue to the next employee — one failure shouldn't block the batch
    }
  }
}

// Runs every 5 minutes. Adjust the cron expression if you want tighter/looser timing.
export function scheduleAutoClockOut() {
  cron.schedule('*/5 * * * *', () => {
    runAutoClockOut().catch(err => console.error('[autoClockOut] unhandled error', err));
  });
  console.log('[autoClockOut] scheduled — running every 5 minutes');
}