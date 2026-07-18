import { useState, useEffect, useMemo } from 'react';
import { Search, Plus, Edit2, Trash2, Users, AlertTriangle, UserCheck, Calendar, Clock, Repeat, ChevronDown } from 'lucide-react';
import { api } from '../lib/api';

const DEPARTMENTS = ['Engineering', 'Marketing', 'Sales', 'HR', 'Finance', 'Operations', 'Design', 'Product'];
const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

// ─── UTILITY FUNCTIONS ─────────────────────────────────────────────────────
function toISODate(d) {
  return d.toISOString().split('T')[0];
}

function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h, 10);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${m} ${period}`;
}

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

// ─── EMPLOYEE MODAL ─────────────────────────────────────────────────────────
function EmployeeModal({ emp, onClose, onSave }) {
  const [form, setForm] = useState({
    name: '', email: '', employee_id: '', department: '',
    position: '', shift_start: '09:00', shift_end: '18:00', status: 'active',
    is_fleet_driver: false,
    ...emp,
  });
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.name || !form.email || !form.employee_id) return;
    setSaving(true);
    try { 
      await onSave(form); 
      onClose(); 
    }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{emp?.id ? 'Edit Employee' : 'Add Employee'}</span>
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
            <label>Shift Start</label>
            <input type="time" value={form.shift_start} onChange={set('shift_start')} />
          </div>
          <div className="form-group">
            <label>Shift End</label>
            <input type="time" value={form.shift_end} onChange={set('shift_end')} />
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
            {saving ? 'Saving…' : emp?.id ? 'Update Employee' : 'Add Employee'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SHIFT ASSIGNMENT MODAL ────────────────────────────────────────────────
function ShiftAssignmentModal({ employees, templates, departmentFilter, onClose, onAssign, onAssignRecurring, onToast }) {
  const [mode, setMode] = useState('single');
  const today = toISODate(new Date());
  const [form, setForm] = useState({
    employee_id: '',
    shift_template_id: templates[0]?.id || '',
    department: departmentFilter || '',
    date: today,
    start_date: today,
    end_date: today,
    days_of_week: [1, 2, 3, 4, 5],
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  // Filter employees by department if selected
  const filteredEmployees = form.department 
    ? employees.filter(e => e.department === form.department)
    : employees;

  const toggleDay = (d) => {
    setForm(f => ({
      ...f,
      days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d],
    }));
  };

  const submit = async () => {
    if (!form.employee_id || !form.shift_template_id) return onToast('Select an employee and shift template', 'error');
    setSaving(true);
    try {
      if (mode === 'single') {
        await onAssign({ 
          employee_id: form.employee_id, 
          shift_template_id: form.shift_template_id, 
          date: form.date, 
          notes: form.notes || null 
        });
        onToast('Shift assigned', 'success');
      } else {
        if (form.days_of_week.length === 0) return onToast('Pick at least one day of the week', 'error');
        const result = await onAssignRecurring({
          employee_id: form.employee_id,
          shift_template_id: form.shift_template_id,
          start_date: form.start_date,
          end_date: form.end_date,
          days_of_week: form.days_of_week,
          notes: form.notes || null,
        });
        onToast(`${result.created} shift(s) assigned`, 'success');
      }
      onClose();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxHeight: '85vh', overflow: 'auto' }}>
        <div className="modal-header">
          <span className="modal-title">Assign Shift</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="flex-center gap-2" style={{ marginBottom: 16 }}>
          <button className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('single')}>
            <Calendar size={13} /> Single Date
          </button>
          <button className={`btn btn-sm ${mode === 'recurring' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('recurring')}>
            <Repeat size={13} /> Recurring
          </button>
        </div>

        <div className="form-grid">
          <div className="form-group">
            <label>Department (optional)</label>
            <select value={form.department} onChange={set('department')}>
              <option value="">All departments</option>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Employee *</label>
            <select value={form.employee_id} onChange={set('employee_id')}>
              <option value="">Select…</option>
              {filteredEmployees.map(e => (
                <option key={e.id} value={e.id}>{e.name} ({e.department})</option>
              ))}
            </select>
          </div>
          <div className="form-group full">
            <label>Shift Template *</label>
            <select value={form.shift_template_id} onChange={set('shift_template_id')}>
              <option value="">Select…</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({formatTime(t.start_time)} - {formatTime(t.end_time)})
                </option>
              ))}
            </select>
          </div>

          {mode === 'single' ? (
            <div className="form-group full">
              <label>Date *</label>
              <input type="date" value={form.date} onChange={set('date')} />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Start Date *</label>
                <input type="date" value={form.start_date} onChange={set('start_date')} />
              </div>
              <div className="form-group">
                <label>End Date *</label>
                <input type="date" value={form.end_date} onChange={set('end_date')} />
              </div>
              <div className="form-group full">
                <label>Days of Week</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
                  {WEEKDAYS.map(d => (
                    <label key={d.value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={form.days_of_week.includes(d.value)}
                        onChange={() => toggleDay(d.value)}
                        style={{ width: 'auto' }}
                      />
                      {d.label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="form-group full">
            <label>Notes (optional)</label>
            <input value={form.notes} onChange={set('notes')} placeholder="e.g., covering for training day" />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Assigning…' : 'Assign Shift'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SHIFT TEMPLATES MODAL ────────────────────────────────────────────────
function ShiftTemplatesModal({ templates, onClose, onSave, onDelete, onToast }) {
  const empty = { name: '', start_time: '09:00', end_time: '18:00', color: '#3b82f6' };
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const startEdit = (t) => {
    setEditingId(t.id);
    setForm({ name: t.name, start_time: t.start_time?.slice(0, 5), end_time: t.end_time?.slice(0, 5), color: t.color || '#3b82f6' });
  };

  const cancelEdit = () => { setEditingId(null); setForm(empty); };

  const save = async () => {
    if (!form.name || !form.start_time || !form.end_time) return;
    setSaving(true);
    try {
      await onSave(editingId, form);
      cancelEdit();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const del = async (t) => {
    if (!confirm(`Delete "${t.name}"?`)) return;
    try { await onDelete(t.id); }
    catch (e) { onToast(e.message, 'error'); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Shift Templates</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>

        {templates.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Start</th><th>End</th><th></th></tr>
              </thead>
              <tbody>
                {templates.map(t => (
                  <tr key={t.id}>
                    <td>
                      <span className="flex-center" style={{ gap: 8 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: t.color || '#3b82f6' }} />
                        {t.name}
                      </span>
                    </td>
                    <td className="mono text-sm">{formatTime(t.start_time)}</td>
                    <td className="mono text-sm">{formatTime(t.end_time)}</td>
                    <td>
                      <div className="flex-center gap-2">
                        <button className="btn btn-icon btn-ghost btn-sm" onClick={() => startEdit(t)} title="Edit"><Edit2 size={13} /></button>
                        <button className="btn btn-icon btn-danger btn-sm" onClick={() => del(t)} title="Delete"><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-grid">
          <div className="form-group full">
            <label>{editingId ? 'Edit template' : 'New template name'}</label>
            <input value={form.name} onChange={set('name')} placeholder="Morning Shift" />
          </div>
          <div className="form-group">
            <label>Start time</label>
            <input type="time" value={form.start_time} onChange={set('start_time')} />
          </div>
          <div className="form-group">
            <label>End time</label>
            <input type="time" value={form.end_time} onChange={set('end_time')} />
          </div>
          <div className="form-group">
            <label>Color</label>
            <input type="color" value={form.color} onChange={set('color')} style={{ padding: 2, height: 38 }} />
          </div>
        </div>

        <div className="modal-footer">
          {editingId && <button className="btn btn-ghost" onClick={cancelEdit}>Cancel edit</button>}
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.name}>
            {saving ? 'Saving…' : editingId ? 'Update Template' : 'Add Template'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DRIVER REPLACEMENT MODAL ──────────────────────────────────────────────
function FleetDriverReplacementModal({ absentDriver, date, onClose, onAssigned, onToast }) {
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assigningId, setAssigningId] = useState(null);

  useEffect(() => {
    (async () => {
      try { 
        const drivers = await api.getAvailableDrivers(date, absentDriver.id);
        setAvailable(drivers); 
      }
      catch (e) { onToast(e.message, 'error'); }
      finally { setLoading(false); }
    })();
  }, []);

  const assign = async (replacement) => {
    setAssigningId(replacement.id);
    try {
      await api.reassignDriver({
        date,
        original_employee_id: absentDriver.id,
        replacement_employee_id: replacement.id,
        reason: 'Manual assignment',
      });
      onToast(`${replacement.name} assigned to cover ${absentDriver.name}`, 'success');
      onAssigned();
      onClose();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setAssigningId(null); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Find Replacement — {absentDriver.name}</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '0 4px' }}>
          {loading ? (
            <div className="loading"><div className="spinner" /> Checking available drivers…</div>
          ) : available.length === 0 ? (
            <div className="empty-state"><Users size={32} /><p>No other fleet drivers available</p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Name</th><th>Employee ID</th><th>Department</th><th></th></tr>
                </thead>
                <tbody>
                  {available.map(d => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td className="mono">{d.employee_id}</td>
                      <td className="text-muted">{d.department || '—'}</td>
                      <td>
                        <button className="btn btn-primary btn-sm" onClick={() => assign(d)} disabled={assigningId === d.id}>
                          {assigningId === d.id ? 'Assigning…' : 'Assign'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── SCHEDULE VIEW SECTION ────────────────────────────────────────────────
function ScheduleView({ assignments, templates, employeeFilter, departmentFilter, onRemove, onToast }) {
  const [range, setRange] = useState(() => {
    const start = startOfWeek(new Date());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toISODate(start), end: toISODate(end) };
  });

  const shiftWeek = (dir) => {
    const start = new Date(range.start);
    start.setDate(start.getDate() + dir * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    setRange({ start: toISODate(start), end: toISODate(end) });
  };

  // Filter assignments
  const filtered = assignments.filter(a => {
    const matchEmployee = !employeeFilter || a.employee_id === employeeFilter;
    const matchDept = !departmentFilter || a.employees?.department === departmentFilter;
    const inRange = a.date >= range.start && a.date <= range.end;
    return matchEmployee && matchDept && inRange;
  });

  // Group by date
  const grouped = useMemo(() => {
    const map = {};
    filtered.forEach(a => {
      if (!map[a.date]) map[a.date] = [];
      map[a.date].push(a);
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const removeAssignment = async (id) => {
    if (!confirm('Remove this shift assignment?')) return;
    try {
      await api.deleteShiftAssignment(id);
      onRemove(id);
      onToast('Assignment removed', 'success');
    } catch (e) { onToast(e.message, 'error'); }
  };

  return (
    <div className="card">
      <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="flex-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(-1)}>← Prev week</button>
          <span className="mono text-sm">{range.start} → {range.end}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(1)}>Next week →</button>
        </div>
        <span className="text-dim text-sm">{filtered.length} shift(s) scheduled</span>
      </div>

      {grouped.length === 0 ? (
        <div className="empty-state"><Calendar size={36} /><p>No shifts scheduled in this range</p></div>
      ) : (
        grouped.map(([date, items]) => (
          <div key={date} style={{ marginBottom: 20 }}>
            <div className="flex-center" style={{ gap: 8, marginBottom: 8 }}>
              <strong>{new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
              <span className="text-dim text-sm">{date}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Employee</th><th>Department</th><th>Shift</th><th>Time</th><th>Notes</th><th></th></tr>
                </thead>
                <tbody>
                  {items.map(a => (
                    <tr key={a.id}>
                      <td>{a.employees?.name || '—'}</td>
                      <td className="text-muted">{a.employees?.department || '—'}</td>
                      <td>
                        <span className="flex-center" style={{ gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: a.shift_templates?.color || '#3b82f6' }} />
                          {a.shift_templates?.name || '—'}
                        </span>
                      </td>
                      <td className="mono text-sm">
                        {formatTime(a.shift_templates?.start_time)} – {formatTime(a.shift_templates?.end_time)}
                      </td>
                      <td className="text-muted text-sm">{a.notes || '—'}</td>
                      <td>
                        <button className="btn btn-icon btn-danger btn-sm" onClick={() => removeAssignment(a.id)} title="Remove">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── MAIN PAGE COMPONENT ──────────────────────────────────────────────────
export default function EmployeesManagementPage({ onToast }) {
  const [employees, setEmployees] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [fleetDrivers, setFleetDrivers] = useState([]);
  
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  
  const [modal, setModal] = useState(null); // 'employee' | 'shift' | 'templates' | employee_obj
  const [replacing, setReplacing] = useState(null);
  const [expandedDept, setExpandedDept] = useState(null); // for dept sections

  const today = toISODate(new Date());

  // ─── Load data ─────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    try {
      const [employeeList, tmpl, sched, fleetList] = await Promise.all([
        api.getEmployees(),
        api.getShiftTemplates(),
        api.getSchedule({ start_date: today }),
        api.getFleetDrivers(today),
      ]);
      setEmployees(employeeList);
      setTemplates(tmpl);
      setAssignments(sched);
      setFleetDrivers(fleetList);
    }
    catch(e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // ─── Employee management ──────────────────────────────────────────────
  const save = async (form) => {
    try {
      if (form.id) {
        const updated = await api.updateEmployee(form.id, form);
        setEmployees(e => e.map(emp => emp.id === form.id ? updated : emp));
        onToast('Employee updated', 'success');
      } else {
        const created = await api.createEmployee(form);
        setEmployees(e => [created, ...e]);
        onToast('Employee added', 'success');
      }
    } catch(e) { onToast(e.message, 'error'); throw e; }
  };

  const del = async (id) => {
    if (!confirm('Delete this employee?')) return;
    try {
      await api.deleteEmployee(id);
      setEmployees(e => e.filter(emp => emp.id !== id));
      onToast('Employee deleted', 'success');
    } catch(e) { onToast(e.message, 'error'); }
  };

  const toggleAvailability = async (driver) => {
    const newStatus = driver.driver_availability === 'available' ? 'unavailable' : 'available';
    try {
      await api.setDriverAvailability(driver.id, newStatus, 'Manual toggle');
      setFleetDrivers(f => f.map(d => d.id === driver.id ? { ...d, driver_availability: newStatus } : d));
      onToast(`Driver marked ${newStatus}`, 'success');
    } catch (e) { onToast(e.message, 'error'); }
  };

  // ─── Shift management ─────────────────────────────────────────────────
  const saveTemplate = async (id, form) => {
    if (id) {
      const updated = await api.updateShiftTemplate(id, form);
      setTemplates(ts => ts.map(t => t.id === id ? updated : t));
      onToast('Shift template updated', 'success');
    } else {
      const created = await api.createShiftTemplate(form);
      setTemplates(ts => [...ts, created]);
      onToast('Shift template added', 'success');
    }
  };

  const deleteTemplate = async (id) => {
    await api.deleteShiftTemplate(id);
    setTemplates(ts => ts.filter(t => t.id !== id));
    onToast('Shift template deleted', 'success');
  };

  // ─── Data filtering & grouping ───────────────────────────────────────
  const filteredEmployees = employees.filter(e => {
    const q = search.toLowerCase();
    const matchQ = !q || e.name?.toLowerCase().includes(q) || e.email?.toLowerCase().includes(q) || e.employee_id?.toLowerCase().includes(q);
    const matchD = !deptFilter || e.department === deptFilter;
    return matchQ && matchD;
  });

  const depts = [...new Set(employees.map(e => e.department).filter(Boolean))].sort();
  const initials = (name='') => name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);

  // Group employees by department
  const employeesByDept = useMemo(() => {
    const map = {};
    employees.forEach(e => {
      const dept = e.department || 'Unassigned';
      if (!map[dept]) map[dept] = [];
      map[dept].push(e);
    });
    return map;
  }, [employees]);

  // ─── RENDER ─────────────────────────────────────────────────────────
  return (
    <div className="page">
      {/* Header */}
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Employees & Scheduling</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>
            {employees.length} total · {employees.filter(e=>e.status==='active').length} active · Manage shifts per department
          </p>
        </div>
        <div className="flex-center gap-2">
          <button className="btn btn-ghost" onClick={() => setModal('templates')}>
            <Clock size={14} /> Shift Templates
          </button>
          <button className="btn btn-primary" onClick={() => setModal('add')}>
            <Plus size={14} /> Add Employee
          </button>
        </div>
      </div>

      {/* Fleet Driver Status */}
      {fleetDrivers.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <div className="flex-center" style={{ gap: 8 }}>
              <strong>🚗 Fleet Driver Status</strong>
              <span className="text-dim text-sm">{today}</span>
            </div>
            {fleetDrivers.some(d => d.needs_replacement) && (
              <span className="flex-center" style={{ gap: 6, color: 'var(--danger, #ef4444)' }}>
                <AlertTriangle size={14} />
                {fleetDrivers.filter(d => d.needs_replacement).length} need coverage
              </span>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Employee ID</th>
                  <th>Department</th>
                  <th>Status Today</th>
                  <th>Availability</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {fleetDrivers.map(d => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="mono">{d.employee_id}</td>
                    <td className="text-muted">{d.department || '—'}</td>
                    <td>
                      <span className={`badge ${d.attendance_status === 'present' || d.attendance_status === 'late' ? 'active' : 'inactive'}`}>
                        <span className="badge-dot" />{d.attendance_status.replace('_', ' ')}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${d.effective_availability === 'available' ? 'active' : 'inactive'}`}>
                        <span className="badge-dot" />
                        {d.effective_availability === 'not_clocked_in' ? 'Not clocked in' : d.effective_availability}
                      </span>
                    </td>
                    <td>
                      <div className="flex-center gap-2">
                        <button className="btn btn-ghost btn-sm" onClick={() => toggleAvailability(d)}>
                          {d.driver_availability === 'available' ? 'Mark Unavailable' : 'Mark Available'}
                        </button>
                        {d.needs_replacement && (
                          <button className="btn btn-primary btn-sm" onClick={() => setReplacing(d)}>
                            <UserCheck size={13} /> Find Replacement
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Shift Assignment & Schedule View */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <div className="flex-center gap-2">
            <span className="text-dim">Filter schedule by:</span>
            <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ width: 180 }}>
              <option value="">All departments</option>
              {depts.map(d => <option key={d}>{d}</option>)}
            </select>
            <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} style={{ width: 200 }}>
              <option value="">All employees</option>
              {filteredEmployees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={() => setModal('shift')} disabled={templates.length === 0}>
            <Plus size={14} /> Assign Shift
          </button>
        </div>
        <ScheduleView 
          assignments={assignments}
          templates={templates}
          employeeFilter={employeeFilter}
          departmentFilter={deptFilter}
          onRemove={(id) => setAssignments(a => a.filter(x => x.id !== id))}
          onToast={onToast}
        />
      </div>

      {/* Employees by Department */}
      {depts.map(dept => {
        const deptEmployees = employeesByDept[dept];
        const isExpanded = expandedDept === dept;
        
        return (
          <div key={dept} className="card" style={{ marginBottom: 20 }}>
            <button
              className="flex-between"
              style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 12 }}
              onClick={() => setExpandedDept(isExpanded ? null : dept)}
            >
              <div>
                <strong style={{ fontSize: 16 }}>{dept}</strong>
                <span className="text-dim text-sm" style={{ marginLeft: 12 }}>({deptEmployees.length} people)</span>
              </div>
              <ChevronDown size={18} style={{ transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }} />
            </button>

            {isExpanded && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Employee ID</th>
                      <th>Email</th>
                      <th>Position</th>
                      <th>Shift</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deptEmployees.map(e => (
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
                        <td className="text-muted text-sm">{e.email}</td>
                        <td>{e.position || '—'}</td>
                        <td className="mono text-sm">{e.shift_start} – {e.shift_end}</td>
                        <td>
                          <span className={`badge ${e.status}`}><span className="badge-dot" />{e.status}</span>
                        </td>
                        <td>
                          <div className="flex-center gap-2">
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
        );
      })}

      {/* Search & Filter for All Employees */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div className="search-bar" style={{ flex: 1 }}>
            <Search />
            <input placeholder="Search by name, email, or ID…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {/* All Employees Table */}
      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /> Loading data…</div>
        ) : filteredEmployees.length === 0 ? (
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
                  <th>Shift</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map(e => (
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
                    <td className="mono text-sm">{e.shift_start} – {e.shift_end}</td>
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

      {/* Modals */}
      {modal === 'add' || (modal?.id && modal.id) ? (
        <EmployeeModal
          emp={modal?.id ? modal : null}
          onClose={() => setModal(null)}
          onSave={save}
        />
      ) : null}

      {modal === 'shift' && (
        <ShiftAssignmentModal
          employees={employees}
          templates={templates}
          departmentFilter={deptFilter}
          onClose={() => setModal(null)}
          onAssign={async (body) => { const r = await api.assignShift(body); setAssignments(a => [...a, r]); return r; }}
          onAssignRecurring={async (body) => { const r = await api.assignRecurringShift(body); load(); return r; }}
          onToast={onToast}
        />
      )}

      {modal === 'templates' && (
        <ShiftTemplatesModal
          templates={templates}
          onClose={() => setModal(null)}
          onSave={saveTemplate}
          onDelete={deleteTemplate}
          onToast={onToast}
        />
      )}

      {replacing && (
        <FleetDriverReplacementModal
          absentDriver={replacing}
          date={today}
          onClose={() => setReplacing(null)}
          onAssigned={load}
          onToast={onToast}
        />
      )}
    </div>
  );
}