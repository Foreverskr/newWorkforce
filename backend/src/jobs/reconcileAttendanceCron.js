// Nightly job: after all shifts for the day are long over, sweep for
// scheduled employees who never clocked in and mark them absent — so
// tomorrow morning's analytics/reports are already complete without anyone
// having to remember to click a button.
//
// Requires the `node-cron` package: npm install node-cron
//
// Wire this up once in your server entrypoint (e.g. index.js / server.js):
//
//   import './jobs/reconcileAttendanceCron.js';
//
// (import for the side effect of scheduling the job — no exports needed)

import cron from 'node-cron';
import { supabase } from '../config/supabase.js';

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

// "09:00:00" → "9:00 AM" — kept in sync with the same helper in the
// controller file so notes read identically whether an absence was written
// by a manual commit or by this nightly job.
function formatTime12h(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function buildAbsenceNote(shiftStart) {
  return shiftStart
    ? `No clock-in recorded for the scheduled ${formatTime12h(shiftStart)} shift. Status automatically set to Absent.`
    : `No clock-in recorded for the scheduled shift. Status automatically set to Absent.`;
}

// Same logic as buildReconciliationReport() in the controller, trimmed down
// to just what the cron needs (no preview buckets — it commits directly).
// Kept as a standalone copy so this job has no dependency on Express req/res.
async function reconcileDate(date) {
  const { data: scheduled, error: schedErr } = await supabase
    .from('shift_assignments')
    .select('employee_id, shift_templates:roles(start_time)')
    .eq('date', date)
    .eq('is_day_off', false)
    .not('role_id', 'is', null);
  if (schedErr) throw schedErr;
  if (!scheduled.length) return { date, marked_absent: 0 };

  const employeeIds = [...new Set(scheduled.map(s => s.employee_id))];

  const [{ data: attendance, error: attErr }, { data: leaves, error: leaveErr }] = await Promise.all([
    supabase.from('attendance').select('employee_id, clock_in').eq('date', date).in('employee_id', employeeIds),
    supabase.from('leaves').select('employee_id').eq('status', 'approved').lte('start_date', date).gte('end_date', date).in('employee_id', employeeIds),
  ]);
  if (attErr) throw attErr;
  if (leaveErr) throw leaveErr;

  const attendanceMap = Object.fromEntries((attendance || []).map(r => [r.employee_id, r]));
  const onLeave = new Set((leaves || []).map(r => r.employee_id));
  const now = getManilaNow();

  const toMark = [];
  for (const s of scheduled) {
    if (onLeave.has(s.employee_id)) continue;           // leave takes precedence — never overwrite
    const att = attendanceMap[s.employee_id];
    if (att?.clock_in) continue;                        // clocked in — nothing to do
    if (att && !att.clock_in) continue;                 // a row already exists with some other status — leave it alone

    const shiftStart = s.shift_templates?.start_time;
    if (date === now.date) {
      const deadline = minutesSinceMidnight(shiftStart) + DEFAULT_GRACE_MINUTES;
      if (shiftStart && now.minutes < deadline) continue; // grace period hasn't passed yet — too early to call it
    }
    // date < now.date (a past date the cron somehow hasn't caught yet) always qualifies

    toMark.push({
      employee_id: s.employee_id,
      date,
      status: 'absent',
      clock_in: null,
      clock_out: null,
      hours_worked: null,
      notes: buildAbsenceNote(shiftStart),
    });
  }

  if (toMark.length === 0) return { date, marked_absent: 0 };

  const { data, error } = await supabase.from('attendance').upsert(toMark, { onConflict: 'employee_id,date' }).select();
  if (error) throw error;
  return { date, marked_absent: data.length };
}

// Runs every night at 11:55 PM Asia/Manila — by then every shift template's
// start_time + grace period for TODAY has already passed, so it's safe to
// finalize today's date. Adjust the cron expression/timezone if your latest
// shift starts later than ~11:35 PM.
cron.schedule('55 23 * * *', async () => {
  const { date } = getManilaNow();
  try {
    const result = await reconcileDate(date);
    console.log(`[attendance-reconcile] ${date}: marked ${result.marked_absent} absent`);
  } catch (error) {
    console.error(`[attendance-reconcile] failed for ${date}:`, error);
  }
}, { timezone: 'Asia/Manila' });

// Exported for manual/testing use (e.g. a "run now" admin action, or unit
// tests) — the scheduled job above is the main entrypoint in production.
export { reconcileDate };