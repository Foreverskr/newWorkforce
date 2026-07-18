import { useState, useEffect } from 'react';
import { Users, UserCheck, UserX, Clock, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { format } from 'date-fns';

function initials(name = '') {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

export default function Dashboard() {
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { setToday(await api.getToday()); } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="loading"><div className="spinner" /> Loading dashboard…</div>;

  const records = today?.records || [];
  const present = records.filter(r => r.status === 'present');
  const late = records.filter(r => r.status === 'late');
  const clockedOut = records.filter(r => r.clock_out);

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Dashboard</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>
        <button className="btn btn-ghost" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="stats-grid">
        <div className="stat-card blue">
          <div className="stat-label">Total Employees</div>
          <div className="stat-value">{today?.total_employees ?? '—'}</div>
          <div className="stat-meta">Active workforce</div>
        </div>
        <div className="stat-card green">
          <div className="stat-label">Present Today</div>
          <div className="stat-value">{(today?.present ?? 0) + (today?.late ?? 0)}</div>
          <div className="stat-meta">{today?.total_employees ? Math.round(((today.present + today.late) / today.total_employees) * 100) : 0}% attendance rate</div>
        </div>
        <div className="stat-card red">
          <div className="stat-label">Absent</div>
          <div className="stat-value">{today?.absent ?? '—'}</div>
          <div className="stat-meta">Not clocked in yet</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-label">Late Arrivals</div>
          <div className="stat-value">{today?.late ?? 0}</div>
          <div className="stat-meta">Past shift start + 15 min</div>
        </div>
      </div>

      <div className="grid-2">
        {/* Today's records */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Today's Check-ins</div>
              <div className="card-subtitle">{records.length} records</div>
            </div>
          </div>
          {records.length === 0 ? (
            <div className="empty-state">
              <Clock size={32} />
              <p>No check-ins yet today</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 340, overflowY: 'auto' }}>
              {records.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div className="avatar">{initials(r.employees?.name)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{r.employees?.name}</div>
                    <div className="text-dim text-sm">{r.employees?.department}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className={`badge ${r.status}`}>
                      <span className="badge-dot" />{r.status}
                    </div>
                    <div className="mono text-dim" style={{ marginTop: 4, fontSize: 11 }}>
                      {r.clock_in} {r.clock_out ? `→ ${r.clock_out}` : '→ …'}
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
                { label: 'Clocked In', count: present.length + late.length, color: 'var(--green)', max: today?.total_employees || 1 },
                { label: 'Late', count: late.length, color: 'var(--amber)', max: today?.total_employees || 1 },
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
    </div>
  );
}
