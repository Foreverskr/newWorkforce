import { useState, useEffect } from 'react';
import { LogIn, LogOut, User } from 'lucide-react';
import { api } from '../lib/api';
import { format } from 'date-fns';

export default function ClockPage({ onToast }) {
  const [employees, setEmployees] = useState([]);
  const [selected, setSelected] = useState('');
  const [todayRecord, setTodayRecord] = useState(null);
  const [todaySchedule, setTodaySchedule] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.getEmployees().then(d => setEmployees(d.filter(e => e.status === 'active')));
  }, []);

  useEffect(() => {
    if (!selected) { setTodayRecord(null); setTodaySchedule(null); return; }
    setChecking(true);
    const today = new Date().toISOString().split('T')[0];
    Promise.all([
      api.getAttendance({ employee_id: selected, date: today }),
      api.getSchedule({ employee_id: selected, start_date: today, end_date: today }),
    ])
      .then(([attendance, schedule]) => {
        setTodayRecord(attendance[0] || null);
        setTodaySchedule(schedule[0] || null);
      })
      .catch(() => { setTodayRecord(null); setTodaySchedule(null); })
      .finally(() => setChecking(false));
  }, [selected]);

  // Only an admin-assigned working shift permits a clock-in — no row at all
  // (never scheduled) and an explicit day-off row are both treated as "not
  // scheduled to work today". Mirrors the check enforced server-side.
  // NOTE: getSchedule returns the raw shift_assignments row, whose FK column
  // is `role_id` (aliased separately as `shift_templates` for the joined
  // template details) — there is no `shift_template_id` field in the response.
  const hasShiftToday = !!(todaySchedule && !todaySchedule.is_day_off && todaySchedule.role_id);

  const handleClock = async (action) => {
    if (!selected) return;
    setLoading(true);
    try {
      if (action === 'in') {
        const r = await api.clockIn(selected);
        setTodayRecord(r);
        onToast(`Clocked in successfully at ${r.clock_in}`, 'success');
      } else {
        const r = await api.clockOut(selected);
        setTodayRecord(r);
        onToast(`Clocked out at ${r.clock_out} — ${r.hours_worked}h worked`, 'success');
      }
    } catch (e) {
      onToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const emp = employees.find(e => e.id === selected);
  const canClockIn = selected && !todayRecord?.clock_in && hasShiftToday;
  const canClockOut = selected && todayRecord?.clock_in && !todayRecord?.clock_out;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 60px)' }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Clock In / Out</h2>
          <p className="text-dim" style={{ marginTop: 8 }}>{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>

        <div className="card">
          {/* Employee select */}
          <div className="form-group" style={{ marginBottom: 28 }}>
            <label>Select Employee</label>
            <select value={selected} onChange={e => setSelected(e.target.value)}>
              <option value="">— Choose an employee —</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.name} · {e.employee_id}</option>
              ))}
            </select>
          </div>

          {/* Status */}
          {emp && !checking && (
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '16px 20px', marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div className="avatar" style={{ width: 42, height: 42, fontSize: 14 }}>
                  {emp.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2)}
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>{emp.name}</div>
                  <div className="text-dim text-sm">{emp.department} · {emp.position}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <div className="text-dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Shift</div>
                  <div className="mono" style={{ fontSize: 12 }}>{emp.shift_start} – {emp.shift_end}</div>
                </div>
                <div>
                  <div className="text-dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Clock In</div>
                  <div className="mono" style={{ fontSize: 12, color: todayRecord?.clock_in ? 'var(--green)' : 'var(--text-dim)' }}>
                    {todayRecord?.clock_in || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-dim" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Clock Out</div>
                  <div className="mono" style={{ fontSize: 12, color: todayRecord?.clock_out ? 'var(--accent)' : 'var(--text-dim)' }}>
                    {todayRecord?.clock_out || '—'}
                  </div>
                </div>
              </div>
              {todayRecord && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <span className={`badge ${todayRecord.status}`}>
                    <span className="badge-dot" /> {todayRecord.status}
                  </span>
                  {todayRecord.hours_worked && (
                    <span className="text-dim text-sm" style={{ marginLeft: 10 }}>
                      {todayRecord.hours_worked}h worked
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {emp && !checking && !hasShiftToday && !todayRecord?.clock_in && (
            <p className="text-dim text-sm" style={{ textAlign: 'center', marginBottom: 16 }}>
              ⚠️ No shift scheduled for today — contact your admin to get scheduled.
            </p>
          )}

          {/* Clock buttons */}
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
            <button
              className="clock-btn in"
              onClick={() => handleClock('in')}
              disabled={!canClockIn || loading}
              style={{ opacity: canClockIn ? 1 : 0.35, animation: canClockIn ? undefined : 'none' }}
            >
              <LogIn size={16} style={{ display: 'inline', marginRight: 8 }} />
              Clock In
            </button>
            <button
              className="clock-btn out"
              onClick={() => handleClock('out')}
              disabled={!canClockOut || loading}
              style={{ opacity: canClockOut ? 1 : 0.35, animation: canClockOut ? undefined : 'none' }}
            >
              <LogOut size={16} style={{ display: 'inline', marginRight: 8 }} />
              Clock Out
            </button>
          </div>

          {todayRecord?.clock_out && (
            <p className="text-dim text-sm" style={{ textAlign: 'center', marginTop: 16 }}>
              ✅ Shift complete for today
            </p>
          )}
        </div>
      </div>
    </div>
  );
}