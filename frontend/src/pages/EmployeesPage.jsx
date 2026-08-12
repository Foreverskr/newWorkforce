import { useState, useEffect, useRef } from 'react';
import { Search, Plus, Edit2, Trash2, Users, AlertTriangle, Fingerprint, X, Loader2, CheckCircle2, Mail } from 'lucide-react';
import { api } from '../lib/api';

const FINGERPRINT_SLOTS = [
  { slot_label: 'primary', title: 'Primary Fingerprint' },
  { slot_label: 'backup_1', title: 'Backup Fingerprint 1' },
  { slot_label: 'backup_2', title: 'Backup Fingerprint 2' },
];

const PAGE_SIZES = [10, 25, 50, 100];

// Matches FINGER_WAIT_TIMEOUT_MS on the ESP32 (60s) — purely cosmetic here,
// just lets us show a countdown so "capturing" doesn't feel indefinite.
const ENROLL_TIMEOUT_SECONDS = 60;

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
            <input value={form.department} onChange={set('department')} placeholder="Engineering" />
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

// Ticks up once a second while a request is active, purely for the
// "Xs elapsed" / timeout-countdown display below.
function useElapsedSeconds(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) { setSeconds(0); return; }
    setSeconds(0);
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}

// The big highlighted panel shown while a scan is pending/in-progress —
// replaces the old single line of text next to a Cancel button. Loud
// enough to notice from across the room, since the person doing the
// enrolling is standing at the kiosk, not looking at this screen.
function ScanningPanel({ request, onCancel }) {
  const isCapturing = request.status === 'capturing';
  const elapsed = useElapsedSeconds(true);
  const remaining = Math.max(0, ENROLL_TIMEOUT_SECONDS - elapsed);

  return (
    <div className="scan-panel">
      <div className="scan-icon-wrap">
        <span className="scan-ring" />
        <span className="scan-ring delay" />
        <Fingerprint size={28} className="scan-icon" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          {isCapturing ? 'Scan the finger on the terminal' : 'Waiting for the terminal to pick up the job…'}
        </div>
        <div className="text-dim text-sm" style={{ marginTop: 2 }}>
          {isCapturing
            ? `Scanning on ${request.device_id} — hold still, you'll be asked to scan twice`
            : 'This will start automatically once a device polls for work'}
        </div>
        <div className="text-dim text-sm" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={12} className="spin" />
          {isCapturing ? `Times out in ${remaining}s` : `${elapsed}s elapsed`}
        </div>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

// Polls a pending enrollment request until the ESP32 terminal reports back
function FingerprintSlotRow({ employeeId, slot, onChanged, onToast, anyActive, onActiveChange }) {
  const [request, setRequest] = useState(slot.request);
  const pollRef = useRef(null);

  useEffect(() => {
    setRequest(slot.request);
  }, [slot.request]);

  const isActive = !!request && ['pending', 'capturing'].includes(request.status);

  // Let the parent modal know whether THIS slot currently has an active
  // scan, so it can grey out "Enroll" on the other slots — only one
  // physical scan can happen on the device at a time.
  useEffect(() => {
    onActiveChange(slot.slot_label, isActive);
    return () => onActiveChange(slot.slot_label, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  useEffect(() => {
    if (!isActive) {
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
      } catch (e) { /* keep polling */ }
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
    if (!confirm(`Remove the ${slotTitle.toLowerCase()}?`)) return;
    try {
      await api.deleteEmployeeFingerprint(employeeId, slot.fingerprint.id);
      onToast('Fingerprint removed', 'success');
      onChanged();
    } catch (e) { onToast(e.message, 'error'); }
  };

  if (isActive) {
    return (
      <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{slot.title}</div>
        <ScanningPanel request={request} onCancel={cancel} />
      </div>
    );
  }

  let status;
  if (slot.fingerprint) {
    status = (
      <span className="text-sm flex-center" style={{ gap: 6, color: 'var(--success, #16a34a)' }}>
        <CheckCircle2 size={14} /> Enrolled on {slot.fingerprint.device_id}
      </span>
    );
  } else {
    status = <span className="text-dim text-sm">Not enrolled</span>;
  }

  // Another slot on this employee is mid-scan — block starting a second
  // one, since the physical device can only run one job at a time.
  const disabledByOther = anyActive && !isActive;

  return (
    <div className="flex-between" style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{slot.title}</div>
        {status}
      </div>
      <div className="flex-center gap-2">
        {slot.fingerprint ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={startEnroll} disabled={disabledByOther}>Re-scan</button>
            <button className="btn btn-danger btn-sm" onClick={remove} disabled={disabledByOther}>Remove</button>
          </>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={startEnroll}
            disabled={disabledByOther}
            title={disabledByOther ? 'Finish the scan in progress first' : undefined}
          >
            Enroll
          </button>
        )}
      </div>
    </div>
  );
}

function FingerprintModal({ emp, onClose, onToast }) {
  const [slots, setSlots] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeSlots, setActiveSlots] = useState({}); // slot_label -> bool

  const load = async () => {
    try {
      const data = await api.getEmployeeFingerprints(emp.id);
      setSlots(data.slots);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleActiveChange = (slotLabel, isActive) => {
    setActiveSlots(prev => {
      if (!!prev[slotLabel] === isActive) return prev;
      return { ...prev, [slotLabel]: isActive };
    });
  };

  const anyActive = Object.values(activeSlots).some(Boolean);

  return (
    <div className="modal-overlay">
      <div className="modal">
        <style>{`
          .scan-panel {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 14px;
            border-radius: 10px;
            background: var(--surface2, rgba(59, 130, 246, 0.08));
            border: 1px solid var(--accent, #3b82f6);
          }
          .scan-icon-wrap {
            position: relative;
            width: 48px;
            height: 48px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .scan-icon {
            color: var(--accent, #3b82f6);
            position: relative;
            z-index: 1;
          }
          .scan-ring {
            position: absolute;
            inset: 0;
            border-radius: 50%;
            border: 2px solid var(--accent, #3b82f6);
            opacity: 0;
            animation: scanPulse 1.8s ease-out infinite;
          }
          .scan-ring.delay { animation-delay: 0.6s; }
          @keyframes scanPulse {
            0% { transform: scale(0.55); opacity: 0.55; }
            100% { transform: scale(1.35); opacity: 0; }
          }
        `}</style>
        <div className="modal-header">
          <span className="modal-title flex-center" style={{ gap: 8 }}>
            <Fingerprint size={18} /> {emp.name} — Fingerprints
          </span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '4px 20px 8px' }}>
          <p className="text-dim text-sm" style={{ marginBottom: 8 }}>
            One primary finger plus up to 2 backups.
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
                anyActive={anyActive}
                onActiveChange={handleActiveChange}
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
  const [notifying, setNotifying] = useState(null); // employee id currently sending, or null
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

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

  const notify = async (emp) => {
    setNotifying(emp.id);
    try {
      await api.notifyInactiveEmployee(emp.id);
      onToast(`Notification email sent to ${emp.name}`, 'success');
    } catch (e) { onToast(e.message, 'error'); }
    finally { setNotifying(null); }
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

  useEffect(() => {
    setCurrentPage(1);
  }, [search, deptFilter, rowsPerPage]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const pageStart = (currentPage - 1) * rowsPerPage;
  const pageEnd = pageStart + rowsPerPage;
  const visibleEmployees = filtered.slice(pageStart, pageEnd);
  const showingStart = filtered.length ? pageStart + 1 : 0;
  const showingEnd = Math.min(pageEnd, filtered.length);

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
          <>
            <div className="table-toolbar">
              <div className="rows-control">
                <span>Show</span>
                <select
                  value={rowsPerPage}
                  onChange={e => setRowsPerPage(Number(e.target.value))}
                >
                  {PAGE_SIZES.map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
                <span>entries</span>
              </div>
              <div className="pagination-summary">
                Showing {showingStart}-{showingEnd} of {filtered.length}
              </div>
            </div>

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
                {visibleEmployees.map(e => (
                  <tr key={e.id}>
                    <td>
                      <div className="flex-center" style={{ gap: 8 }}>
                        <div className="avatar">{initials(e.name)}</div>
                        {e.name}
                        {/* 🟢 REMOVED THE FLEET BADGE HERE 🟢 */}
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
                        {e.status === 'inactive' && (
                          <button
                            className="btn btn-icon btn-ghost btn-sm"
                            onClick={() => notify(e)}
                            disabled={notifying === e.id}
                            title="Send inactivity notification email"
                          >
                            {notifying === e.id ? <Loader2 size={13} className="spin" /> : <Mail size={13} />}
                          </button>
                        )}
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

            <div className="pagination-bar">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </button>
              <span className="pagination-page">Page {currentPage} of {totalPages}</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          </>
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