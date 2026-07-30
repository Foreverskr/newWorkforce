import { useState, useEffect, useRef } from 'react';
import { Search, Plus, Edit2, Trash2, Users, AlertTriangle, Fingerprint, X, Loader2, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';

const DEPARTMENTS = ['Engineering', 'Marketing', 'Sales', 'HR', 'Finance', 'Operations', 'Design', 'Product'];

const FINGERPRINT_SLOTS = [
  { slot_label: 'primary', title: 'Primary Fingerprint' },
  { slot_label: 'backup_1', title: 'Backup Fingerprint 1' },
  { slot_label: 'backup_2', title: 'Backup Fingerprint 2' },
];

function EmployeeModal({ emp, onClose, onSave }) {
  const [form, setForm] = useState({
    name: '', email: '', employee_id: '', department: '',
    position: '', status: 'active',
    is_fleet_driver: false,
    ...emp,
  });
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.name || !form.email || !form.employee_id) return;
    setSaving(true);
    try { await onSave(form); onClose(); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{emp ? 'Edit Employee' : 'Add Employee'}</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="form-grid">
          <div className="form-group">
            <label>Full Name *</label>
            <input value={form.name} onChange={set('name')} placeholder="Jane Doe" />
          </div>
          <div className="form-group">
            <label>Employee ID *</label>
            <input value={form.employee_id} onChange={set('employee_id')} placeholder="EMP-001" />
          </div>
          <div className="form-group full">
            <label>Email *</label>
            <input type="email" value={form.email} onChange={set('email')} placeholder="jane@company.com" />
          </div>
          <div className="form-group">
            <label>Department</label>
            <select value={form.department} onChange={set('department')}>
              <option value="">Select…</option>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Position</label>
            <input value={form.position} onChange={set('position')} placeholder="Software Engineer" />
          </div>
          <div className="form-group">
            <label>Status</label>
            <select value={form.status} onChange={set('status')}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div className="form-group full">
            <label className="flex-center" style={{ gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!form.is_fleet_driver}
                onChange={e => setForm(f => ({ ...f, is_fleet_driver: e.target.checked }))}
                style={{ width: 'auto' }}
              />
              Fleet driver
            </label>
            <p className="text-dim text-sm" style={{ marginTop: 4 }}>
              Marks this employee as a company driver, eligible to cover another fleet driver's shift if they're absent.
            </p>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.name || !form.email || !form.employee_id}>
            {saving ? 'Saving…' : emp ? 'Update Employee' : 'Add Employee'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Polls a pending enrollment request until the ESP32 terminal reports back
// (completed/failed), or the person gives up and closes/cancels it.
function FingerprintSlotRow({ employeeId, slot, onChanged, onToast }) {
  const [request, setRequest] = useState(slot.request);
  const pollRef = useRef(null);

  useEffect(() => {
    setRequest(slot.request);
  }, [slot.request]);

  useEffect(() => {
    if (!request || !['pending', 'capturing'].includes(request.status)) {
      clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const updated = await api.getFingerprintRequestStatus(employeeId, request.id);
        setRequest(updated);
        if (updated.status === 'completed') {
          onToast('Fingerprint enrolled', 'success');
          onChanged();
        } else if (updated.status === 'failed') {
          onToast(updated.error_message || 'Enrollment failed on the device', 'error');
        }
      } catch (e) { /* keep polling; a transient network blip shouldn't kill the UI */ }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [request?.id, request?.status]);

  const startEnroll = async () => {
    try {
      const req = await api.requestFingerprintEnrollment(employeeId, slot.slot_label);
      setRequest(req);
      onToast('Waiting for the fingerprint terminal…', 'success');
    } catch (e) { onToast(e.message, 'error'); }
  };

  const cancel = async () => {
    try {
      await api.cancelFingerprintRequest(employeeId, request.id);
      setRequest(null);
    } catch (e) { onToast(e.message, 'error'); }
  };

  const remove = async () => {
    const slotTitle = slot.title || FINGERPRINT_SLOTS.find(s => s.slot_label === slot.slot_label)?.title || 'fingerprint';
    if (!confirm(`Remove the ${slotTitle.toLowerCase()}? The employee will need to re-scan it.`)) return;
    try {
      await api.deleteEmployeeFingerprint(employeeId, slot.fingerprint.id);
      onToast('Fingerprint removed', 'success');
      onChanged();
    } catch (e) { onToast(e.message, 'error'); }
  };

  let status;
  if (request?.status === 'pending') {
    status = <span className="text-dim text-sm flex-center" style={{ gap: 6 }}><Loader2 size={13} className="spin" /> Waiting for terminal…</span>;
  } else if (request?.status === 'capturing') {
    status = <span className="text-dim text-sm flex-center" style={{ gap: 6 }}><Loader2 size={13} className="spin" /> Scanning on {request.device_id}…</span>;
  } else if (slot.fingerprint) {
    status = (
      <span className="text-sm flex-center" style={{ gap: 6, color: 'var(--success, #16a34a)' }}>
        <CheckCircle2 size={14} /> Enrolled on {slot.fingerprint.device_id}
      </span>
    );
  } else {
    status = <span className="text-dim text-sm">Not enrolled</span>;
  }

  return (
    <div className="flex-between" style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{slot.title}</div>
        {status}
      </div>
      <div className="flex-center gap-2">
        {request && ['pending', 'capturing'].includes(request.status) ? (
          <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
        ) : slot.fingerprint ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={startEnroll}>Re-scan</button>
            <button className="btn btn-danger btn-sm" onClick={remove}>Remove</button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={startEnroll}>Enroll</button>
        )}
      </div>
    </div>
  );
}

function FingerprintModal({ emp, onClose, onToast }) {
  const [slots, setSlots] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api.getEmployeeFingerprints(emp.id);
      setSlots(data.slots);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title flex-center" style={{ gap: 8 }}>
            <Fingerprint size={18} /> {emp.name} — Fingerprints
          </span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '4px 20px 8px' }}>
          <p className="text-dim text-sm" style={{ marginBottom: 8 }}>
            One primary finger plus up to 2 backups (in case the primary won't scan). On "Enroll", the
            employee scans their finger on the fingerprint terminal within a couple minutes.
          </p>
          {loading ? (
            <div className="loading"><div className="spinner" /> Loading…</div>
          ) : (
            slots.map(slot => (
              <FingerprintSlotRow
                key={slot.slot_label}
                employeeId={emp.id}
                slot={slot}
                onChanged={load}
                onToast={onToast}
              />
            ))
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function EmployeesPage({ onToast }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [modal, setModal] = useState(null); // null | 'add' | employee obj
  const [fingerprintTarget, setFingerprintTarget] = useState(null); // employee obj | null

  const load = async () => {
    setLoading(true);
    try {
      setEmployees(await api.getEmployees());
    }
    catch(e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const checkInactivity = async () => {
    try {
      const result = await api.checkEmployeeInactivity();
      if (result.newly_flagged > 0) {
        onToast(`${result.newly_flagged} employee(s) flagged inactive for no attendance`, 'error');
      } else {
        onToast('No new attendance inactivity found', 'success');
      }
      load();
    } catch (e) { onToast(e.message, 'error'); }
  };

  const del = async (id) => {
    if (!confirm('Delete this employee? Their attendance records will remain.')) return;
    try {
      await api.deleteEmployee(id);
      setEmployees(e => e.filter(x => x.id !== id));
      onToast('Employee deleted', 'success');
    } catch(e) { onToast(e.message, 'error'); }
  };

  const save = async (form) => {
    try {
      if (modal?.id) {
        const updated = await api.updateEmployee(modal.id, form);
        setEmployees(e => e.map(x => x.id === modal.id ? updated : x));
        onToast('Employee updated', 'success');
      } else {
        const created = await api.createEmployee(form);
        setEmployees(e => [created, ...e]);
        onToast('Employee added', 'success');
      }
    } catch(e) { onToast(e.message, 'error'); throw e; }
  };

  const filtered = employees.filter(e => {
    const q = search.toLowerCase();
    const matchQ = !q || e.name?.toLowerCase().includes(q) || e.email?.toLowerCase().includes(q) || e.employee_id?.toLowerCase().includes(q);
    const matchD = !deptFilter || e.department === deptFilter;
    return matchQ && matchD;
  });

  const depts = [...new Set(employees.map(e => e.department).filter(Boolean))];
  const initials = (name='') => name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Employees</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{employees.length} total · {employees.filter(e=>e.status==='active').length} active</p>
        </div>
        <div className="flex-center gap-2">
          <button className="btn btn-ghost" onClick={checkInactivity} title="Flag employees with no attendance for 7+ working days">
            <AlertTriangle size={14} /> Check Attendance
          </button>
          <button className="btn btn-primary" onClick={() => setModal({})}>
            <Plus size={14} /> Add Employee
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div className="search-bar" style={{ flex: 1 }}>
            <Search />
            <input placeholder="Search by name, email, or ID…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ width: 180 }}>
            <option value="">All departments</option>
            {depts.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /> Loading employees…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state"><Users size={36} /><p>No employees found</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Employee ID</th>
                  <th>Email</th>
                  <th>Department</th>
                  <th>Position</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => (
                  <tr key={e.id}>
                    <td>
                      <div className="flex-center" style={{ gap: 8 }}>
                        <div className="avatar">{initials(e.name)}</div>
                        {e.name}
                        {e.is_fleet_driver && (
                          <span className="badge active" title="Fleet driver">Fleet</span>
                        )}
                      </div>
                    </td>
                    <td className="mono">{e.employee_id}</td>
                    <td className="text-muted">{e.email}</td>
                    <td>{e.department || '—'}</td>
                    <td>{e.position || '—'}</td>
                    <td>
                      <span className={`badge ${e.status}`}><span className="badge-dot" />{e.status}</span>
                      {e.status === 'inactive' && e.inactivity_reason && (
                        <div className="text-dim text-sm" style={{ marginTop: 2, maxWidth: 220 }}>
                          {e.inactivity_reason}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="flex-center gap-2">
                        <button className="btn btn-icon btn-ghost btn-sm" onClick={() => setFingerprintTarget(e)} title="Manage fingerprints">
                          <Fingerprint size={13} />
                        </button>
                        <button className="btn btn-icon btn-ghost btn-sm" onClick={() => setModal(e)} title="Edit">
                          <Edit2 size={13} />
                        </button>
                        <button className="btn btn-icon btn-danger btn-sm" onClick={() => del(e.id)} title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal !== null && (
        <EmployeeModal
          emp={modal?.id ? modal : null}
          onClose={() => setModal(null)}
          onSave={save}
        />
      )}

      {fingerprintTarget && (
        <FingerprintModal
          emp={fingerprintTarget}
          onClose={() => setFingerprintTarget(null)}
          onToast={onToast}
        />
      )}
    </div>
  );
}