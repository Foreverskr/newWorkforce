import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Users, UserCheck, UserX, Clock, RefreshCw, Search,
  TrendingUp, TrendingDown, Building2, Timer,
} from 'lucide-react';
import { api } from '../lib/api';
import { format } from 'date-fns';

function initials(name = '') {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

// Parses "HH:MM:SS" / "HH:MM" into minutes-since-midnight for sorting & averages.
function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToClock(mins) {
  if (mins == null) return '—';
  const total = Math.round(mins); // round once, on the combined value, so minutes never overflow to 60
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const STATUS_FILTERS = ['all', 'present', 'late', 'absent'];

// Animates a number counting up/down to its target whenever it changes —
// makes refreshes feel alive instead of numbers just snapping in place.
function useCountUp(target, duration = 500) {
  const [value, setValue] = useState(target);
  const fromRef = useState(() => ({ current: target }))[0];

  useEffect(() => {
    const from = fromRef.current;
    const to = target ?? 0;
    if (from === to) { setValue(to); return; }
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return value;
}

// Ticks once a second so "Updated Xs ago" stays live without re-fetching.
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function timeAgo(date, now) {
  if (!date) return null;
  const secs = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return format(date, 'HH:mm:ss');
}

export default function Dashboard() {
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');

  // Weekly trend is optional — only renders if your API exposes it.
  // Add `getWeeklyTrend(days)` to lib/api returning
  // [{ date: 'YYYY-MM-DD', present: n, late: n, absent: n, total: n }, ...]
  const [weekly, setWeekly] = useState(null);
  const [weeklyError, setWeeklyError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setToday(await api.getToday());
      setLastUpdated(new Date());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWeekly = useCallback(async () => {
    try {
      if (typeof api.getWeeklyTrend !== 'function') {
        setWeeklyError(true);
        return;
      }
      const data = await api.getWeeklyTrend(7);
      if (Array.isArray(data) && data.length) {
        setWeekly(data);
      } else {
        setWeeklyError(true);
      }
    } catch (e) {
      console.error(e);
      setWeeklyError(true);
    }
  }, []);

  useEffect(() => { load(); loadWeekly(); }, [load, loadWeekly]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const now = useNow(1000);

  const records = today?.records || [];
  const present = records.filter(r => r.status === 'present');
  const late = records.filter(r => r.status === 'late');
  const clockedOut = records.filter(r => r.clock_out);

  const totalEmployees = today?.total_employees ?? 0; // whole-company headcount

  // "Scheduled today" = employees who actually have a shift today. Records only
  // ever contain scheduled employees, so records.length is the true denominator
  // for attendance rate — NOT total_employees, which includes everyone on staff
  // regardless of whether they're rostered today. Prefer an explicit API field
  // if you add one (e.g. today.scheduled_count), falling back to records.length.
  const scheduledToday = today?.scheduled_count ?? today?.total_scheduled ?? records.length;

  const presentCount = present.length;
  const absentCount = records.filter(r => r.status === 'absent').length;
  const presentTotal = presentCount + late.length;
  const attendanceRate = scheduledToday ? Math.round((presentTotal / scheduledToday) * 100) : 0;
  const onTimeRate = presentTotal ? Math.round((presentCount / presentTotal) * 100) : 0;

  const avgClockIn = useMemo(() => {
    const mins = [...present, ...late].map(r => toMinutes(r.clock_in)).filter(m => m != null);
    if (!mins.length) return null;
    return mins.reduce((a, b) => a + b, 0) / mins.length;
  }, [present, late]);

  // Department breakdown, built from today's actual records — no invented data.
  const deptBreakdown = useMemo(() => {
    const map = new Map();
    for (const r of records) {
      const dept = r.employees?.department || 'Unassigned';
      if (!map.has(dept)) map.set(dept, { dept, present: 0, late: 0, absent: 0, total: 0 });
      const entry = map.get(dept);
      entry.total += 1;
      if (r.status === 'present') entry.present += 1;
      else if (r.status === 'late') entry.late += 1;
      else if (r.status === 'absent') entry.absent += 1;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [records]);

  const filteredRecords = useMemo(() => {
    return records
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .filter(r => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return r.employees?.name?.toLowerCase().includes(q)
          || r.employees?.department?.toLowerCase().includes(q);
      })
      .sort((a, b) => (toMinutes(a.clock_in) ?? 9999) - (toMinutes(b.clock_in) ?? 9999));
  }, [records, statusFilter, query]);

  // Animated counters — numbers glide to their new value instead of snapping.
  const totalEmployeesAnim = useCountUp(totalEmployees);
  const presentTotalAnim = useCountUp(presentTotal);
  const absentCountAnim = useCountUp(absentCount);
  const lateCountAnim = useCountUp(today?.late ?? 0);

  // Auto-generated callout: surfaces whichever department most needs eyes on
  // it right now, so the breakdown isn't just a static list to scan manually.
  const deptInsight = useMemo(() => {
    const withShifts = deptBreakdown.filter(d => d.total > 0);
    if (!withShifts.length) return null;
    const worst = [...withShifts].sort((a, b) => {
      const rateA = (a.present + a.late) / a.total;
      const rateB = (b.present + b.late) / b.total;
      return rateA - rateB;
    })[0];
    const rate = Math.round(((worst.present + worst.late) / worst.total) * 100);
    if (rate === 100) return null; // nothing to flag, everyone's in
    if (rate === 0) return { dept: worst.dept, text: `${worst.dept} has no one clocked in yet today (0 of ${worst.total}).`, severity: 'high' };
    return { dept: worst.dept, text: `${worst.dept} is lagging today — only ${rate}% clocked in.`, severity: rate < 50 ? 'high' : 'medium' };
  }, [deptBreakdown]);

  const isLive = autoRefresh && !loading;

  if (loading && !today) return <div className="loading"><div className="spinner" /> Loading dashboard…</div>;

  return (
    <div className="page">
      <style>{`
        .stat-card-clickable {
          transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease, background 0.15s ease;
          will-change: transform;
        }
        .stat-card-clickable:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
          background: var(--surface2, rgba(255, 255, 255, 0.03));
        }
        .stat-card-clickable:active {
          transform: translateY(0);
          box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
        }
        .stat-card-clickable:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .checkin-scroll {
          padding-right: 10px;
          margin-right: -10px;
          scrollbar-gutter: stable;
        }
        .checkin-scroll::-webkit-scrollbar { width: 6px; }
        .checkin-scroll::-webkit-scrollbar-track { background: transparent; }
        .checkin-scroll::-webkit-scrollbar-thumb {
          background: var(--border-subtle);
          border-radius: 3px;
        }
        .checkin-scroll::-webkit-scrollbar-thumb:hover {
          background: var(--text-dim, #888);
        }
        .live-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: var(--green); display: inline-block;
        }
        .live-dot.pulsing {
          box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
          animation: livePulse 1.6s ease-out infinite;
        }
        @keyframes livePulse {
          0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
          70% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
          100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }
        .insight-banner {
          display: flex; align-items: center; gap: 10px;
          padding: 10px 14px; border-radius: 8px; font-size: 13px;
          margin-bottom: 16px; animation: fadeSlideIn 0.3s ease;
        }
        .insight-banner.high { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }
        .insight-banner.medium { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #fcd34d; }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div className="flex-between" style={{ marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Dashboard</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastUpdated && (
            <span className="text-dim text-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`live-dot ${isLive ? 'pulsing' : ''}`} />
              Updated {timeAgo(lastUpdated, now)}
            </span>
          )}
          <label className="text-dim text-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <button className="btn btn-ghost" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <button
          type="button"
          className="stat-card blue stat-card-clickable"
          onClick={() => setStatusFilter('all')}
          style={{ cursor: 'pointer', textAlign: 'left', border: statusFilter === 'all' ? '1px solid var(--accent)' : undefined }}
        >
          <div className="stat-label">Total Employees</div>
          <div className="stat-value">{totalEmployeesAnim || '—'}</div>
          <div className="stat-meta">{scheduledToday} scheduled today</div>
        </button>

        <button
          type="button"
          className="stat-card green stat-card-clickable"
          onClick={() => setStatusFilter('present')}
          style={{ cursor: 'pointer', textAlign: 'left', border: statusFilter === 'present' ? '1px solid var(--accent)' : undefined }}
        >
          <div className="stat-label">Present Today</div>
          <div className="stat-value">{presentTotalAnim}</div>
          <div className="stat-meta" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {attendanceRate >= 50 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {attendanceRate}% of {scheduledToday} scheduled
          </div>
        </button>

        <button
          type="button"
          className="stat-card red stat-card-clickable"
          onClick={() => setStatusFilter('absent')}
          style={{ cursor: 'pointer', textAlign: 'left', border: statusFilter === 'absent' ? '1px solid var(--accent)' : undefined }}
        >
          <div className="stat-label">Absent</div>
          <div className="stat-value">{absentCountAnim}</div>
          <div className="stat-meta">Of {scheduledToday} scheduled today</div>
        </button>

        <button
          type="button"
          className="stat-card amber stat-card-clickable"
          onClick={() => setStatusFilter('late')}
          style={{ cursor: 'pointer', textAlign: 'left', border: statusFilter === 'late' ? '1px solid var(--accent)' : undefined }}
        >
          <div className="stat-label">Late Arrivals</div>
          <div className="stat-value">{lateCountAnim}</div>
          <div className="stat-meta">Past shift start + 15 min</div>
        </button>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        {/* Today's records */}
        <div className="card">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="card-title">Today's Check-ins</div>
              <div className="card-subtitle">{filteredRecords.length} of {records.length} records</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
                <input
                  className="input"
                  placeholder="Search name or dept…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  style={{ paddingLeft: 28, fontSize: 12, height: 30 }}
                />
              </div>
              <select
                className="input"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                style={{ fontSize: 12, height: 30 }}
              >
                {STATUS_FILTERS.map(s => (
                  <option key={s} value={s}>{s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>

          {filteredRecords.length === 0 ? (
            <div className="empty-state">
              <Clock size={32} />
              <p>{records.length === 0 ? 'No check-ins yet today' : 'No records match your filters'}</p>
            </div>
          ) : (
            <div className="checkin-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 340, overflowY: 'auto' }}>
              {filteredRecords.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div className="avatar" style={{ flexShrink: 0 }}>{initials(r.employees?.name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.employees?.name}</div>
                    <div className="text-dim text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.employees?.department}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div className={`badge ${r.status}`}>
                      <span className="badge-dot" />{r.status}
                    </div>
                    <div className="mono text-dim" style={{ marginTop: 4, fontSize: 11, whiteSpace: 'nowrap' }}>
                      {r.clock_in ? `${r.clock_in} ${r.clock_out ? `→ ${r.clock_out}` : '→ …'}` : 'Not clocked in'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>Shift Progress</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { label: 'Clocked In', count: present.length + late.length, color: 'var(--green)', max: scheduledToday || 1 },
                { label: 'Late', count: late.length, color: 'var(--amber)', max: scheduledToday || 1 },
                { label: 'Clocked Out', count: clockedOut.length, color: 'var(--accent)', max: present.length + late.length || 1 },
              ].map(({ label, count, color, max }) => (
                <div key={label}>
                  <div className="flex-between text-sm" style={{ marginBottom: 6 }}>
                    <span className="text-muted">{label}</span>
                    <span style={{ fontWeight: 600, color }}>{count}</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 3 }}>
                    <div style={{
                      height: '100%', borderRadius: 3,
                      background: color,
                      width: `${Math.min((count / max) * 100, 100)}%`,
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Punctuality</div>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div className="text-dim text-sm" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Timer size={12} /> Avg. clock-in
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{minutesToClock(avgClockIn)}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="text-dim text-sm" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <UserCheck size={12} /> On-time rate
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{onTimeRate}%</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Late Arrivals</div>
            {late.length === 0 ? (
              <p className="text-dim text-sm">No late arrivals today 🎉</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {late.map(r => (
                  <div key={r.id} className="flex-center" style={{ justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{r.employees?.name}</span>
                    <span className="mono text-amber" style={{ fontSize: 12 }}>{r.clock_in}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Department breakdown — built entirely from today's real records */}
      {deptBreakdown.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Building2 size={16} /> Attendance by Department
              </div>
              <div className="card-subtitle">Today's records grouped by team</div>
            </div>
          </div>
          {deptInsight && (
            <div className={`insight-banner ${deptInsight.severity}`}>
              <UserX size={15} />
              {deptInsight.text}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
            {deptBreakdown.map(d => {
              const covered = d.present + d.late;
              const pct = d.total ? Math.round((covered / d.total) * 100) : 0;
              const flagged = deptInsight?.dept === d.dept;
              return (
                <div key={d.dept}>
                  <div className="flex-between text-sm" style={{ marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {d.dept}
                      {flagged && <span className="live-dot pulsing" style={{ background: 'var(--red, #ef4444)' }} />}
                    </span>
                    <span className="text-dim">
                      {covered}/{d.total} in · {d.late} late · {pct}%
                    </span>
                  </div>
                  <div style={{ height: 8, background: 'var(--surface2)', borderRadius: 4, display: 'flex', overflow: 'hidden', transition: 'all 0.4s ease' }}>
                    <div style={{ width: `${(d.present / d.total) * 100}%`, background: 'var(--green)', transition: 'width 0.6s ease' }} />
                    <div style={{ width: `${(d.late / d.total) * 100}%`, background: 'var(--amber)', transition: 'width 0.6s ease' }} />
                    <div style={{ width: `${(d.absent / d.total) * 100}%`, background: 'var(--red, #ef4444)', transition: 'width 0.6s ease' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Weekly trend — only shows once api.getWeeklyTrend() is implemented server-side */}
      {weekly && weekly.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title" style={{ marginBottom: 16 }}>Attendance Trend — Last {weekly.length} Days</div>
          <WeeklyTrendChart data={weekly} />
        </div>
      )}
      {weeklyError && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title" style={{ marginBottom: 6 }}>Attendance Trend</div>
          <p className="text-dim text-sm">
            Add a <code>getWeeklyTrend(days)</code> method to your API client (returning per-day present/late/absent
            counts) to unlock a 7-day trend chart here.
          </p>
        </div>
      )}
    </div>
  );
}

function WeeklyTrendChart({ data }) {
  const width = 640;
  const height = 200;
  const pad = 28;
  const maxVal = Math.max(1, ...data.map(d => d.total || (d.present + d.late + d.absent)));
  const xStep = (width - pad * 2) / Math.max(1, data.length - 1);

  const line = (key, color) => {
    const points = data.map((d, i) => {
      const x = pad + i * xStep;
      const y = height - pad - (d[key] / maxVal) * (height - pad * 2);
      return `${x},${y}`;
    }).join(' ');
    return <polyline points={points} fill="none" stroke={color} strokeWidth="2" />;
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--border-subtle)" />
      {line('present', 'var(--green)')}
      {line('late', 'var(--amber)')}
      {line('absent', 'var(--red, #ef4444)')}
      {data.map((d, i) => (
        <text
          key={d.date}
          x={pad + i * xStep}
          y={height - 8}
          fontSize="9"
          textAnchor="middle"
          fill="var(--text-dim, #888)"
        >
          {format(new Date(d.date), 'MM/dd')}
        </text>
      ))}
      <g transform={`translate(${width - pad - 100}, 12)`} fontSize="10" fill="var(--text-dim, #888)">
        <rect width="8" height="8" fill="var(--green)" /><text x="12" y="8">Present</text>
        <rect x="60" width="8" height="8" fill="var(--amber)" /><text x="72" y="8">Late</text>
      </g>
    </svg>
  );
}