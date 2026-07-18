import { useState, useEffect, useMemo } from 'react';
import { Calendar, Plus, Trash2, Edit2, Repeat, Clock, Users, AlertTriangle, UserCheck, Truck } from 'lucide-react';
import { api } from '../lib/api';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function toISODate(d) {
  return d.toISOString().split('T')[0];
}

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday as start
  date.setDate(date.getDate() + diff);
  return date;
}

function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h, 10);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${m} ${period}`;
}

function ShiftTemplateModal({ templates, onClose, onSave, onDelete, onToast }) {
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
    if (!confirm(`Delete "${t.name}"? Any assignments using it will lose their shift reference.`)) return;
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
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: t.color || '#3b82f6', display: 'inline-block' }} />
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

function AssignShiftModal({ employees, templates, onClose, onAssign, onAssignRecurring, onToast }) {
  const [mode, setMode] = useState('single'); // 'single' | 'recurring'
  const [entryType, setEntryType] = useState(templates.length === 0 ? 'dayoff' : 'shift'); // 'shift' | 'dayoff'
  const today = toISODate(new Date());
  const [form, setForm] = useState({
    employee_id: employees[0]?.id || '',
    shift_template_id: templates[0]?.id || '',
    date: today,
    start_date: today,
    end_date: today,
    days_of_week: [1, 2, 3, 4, 5],
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [autoRestDays, setAutoRestDays] = useState(true); // fill unselected weekdays as rest days (recurring + shift only)
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const toggleDay = (d) => {
    setForm(f => ({
      ...f,
      days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d],
    }));
  };

  const isDayOff = entryType === 'dayoff';
  const fillsRestDays = mode === 'recurring' && !isDayOff && autoRestDays;
  const restComplementDays = fillsRestDays ? [0, 1, 2, 3, 4, 5, 6].filter(d => !form.days_of_week.includes(d)) : [];

  const submit = async () => {
    if (!form.employee_id) return onToast('Select an employee', 'error');
    if (!isDayOff && !form.shift_template_id) return onToast('Select an employee and a shift', 'error');
    setSaving(true);
    try {
      if (mode === 'single') {
        await onAssign({
          employee_id: form.employee_id,
          shift_template_id: isDayOff ? null : form.shift_template_id,
          date: form.date,
          notes: form.notes || null,
          is_day_off: isDayOff,
        });
        onToast(isDayOff ? 'Rest day set' : 'Shift assigned', 'success');
      } else {
        if (form.days_of_week.length === 0) return onToast('Pick at least one day of the week', 'error');
        const result = await onAssignRecurring({
          employee_id: form.employee_id,
          shift_template_id: isDayOff ? null : form.shift_template_id,
          start_date: form.start_date,
          end_date: form.end_date,
          days_of_week: form.days_of_week,
          notes: form.notes || null,
          is_day_off: isDayOff,
        });
        let restCreated = 0;
        if (restComplementDays.length > 0) {
          const restResult = await onAssignRecurring({
            employee_id: form.employee_id,
            shift_template_id: null,
            start_date: form.start_date,
            end_date: form.end_date,
            days_of_week: restComplementDays,
            notes: null,
            is_day_off: true,
          });
          restCreated = restResult.created;
        }
        const skippedCount = (result.skipped || []).length;
        const parts = [];
        parts.push(`${result.created} ${isDayOff ? 'rest day(s)' : 'shift(s)'} assigned`);
        if (restCreated > 0) parts.push(`${restCreated} rest day(s) assigned`);
        onToast(parts.join(' + '), 'success');
        if (skippedCount > 0) {
          const empName = employees.find(e => e.id === form.employee_id)?.name || 'This employee';
          onToast(
            `${empName} is on approved leave, so ${skippedCount} date(s) were skipped: ${result.skipped.join(', ')}`,
            'error'
          );
        }
      }
      onClose();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Assign Shift</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="flex-center gap-2" style={{ marginBottom: 12 }}>
          <button className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('single')}>
            <Calendar size={13} /> Single date
          </button>
          <button className={`btn btn-sm ${mode === 'recurring' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('recurring')}>
            <Repeat size={13} /> Recurring
          </button>
        </div>

        <div className="flex-center gap-2" style={{ marginBottom: 16 }}>
          <button
            className={`btn btn-sm ${entryType === 'shift' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setEntryType('shift')}
            disabled={templates.length === 0}
            title={templates.length === 0 ? 'Add a shift template first' : undefined}
          >
            <Clock size={13} /> Working shift
          </button>
          <button className={`btn btn-sm ${entryType === 'dayoff' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEntryType('dayoff')}>
            Rest day / day off
          </button>
        </div>

        <div className="form-grid">
          <div className="form-group full">
            <label>Employee</label>
            <select value={form.employee_id} onChange={set('employee_id')}>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.employee_id})</option>)}
            </select>
          </div>
          {isDayOff ? (
            <div className="form-group full">
              <p className="text-dim text-sm">
                This will mark the selected date(s) as an explicit rest day — no shift template needed. It'll show up on the schedule so it's clear the day off was intentional, not just unscheduled.
              </p>
            </div>
          ) : (
            <div className="form-group full">
              <label>Shift template</label>
              <select value={form.shift_template_id} onChange={set('shift_template_id')}>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} — {formatTime(t.start_time)} to {formatTime(t.end_time)}</option>)}
              </select>
            </div>
          )}

          {mode === 'single' ? (
            <div className="form-group full">
              <label>Date</label>
              <input type="date" value={form.date} onChange={set('date')} />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Start date</label>
                <input type="date" value={form.start_date} onChange={set('start_date')} />
              </div>
              <div className="form-group">
                <label>End date</label>
                <input type="date" value={form.end_date} onChange={set('end_date')} />
              </div>
              <div className="form-group full">
                <label>Repeat on</label>
                <div className="flex-center gap-2" style={{ flexWrap: 'wrap' }}>
                  {WEEKDAYS.map(d => (
                    <button
                      key={d.value}
                      type="button"
                      className={`btn btn-sm ${form.days_of_week.includes(d.value) ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => toggleDay(d.value)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              {!isDayOff && (
                <div className="form-group full">
                  <label className="flex-center" style={{ gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoRestDays}
                      onChange={e => setAutoRestDays(e.target.checked)}
                      style={{ width: 'auto' }}
                    />
                    Mark the other days as rest day
                  </label>
                  <p className="text-dim text-sm" style={{ marginTop: 4 }}>
                    {autoRestDays && restComplementDays.length > 0
                      ? `${restComplementDays.map(d => WEEKDAYS.find(w => w.value === d)?.label).join(', ')} will be set as rest days in this same date range — no separate step needed.`
                      : autoRestDays
                      ? 'All 7 days are selected as working days, so there are no other days to mark off.'
                      : 'Unselected days will be left as-is (no shift, no rest day recorded).'}
                  </p>
                </div>
              )}
            </>
          )}

          <div className="form-group full">
            <label>Notes (optional)</label>
            <input value={form.notes} onChange={set('notes')} placeholder="e.g. covering for training day" />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : isDayOff ? 'Set Rest Day' : 'Assign Shift'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReplacementModal({ absentDriver, date, onClose, onAssigned, onToast }) {
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assigningId, setAssigningId] = useState(null);

  useEffect(() => {
    (async () => {
      try { setAvailable(await api.getAvailableDrivers(date, absentDriver.id)); }
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
      });
      onToast(`${replacement.name} assigned to cover ${absentDriver.name}'s shift`, 'success');
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
            <div className="empty-state"><Users size={32} /><p>No other fleet drivers are clocked in on {date}</p></div>
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

// Fleet driver roster + coverage for a single day. Deliberately date-scoped
// rather than tied to the week range above it — availability and clock-in
// status are a daily concept, not a weekly one, so it gets its own date picker.
function DriverAvailabilityPanel({ onToast }) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replacing, setReplacing] = useState(null); // driver needing coverage | null

  const load = async () => {
    setLoading(true);
    try { setDrivers(await api.getFleetDrivers(date)); }
    catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [date]);

  const toggleAvailability = async (driver) => {
    const next = driver.driver_availability === 'available' ? 'unavailable' : 'available';
    try {
      await api.setDriverAvailability(driver.id, next);
      onToast(`${driver.name} marked ${next}`, 'success');
      load();
    } catch (e) { onToast(e.message, 'error'); }
  };

  if (!loading && drivers.length === 0) {
    return (
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <div className="flex-center" style={{ gap: 8 }}>
            <Truck size={16} />
            <strong>Fleet Driver Availability</strong>
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 160 }} />
        </div>
        <div className="empty-state"><Truck size={28} /><p>No employees are flagged as fleet drivers</p></div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <div className="flex-center" style={{ gap: 8 }}>
          <Truck size={16} />
          <strong>Fleet Driver Availability</strong>
          {drivers.some(d => d.needs_replacement) && (
            <span className="flex-center" style={{ gap: 6, color: 'var(--danger, #ef4444)' }}>
              <AlertTriangle size={14} />
              {drivers.filter(d => d.needs_replacement).length} need coverage
            </span>
          )}
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 160 }} />
      </div>
      {loading ? (
        <div className="loading"><div className="spinner" /> Loading driver roster…</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Employee ID</th>
                <th>Attendance</th>
                <th>Availability</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map(d => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td className="mono">{d.employee_id}</td>
                  <td>
                    <span className={`badge ${d.attendance_status === 'present' || d.attendance_status === 'late' ? 'active' : 'inactive'}`}>
                      <span className="badge-dot" />{d.attendance_status.replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${d.effective_availability === 'available' ? 'active' : 'inactive'}`}>
                      <span className="badge-dot" />
                      {{
                        available: 'available',
                        unavailable: 'unavailable',
                        absent: 'absent',
                        not_clocked_in: 'not clocked in',
                      }[d.effective_availability]}
                    </span>
                  </td>
                  <td>
                    <div className="flex-center gap-2">
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleAvailability(d)}>
                        Mark {d.driver_availability === 'available' ? 'Unavailable' : 'Available'}
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
      )}

      {replacing && (
        <ReplacementModal
          absentDriver={replacing}
          date={date}
          onClose={() => setReplacing(null)}
          onAssigned={load}
          onToast={onToast}
        />
      )}
    </div>
  );
}

export default function SchedulePage({ onToast }) {
  const [employees, setEmployees] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  const [range, setRange] = useState(() => {
    const start = startOfWeek(new Date());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toISODate(start), end: toISODate(end) };
  });

  const load = async () => {
    setLoading(true);
    try {
      const [emps, tmpls, sched] = await Promise.all([
        api.getEmployees(),
        api.getShiftTemplates(),
        api.getSchedule({ start_date: range.start, end_date: range.end, ...(employeeFilter && { employee_id: employeeFilter }) }),
      ]);
      setEmployees(emps);
      setTemplates(tmpls);
      setAssignments(sched);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [range.start, range.end, employeeFilter]);

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

  const removeAssignment = async (id) => {
    if (!confirm('Remove this shift assignment?')) return;
    try {
      await api.deleteShiftAssignment(id);
      setAssignments(a => a.filter(x => x.id !== id));
      onToast('Assignment removed', 'success');
    } catch (e) { onToast(e.message, 'error'); }
  };

  const shiftWeek = (dir) => {
    const start = new Date(range.start);
    start.setDate(start.getDate() + dir * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    setRange({ start: toISODate(start), end: toISODate(end) });
  };

  const grouped = useMemo(() => {
    const map = {};
    assignments.forEach(a => {
      if (!map[a.date]) map[a.date] = [];
      map[a.date].push(a);
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [assignments]);

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Shift &amp; Schedule Management</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>
            {assignments.filter(a => !a.is_day_off).length} shift(s) · {assignments.filter(a => a.is_day_off).length} rest day(s) scheduled this range
          </p>
        </div>
        <div className="flex-center gap-2">
          <button className="btn btn-ghost" onClick={() => setShowTemplates(true)}>
            <Clock size={14} /> Manage Shift Templates
          </button>
          <button className="btn btn-primary" onClick={() => setShowAssign(true)} disabled={employees.length === 0}>
            <Plus size={14} /> Assign Shift
          </button>
        </div>
      </div>

      <DriverAvailabilityPanel onToast={onToast} />

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="flex-center gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(-1)}>← Prev week</button>
            <span className="mono text-sm">{range.start} → {range.end}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(1)}>Next week →</button>
          </div>
          <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} style={{ width: 200 }}>
            <option value="">All employees</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /> Loading schedule…</div>
        ) : assignments.length === 0 ? (
          <div className="empty-state">
            <Calendar size={36} />
            <p>No shifts or rest days scheduled in this range</p>
            {templates.length === 0 && (
              <p className="text-dim text-sm" style={{ marginTop: 4 }}>
                Add a shift template first if you want to schedule working shifts — rest days can be set without one.
              </p>
            )}
          </div>
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
                    <tr><th>Employee</th><th>Shift</th><th>Time</th><th>Notes</th><th></th></tr>
                  </thead>
                  <tbody>
                    {items.map(a => (
                      <tr key={a.id}>
                        <td>{a.employees?.name || '—'}</td>
                        {a.is_day_off ? (
                          <>
                            <td colSpan={2}>
                              <span className="badge inactive" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <span className="badge-dot" /> Rest day
                              </span>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>
                              <span className="flex-center" style={{ gap: 8 }}>
                                <span style={{ width: 10, height: 10, borderRadius: '50%', background: a.shift_templates?.color || '#3b82f6', display: 'inline-block' }} />
                                {a.shift_templates?.name || '—'}
                              </span>
                            </td>
                            <td className="mono text-sm">
                              {formatTime(a.shift_templates?.start_time)} – {formatTime(a.shift_templates?.end_time)}
                            </td>
                          </>
                        )}
                        <td className="text-muted">{a.notes || '—'}</td>
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

      {showTemplates && (
        <ShiftTemplateModal
          templates={templates}
          onClose={() => setShowTemplates(false)}
          onSave={saveTemplate}
          onDelete={deleteTemplate}
          onToast={onToast}
        />
      )}

      {showAssign && (
        <AssignShiftModal
          employees={employees}
          templates={templates}
          onClose={() => setShowAssign(false)}
          onAssign={async (body) => { const r = await api.assignShift(body); load(); return r; }}
          onAssignRecurring={async (body) => { const r = await api.assignRecurringShift(body); load(); return r; }}
          onToast={onToast}
        />
      )}
    </div>
  );
}