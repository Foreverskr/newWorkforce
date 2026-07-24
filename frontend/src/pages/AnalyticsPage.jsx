import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { api } from '../lib/api';
import { subDays, format } from 'date-fns';

const COLORS = {
  present: '#10B981',
  late: '#F59E0B',
  absent: '#F43F5E',
};

export default function AnalyticsPage({ onToast }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('30');
  const [empSearch, setEmpSearch] = useState('');
  const [empSort, setEmpSort] = useState({ key: 'name', dir: 'asc' });

  const load = async () => {
    setLoading(true);
    const end = new Date().toISOString().split('T')[0];
    const start = format(subDays(new Date(), parseInt(range)), 'yyyy-MM-dd');
    try {
      setSummary(await api.getSummary({ start_date: start, end_date: end }));
    } catch(e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [range]);

  const pieData = summary ? [
    { name: 'Present', value: summary.totals.present, color: COLORS.present },
    { name: 'Late', value: summary.totals.late, color: COLORS.late },
    { name: 'Absent', value: summary.totals.absent, color: COLORS.absent },
  ].filter(d => d.value > 0) : [];

  const byEmployee = summary?.byEmployee || [];

  const visibleEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    let rows = q
      ? byEmployee.filter(e => e.name.toLowerCase().includes(q) || e.department.toLowerCase().includes(q))
      : byEmployee;

    const { key, dir } = empSort;
    rows = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return dir === 'asc' ? cmp : -cmp;
    });

    return rows;
  }, [byEmployee, empSearch, empSort]);

  const toggleEmpSort = (key) => {
    setEmpSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  };

  const sortIndicator = (key) => empSort.key === key ? (empSort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Analytics</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>
            {summary ? `${summary.period.start} → ${summary.period.end}` : 'Loading…'}
          </p>
        </div>
        <select value={range} onChange={e => setRange(e.target.value)} style={{ width: 160 }}>
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /> Loading analytics…</div>
      ) : summary ? (
        <>
          <div className="stats-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card blue">
              <div className="stat-label">Total Records</div>
              <div className="stat-value">{summary.totals.totalRecords}</div>
              <div className="stat-meta">In selected period</div>
            </div>
            <div className="stat-card green">
              <div className="stat-label">Present</div>
              <div className="stat-value">{summary.totals.present}</div>
              <div className="stat-meta">
                {summary.totals.totalRecords ? Math.round((summary.totals.present / summary.totals.totalRecords) * 100) : 0}% of records
              </div>
            </div>
            <div className="stat-card amber">
              <div className="stat-label">Late</div>
              <div className="stat-value">{summary.totals.late}</div>
              <div className="stat-meta">{summary.totals.totalRecords ? Math.round((summary.totals.late / summary.totals.totalRecords) * 100) : 0}% of records</div>
            </div>
            <div className="stat-card red">
              <div className="stat-label">Total Hours</div>
              <div className="stat-value">{summary.totals.totalHours}</div>
              <div className="stat-meta">Across all employees</div>
            </div>
            <div className="stat-card green">
              <div className="stat-label">Excused Absences</div>
              <div className="stat-value">{summary.totals.excused ?? 0}</div>
              <div className="stat-meta">Approved leave</div>
            </div>
            <div className="stat-card red">
              <div className="stat-label">Unexcused Absences</div>
              <div className="stat-value">{summary.totals.unexcused ?? 0}</div>
              <div className="stat-meta">No-shows</div>
            </div>
          </div>

          <div className="grid-2" style={{ marginBottom: 20 }}>
            {/* Daily trend chart */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">Daily Attendance Trend</div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={summary.dailyTrend} barSize={10}>
                  <XAxis dataKey="date" tickFormatter={d => d.slice(5)} tick={{ fontSize: 11, fill: 'var(--text-dim)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-dim)' }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text)' }}
                  />
                  <Bar dataKey="present" fill={COLORS.present} radius={[3, 3, 0, 0]} name="Present" />
                  <Bar dataKey="late" fill={COLORS.late} radius={[3, 3, 0, 0]} name="Late" />
                  <Bar dataKey="absent" fill={COLORS.absent} radius={[3, 3, 0, 0]} name="Absent" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Pie chart */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">Status Distribution</div>
              </div>
              {pieData.length === 0 ? (
                <div className="empty-state" style={{ padding: '40px 20px' }}><p>No data</p></div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value" paddingAngle={3}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* By Department */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div className="card-title">Attendance by Department</div>
            </div>
            {summary.byDepartment.length === 0 ? (
              <div className="empty-state"><p>No department data</p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th>Total</th>
                      <th>Present</th>
                      <th>Late</th>
                      <th>Absent</th>
                      <th>Attendance %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byDepartment.map(d => {
                      const rate = d.total ? Math.round(((d.present + d.late) / d.total) * 100) : 0;
                      return (
                        <tr key={d.department}>
                          <td>{d.department}</td>
                          <td>{d.total}</td>
                          <td style={{ color: 'var(--green)' }}>{d.present}</td>
                          <td style={{ color: 'var(--amber)' }}>{d.late}</td>
                          <td style={{ color: 'var(--red)' }}>{d.absent || 0}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ height: 6, flex: 1, background: 'var(--surface2)', borderRadius: 3 }}>
                                <div style={{ height: '100%', borderRadius: 3, background: rate > 80 ? 'var(--green)' : rate > 60 ? 'var(--amber)' : 'var(--red)', width: `${rate}%` }} />
                              </div>
                              <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 32 }}>{rate}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* By Employee */}
          <div className="card">
            <div className="card-header flex-between">
              <div className="card-title">Attendance by Employee</div>
              <input
                type="text"
                placeholder="Search name or department…"
                value={empSearch}
                onChange={e => setEmpSearch(e.target.value)}
                style={{ width: 220 }}
              />
            </div>
            {byEmployee.length === 0 ? (
              <div className="empty-state"><p>No employee data</p></div>
            ) : visibleEmployees.length === 0 ? (
              <div className="empty-state"><p>No employees match "{empSearch}"</p></div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('name')}>Employee{sortIndicator('name')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('department')}>Department{sortIndicator('department')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('total')}>Total{sortIndicator('total')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('present')}>Present{sortIndicator('present')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('late')}>Late{sortIndicator('late')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('excused')}>Excused{sortIndicator('excused')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('unexcused')}>Unexcused{sortIndicator('unexcused')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('totalHours')}>Hours{sortIndicator('totalHours')}</th>
                      <th style={{ cursor: 'pointer' }} onClick={() => toggleEmpSort('rate')}>Attendance %{sortIndicator('rate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEmployees.map(e => (
                      <tr key={e.employee_id}>
                        <td>{e.name}</td>
                        <td>{e.department}</td>
                        <td>{e.total}</td>
                        <td style={{ color: 'var(--green)' }}>{e.present}</td>
                        <td style={{ color: 'var(--amber)' }}>{e.late}</td>
                        <td style={{ color: 'var(--green)' }}>{e.excused}</td>
                        <td style={{ color: 'var(--red)' }}>{e.unexcused}</td>
                        <td>{e.totalHours}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ height: 6, flex: 1, background: 'var(--surface2)', borderRadius: 3 }}>
                              <div style={{ height: '100%', borderRadius: 3, background: e.rate > 80 ? 'var(--green)' : e.rate > 60 ? 'var(--amber)' : 'var(--red)', width: `${e.rate}%` }} />
                            </div>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 32 }}>{e.rate}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}