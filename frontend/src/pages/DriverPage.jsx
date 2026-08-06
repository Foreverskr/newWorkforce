import { useState, useEffect, useCallback } from 'react';
import { Truck, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { api } from '../lib/api';

const STATUS_META = {
  active:   { label: 'Active',   bg: 'var(--green-bg)', color: 'var(--green)' },
  inactive: { label: 'Inactive', bg: 'var(--red-bg)',   color: 'var(--red)'   },
  flagged:  { label: 'Flagged',  bg: 'var(--amber-bg)', color: 'var(--amber)' },
};

export default function DriversPage({ onToast }) {
  const [drivers, setDrivers]   = useState([]);
  const [logs, setLogs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [driversData, logsData] = await Promise.all([
        api.getDrivers(),
        api.getInactivityLogs(),
      ]);
      // Ensure we have arrays, handle nested responses
      setDrivers(Array.isArray(driversData) ? driversData : driversData?.drivers || []);
      setLogs(Array.isArray(logsData) ? logsData : logsData?.logs || []);
    } catch (e) {
      onToast('Failed to load drivers', 'error');
      setDrivers([]);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  const runCheck = useCallback(async (silent = false) => {
    setChecking(true);
    try {
      const res = await api.checkDriverInactivity();
      setLastCheck(new Date());
      if (res.newly_flagged > 0) {
        onToast(`${res.newly_flagged} driver(s) flagged inactive — HR1 notified`, 'error');
      } else if (!silent) {
        onToast('All drivers are active', 'success');
      }
      await load();
    } catch (e) {
      onToast('Inactivity check failed', 'error');
    } finally {
      setChecking(false);
    }
  }, [load, onToast]);

  // Auto-check on page load, then load data
  useEffect(() => {
    runCheck(true);
  }, [runCheck]);

  const activeCount   = drivers.filter(d => d.status === 'active').length;
  const inactiveCount = drivers.filter(d => d.status === 'inactive').length;

  const daysSince = (date) => {
    if (!date) return null;
    return Math.floor((new Date() - new Date(date)) / 86400000);
  };

  const isExpired = (date) => date && new Date(date) < new Date();

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Drivers</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>
            {drivers.length} drivers · monitored for HR1 inactivity reporting
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => runCheck(false)} disabled={checking}>
          <RefreshCw size={14} className={checking ? 'spin' : ''} />
          {checking ? 'Checking…' : 'Check Now'}
        </button>
      </div>

      {/* Stat cards */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card blue">
          <div className="stat-label">Total Drivers</div>
          <div className="stat-value">{drivers.length}</div>
          <div className="stat-meta">Pulled from fleet system</div>
        </div>
        <div className="stat-card green">
          <div className="stat-label">Active</div>
          <div className="stat-value">{activeCount}</div>
          <div className="stat-meta">Driving within 7 days</div>
        </div>
        <div className="stat-card red">
          <div className="stat-label">Inactive</div>
          <div className="stat-value">{inactiveCount}</div>
          <div className="stat-meta">Flagged &amp; sent to HR1</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-label">Last Check</div>
          <div className="stat-value" style={{ fontSize: 15 }}>
            {lastCheck ? lastCheck.toLocaleTimeString() : '—'}
          </div>
          <div className="stat-meta">Threshold: 7 days inactivity</div>
        </div>
      </div>

      {/* Drivers table */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div className="card-title">All Drivers</div>
        </div>
        {loading ? (
          <div className="loading"><div className="spinner" /> Loading drivers…</div>
        ) : drivers.length === 0 ? (
          <div className="empty-state">
            <Truck size={36} />
            <p>No drivers found</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Vehicle</th>
                  <th>License Expiry</th>
                  <th>Last Trip</th>
                  <th>Days Since Trip</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map(d => {
                  const meta = STATUS_META[d.status] || STATUS_META.active;
                  const expired = isExpired(d.license_expiry);
                  const since = daysSince(d.last_trip_date);
                  const staleTrip = since === null || since > 7;
                  return (
                    <tr key={d.id}>
                      <td>
                        <div className="flex-center">
                          <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
                            {d.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</div>
                            <div className="text-dim" style={{ fontSize: 11 }}>{d.driver_id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{d.vehicle_plate || '—'}</td>
                      <td className="mono" style={{ color: expired ? 'var(--red)' : 'inherit' }}>
                        {d.license_expiry || '—'} {expired && '⚠️'}
                      </td>
                      <td className="mono">{d.last_trip_date || 'Never'}</td>
                      <td style={{ color: staleTrip ? 'var(--red)' : 'var(--text-muted)' }}>
                        {since === null ? '—' : `${since}d`}
                      </td>
                      <td>
                        <span className="badge" style={{ background: meta.bg, color: meta.color }}>
                          {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* HR1 notification log */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">HR1 Notification Log</div>
        </div>
        {logs.length === 0 ? (
          <div className="empty-state"><p>No inactivity events detected yet</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Reason</th>
                  <th>Detected</th>
                  <th>HR1 Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id}>
                    <td>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{log.drivers?.name || 'Unknown'}</div>
                      <div className="text-dim" style={{ fontSize: 11 }}>{log.drivers?.driver_id}</div>
                    </td>
                    <td className="text-sm">
                      {log.reason.split(',').map(r => (
                        <span key={r} className="badge" style={{ marginRight: 4, background: 'var(--surface2)', color: 'var(--text-muted)' }}>
                          {r === 'license_expired' ? 'License Expired' : 'No Trips (7d+)'}
                        </span>
                      ))}
                    </td>
                    <td className="text-dim text-sm">{new Date(log.detected_at).toLocaleString()}</td>
                    <td>
                      {log.hr1_notified ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--green)', fontSize: 12, fontWeight: 600 }}>
                          <CheckCircle2 size={13} /> Sent
                        </span>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--amber)', fontSize: 12, fontWeight: 600 }} title={log.hr1_response}>
                          <AlertTriangle size={13} /> {log.hr1_response?.includes('not configured') ? 'Not configured' : 'Failed'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}