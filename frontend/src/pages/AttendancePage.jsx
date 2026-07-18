import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Trash2, Calendar } from 'lucide-react';
import { api } from '../lib/api';
import { format } from 'date-fns';

function ManualModal({ employees, onClose, onSave }) {
  const [form, setForm] = useState({
    employee_id: '', date: new Date().toISOString().split('T')[0],
    clock_in: '09:00', clock_out: '', status: 'present', notes: '',
  });
  const [saving, setSaving] = useState(false);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.employee_id || !form.date) return;
    setSaving(true);
    try {
      await onSave(form);
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Add Attendance Record</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label>Employee</label>
            <select value={form.employee_id} onChange={set('employee_id')}>
              <option value="">Select…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Date</label>
            <input type="date" value={form.date} onChange={set('date')} />
          </div>
          <div className="form-group">
            <label>Clock In</label>
            <input type="time" value={form.clock_in} onChange={set('clock_in')} />
          </div>
          <div className="form-group">
            <label>Clock Out</label>
            <input type="time" value={form.clock_out} onChange={set('clock_out')} />
          </div>
          <div className="form-group">
            <label>Status</label>
            <select value={form.status} onChange={set('status')}>
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="absent">Absent</option>
            </select>
          </div>
          <div className="form-group full">
            <label>Notes</label>
            <input type="text" value={form.notes} onChange={set('notes')} placeholder="Optional note…" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.employee_id}>
            {saving ? 'Saving…' : 'Save Record'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AttendancePage({ onToast }) {
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    start_date: new Date().toISOString().split('T')[0],
    end_date: new Date().toISOString().split('T')[0],
    status: '', employee_id: '',
  });
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);

  useEffect(() => { api.getEmployees().then(setEmployees); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.start_date) params.start_date = filters.start_date;
      if (filters.end_date) params.end_date = filters.end_date;
      if (filters.status) params.status = filters.status;
      if (filters.employee_id) params.employee_id = filters.employee_id;
      setRecords(await api.getAttendance(params));
    } catch(e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const del = async (id) => {
    if (!confirm('Delete this record?')) return;
    try {
      await api.deleteAttendance(id);
      setRecords(r => r.filter(x => x.id !== id));
      onToast('Record deleted', 'success');
    } catch(e) { onToast(e.message, 'error'); }
  };

  const filtered = records.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.employees?.name?.toLowerCase().includes(q) || r.employees?.department?.toLowerCase().includes(q);
  });

  const setF = k => e => setFilters(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Attendance Records</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{filtered.length} records</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={14} /> Add Record
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="search-bar" style={{ flex: 1, minWidth: 200 }}>
            <Search />
            <input placeholder="Search by name or department…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ marginBottom: 4 }}>From</label>
            <input type="date" value={filters.start_date} onChange={setF('start_date')} style={{ width: 160 }} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ marginBottom: 4 }}>To</label>
            <input type="date" value={filters.end_date} onChange={setF('end_date')} style={{ width: 160 }} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ marginBottom: 4 }}>Status</label>
            <select value={filters.status} onChange={setF('status')} style={{ width: 140 }}>
              <option value="">All statuses</option>
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="absent">Absent</option>
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ marginBottom: 4 }}>Employee</label>
            <select value={filters.employee_id} onChange={setF('employee_id')} style={{ width: 180 }}>
              <option value="">All employees</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /> Loading records…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state"><Calendar size={36} /><p>No records found for the selected filters</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Date</th>
                  <th>Clock In</th>
                  <th>Clock Out</th>
                  <th>Hours</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id}>
                    <td>
                      <div className="flex-center">
                        <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
                          {(r.employees?.name || '?').split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2)}
                        </div>
                        {r.employees?.name || '—'}
                      </div>
                    </td>
                    <td>{r.employees?.department || '—'}</td>
                    <td className="mono">{r.date}</td>
                    <td className="mono" style={{ color: 'var(--green)' }}>{r.clock_in || '—'}</td>
                    <td className="mono" style={{ color: 'var(--accent)' }}>{r.clock_out || '—'}</td>
                    <td className="mono">{r.hours_worked ? `${r.hours_worked}h` : '—'}</td>
                    <td>
                      <span className={`badge ${r.status}`}>
                        <span className="badge-dot" />{r.status}
                      </span>
                    </td>
                    <td className="text-dim text-sm">{r.notes || '—'}</td>
                    <td>
                      <button className="btn btn-icon btn-danger btn-sm" onClick={() => del(r.id)} title="Delete">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <ManualModal
          employees={employees}
          onClose={() => setShowModal(false)}
          onSave={async (form) => {
            try {
              await api.manualAttendance(form);
              onToast('Record saved', 'success');
              load();
            } catch(e) { onToast(e.message, 'error'); throw e; }
          }}
        />
      )}
    </div>
  );
}
