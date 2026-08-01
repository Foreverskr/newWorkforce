import { useState, useEffect, useMemo } from 'react';
import { Calendar, Plus, Trash2, Clock, AlertTriangle, Truck, Users, UserCheck, ClipboardList, Edit2, CheckCircle2, Filter } from 'lucide-react';
import { api } from '../lib/api';

// ─── Date Helpers ──────────────────────────────────────────────────────────────
function toISODate(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
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

function StatusBadge({ status, gap }) {
  if (status === 'full') return <span className="badge active" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={12} /> Full</span>;
  if (status === 'understaffed') return <span className="badge inactive" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--danger, #ef4444)' }}><AlertTriangle size={12} /> Short {gap}</span>;
  return <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>+{Math.abs(gap)} over</span>;
}

// ─── Sub-Components ─────────────────────────────────────────────────────────────
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
    try { await onSave(editingId, form); cancelEdit(); } 
    catch (e) { onToast(e.message, 'error'); } 
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
        <div className="modal-header"><span className="modal-title">Shift Templates</span><button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button></div>
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table><thead><tr><th>Name</th><th>Start</th><th>End</th><th></th></tr></thead>
            <tbody>{templates.map(t => (
              <tr key={t.id}><td><span className="flex-center" style={{ gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: t.color || '#3b82f6' }} /> {t.name}</span></td>
                <td className="mono text-sm">{formatTime(t.start_time)}</td><td className="mono text-sm">{formatTime(t.end_time)}</td>
                <td><div className="flex-center gap-2"><button className="btn btn-icon btn-ghost btn-sm" onClick={() => startEdit(t)}><Clock size={13} /></button><button className="btn btn-icon btn-danger btn-sm" onClick={() => del(t)}><Trash2 size={13} /></button></div></td>
              </tr>
            ))}</tbody></table>
        </div>
        <div className="form-grid">
          <div className="form-group full"><label>Name</label><input value={form.name} onChange={set('name')} placeholder="Morning Shift" /></div>
          <div className="form-group"><label>Start</label><input type="time" value={form.start_time} onChange={set('start_time')} /></div>
          <div className="form-group"><label>End</label><input type="time" value={form.end_time} onChange={set('end_time')} /></div>
          <div className="form-group"><label>Color</label><input type="color" value={form.color} onChange={set('color')} style={{ padding: 2, height: 38 }} /></div>
        </div>
        <div className="modal-footer">{editingId && <button className="btn btn-ghost" onClick={cancelEdit}>Cancel</button>}<button className="btn btn-primary" onClick={save} disabled={saving || !form.name}>{saving ? 'Saving…' : editingId ? 'Update' : 'Add'}</button></div>
      </div>
    </div>
  );
}

function AssignShiftModal({ employees, templates, onClose, onAssign, onAssignRecurring, onToast }) {
  const [mode, setMode] = useState('single');
  const [entryType, setEntryType] = useState(templates.length === 0 ? 'dayoff' : 'shift');
  const today = toISODate(new Date());
  const [form, setForm] = useState({ employee_id: employees[0]?.id || '', shift_template_id: templates[0]?.id || '', date: today, start_date: today, end_date: today, days_of_week: [1, 2, 3, 4, 5], notes: '' });
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const toggleDay = (d) => setForm(f => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d] }));
  const isDayOff = entryType === 'dayoff';

  const submit = async () => {
    if (!form.employee_id) return onToast('Select an employee', 'error');
    if (!isDayOff && !form.shift_template_id) return onToast('Select a shift', 'error');
    setSaving(true);
    try {
      if (mode === 'single') await onAssign({ employee_id: form.employee_id, shift_template_id: isDayOff ? null : form.shift_template_id, date: form.date, notes: form.notes || null, is_day_off: isDayOff });
      else {
        if (form.days_of_week.length === 0) return onToast('Pick at least one day', 'error');
        await onAssignRecurring({ employee_id: form.employee_id, shift_template_id: isDayOff ? null : form.shift_template_id, start_date: form.start_date, end_date: form.end_date, days_of_week: form.days_of_week, notes: form.notes || null, is_day_off: isDayOff });
      }
      onToast(isDayOff ? 'Rest day set' : 'Shift assigned', 'success');
      onClose();
    } catch (e) { onToast(e.message, 'error'); } 
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header"><span className="modal-title">Assign Shift</span><button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button></div>
        <div className="flex-center gap-2" style={{ marginBottom: 12 }}><button className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('single')}><Calendar size={13} /> Single</button><button className={`btn btn-sm ${mode === 'recurring' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('recurring')}><Clock size={13} /> Recurring</button></div>
        <div className="flex-center gap-2" style={{ marginBottom: 16 }}><button className={`btn btn-sm ${entryType === 'shift' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEntryType('shift')} disabled={templates.length === 0}><Clock size={13} /> Shift</button><button className={`btn btn-sm ${entryType === 'dayoff' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEntryType('dayoff')}>Rest day</button></div>
        <div className="form-grid">
          <div className="form-group full"><label>Employee</label><select value={form.employee_id} onChange={set('employee_id')}>{employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
          {!isDayOff && <div className="form-group full"><label>Shift template</label><select value={form.shift_template_id} onChange={set('shift_template_id')}>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>}
          {mode === 'single' ? (<div className="form-group full"><label>Date</label><input type="date" value={form.date} onChange={set('date')} /></div>) : (
            <><div className="form-group"><label>Start</label><input type="date" value={form.start_date} onChange={set('start_date')} /></div><div className="form-group"><label>End</label><input type="date" value={form.end_date} onChange={set('end_date')} /></div><div className="form-group full"><label>Repeat on</label><div className="flex-center gap-2" style={{ flexWrap: 'wrap' }}>{[1,2,3,4,5,6,0].map(d => <button key={d} type="button" className={`btn btn-sm ${form.days_of_week.includes(d) ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggleDay(d)}>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]}</button>)}</div></div></>
          )}
          <div className="form-group full"><label>Notes</label><input value={form.notes} onChange={set('notes')} placeholder="Optional" /></div>
        </div>
        <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Assign'}</button></div>
      </div>
    </div>
  );
}

// ─── Driver Availability Panel ──────────────────────────────────────────────────
function ReplacementModal({ absentDriver, date, onClose, onAssigned, onToast }) {
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assigningId, setAssigningId] = useState(null);
  useEffect(() => {
    (async () => { try { setAvailable(await api.getAvailableDrivers(date, absentDriver.id)); } catch (e) { onToast(e.message, 'error'); } finally { setLoading(false); } })();
  }, []);
  const assign = async (replacement) => {
    setAssigningId(replacement.id);
    try { await api.reassignDriver({ date, original_employee_id: absentDriver.id, replacement_employee_id: replacement.id }); onToast(`${replacement.name} assigned to cover`, 'success'); onAssigned(); onClose(); } 
    catch (e) { onToast(e.message, 'error'); } 
    finally { setAssigningId(null); }
  };
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header"><span className="modal-title">Find Replacement</span><button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button></div>
        <div style={{ padding: '0 4px' }}>
          {loading ? <div className="loading"><div className="spinner" /> Loading...</div> : available.length === 0 ? <div className="empty-state"><Users size={32} /><p>No other drivers available</p></div> : (
            <div className="table-wrap"><table><thead><tr><th>Name</th><th></th></tr></thead><tbody>{available.map(d => <tr key={d.id}><td>{d.name}</td><td><button className="btn btn-primary btn-sm" onClick={() => assign(d)} disabled={assigningId === d.id}>{assigningId === d.id ? '...' : 'Assign'}</button></td></tr>)}</tbody></table></div>
          )}
        </div>
        <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function DriverAvailabilityPanel({ onToast }) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replacing, setReplacing] = useState(null);
  const load = async () => { setLoading(true); try { setDrivers(await api.getFleetDrivers(date)); } catch (e) { onToast(e.message, 'error'); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [date]);
  const toggleAvailability = async (driver) => {
    const next = driver.driver_availability === 'available' ? 'unavailable' : 'available';
    try { await api.setDriverAvailability(driver.id, next); onToast(`${driver.name} marked ${next}`, 'success'); load(); } catch (e) { onToast(e.message, 'error'); }
  };
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <div className="flex-center" style={{ gap: 8 }}><Truck size={16} /><strong>Fleet Driver Availability</strong>
          {drivers.some(d => d.needs_replacement) && <span className="flex-center" style={{ gap: 6, color: 'var(--danger, #ef4444)' }}><AlertTriangle size={14} />{drivers.filter(d => d.needs_replacement).length} need coverage</span>}
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 160 }} />
      </div>
      {loading ? <div className="loading"><div className="spinner" /> Loading...</div> : (
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th></th></tr></thead><tbody>{drivers.map(d => <tr key={d.id}><td>{d.name}</td><td><span className={`badge ${d.effective_availability === 'available' ? 'active' : 'inactive'}`}>{d.effective_availability}</span></td><td><div className="flex-center gap-2"><button className="btn btn-ghost btn-sm" onClick={() => toggleAvailability(d)}>Toggle</button>{d.needs_replacement && <button className="btn btn-primary btn-sm" onClick={() => setReplacing(d)}><UserCheck size={13} /> Replace</button>}</div></td></tr>)}</tbody></table></div>
      )}
      {replacing && <ReplacementModal absentDriver={replacing} date={date} onClose={() => setReplacing(null)} onAssigned={load} onToast={onToast} />}
    </div>
  );
}

// ─── MAIN SCHEDULE PAGE (MERGED VIEW - LIST + GRID) ──────────────────────────
export default function SchedulePage({ onToast }) {
  const [employees, setEmployees] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [positions, setPositions] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [totals, setTotals] = useState({ total_required: 0, total_assigned: 0, understaffed_slots: 0 });
  const [loading, setLoading] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  
  // Requirement Modal State
  const [showReqModal, setShowReqModal] = useState(false);
  const [editingReq, setEditingReq] = useState(null);

  // 🟢 NEW: Position Filter State
  const [positionFilter, setPositionFilter] = useState('all');

  const [range, setRange] = useState(() => {
    const start = startOfWeek(new Date());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toISODate(start), end: toISODate(end) };
  });

  const load = async () => {
    setLoading(true);
    try {
      const [emps, tmpls, positionsList, sched, cov] = await Promise.all([
        api.getEmployees(),
        api.getShiftTemplates(),
        api.getPositions(),
        api.getSchedule({ start_date: range.start, end_date: range.end }),
        api.getCoverage({ start_date: range.start, end_date: range.end }),
      ]);
      setEmployees(emps);
      setTemplates(tmpls);
      setPositions(positionsList);
      setAssignments(sched);
      setCoverage(cov.coverage);
      setTotals(cov.totals);
    } catch (e) { onToast(e.message, 'error'); } 
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [range.start, range.end]);

  const saveTemplate = async (id, form) => {
    if (id) { const updated = await api.updateShiftTemplate(id, form); setTemplates(ts => ts.map(t => t.id === id ? updated : t)); } 
    else { const created = await api.createShiftTemplate(form); setTemplates(ts => [...ts, created]); }
    onToast('Template saved', 'success');
  };
  const deleteTemplate = async (id) => { await api.deleteShiftTemplate(id); setTemplates(ts => ts.filter(t => t.id !== id)); onToast('Template deleted', 'success'); };

  const removeAssignment = async (id) => {
    if (!confirm('Remove this assignment?')) return;
    try { await api.deleteShiftAssignment(id); setAssignments(a => a.filter(x => x.id !== id)); onToast('Assignment removed', 'success'); } 
    catch (e) { onToast(e.message, 'error'); }
  };

  const removeRequirement = async (row) => {
    if (!confirm(`Remove requirement for ${row.positions?.name || 'position'}?`)) return;
    try { await api.deleteStaffingRequirement(row.id); onToast('Requirement removed', 'success'); load(); } 
    catch (e) { onToast(e.message, 'error'); }
  };

  // ─── CALENDAR GRID LOGIC ──────────────────────────────────────────────────────
  const datesInRange = useMemo(() => {
    const dates = [];
    let current = new Date(range.start);
    const end = new Date(range.end);
    while (current <= end) { dates.push(toISODate(current)); current.setDate(current.getDate() + 1); }
    return dates;
  }, [range]);

  const assignmentMap = useMemo(() => {
    const map = {};
    assignments.forEach(a => { if (!map[a.date]) map[a.date] = {}; map[a.date][a.employee_id] = a; });
    return map;
  }, [assignments]);

  const activeEmployees = useMemo(() => employees.filter(e => e.status === 'active'), [employees]);
  const totalShifts = assignments.filter(a => !a.is_day_off).length;
  const totalRestDays = assignments.filter(a => a.is_day_off).length;

  // ─── REQUIREMENT MODAL LOGIC ──────────────────────────────────────────────────
  const saveRequirement = async () => {
    try {
      if (editingReq?.id) {
        await api.updateStaffingRequirement(editingReq.id, { required_count: editingReq.required_count, notes: editingReq.notes });
      } else {
        await api.createStaffingRequirement({
          position_id: editingReq.position_id,
          shift_template_id: editingReq.shift_template_id,
          date: editingReq.date,
          required_count: editingReq.required_count,
          notes: editingReq.notes
        });
      }
      onToast('Requirement saved', 'success');
      setShowReqModal(false);
      load();
    } catch (e) { onToast(e.message, 'error'); }
  };

  const shiftWeek = (dir) => {
    const s = new Date(range.start); s.setDate(s.getDate() + dir * 7);
    const e = new Date(s); e.setDate(e.getDate() + 6);
    setRange({ start: toISODate(s), end: toISODate(e) });
  };

  // 🟢 FILTERED DATA for Requirements
  const filteredCoverage = useMemo(() => {
    if (positionFilter === 'all') return coverage;
    return coverage.filter(c => c.positions?.name === positionFilter);
  }, [coverage, positionFilter]);

  // 🟢 FILTERED DATA for Employees Grid
  const filteredEmployees = useMemo(() => {
    if (positionFilter === 'all') return activeEmployees;
    return activeEmployees.filter(e => e.position === positionFilter);
  }, [activeEmployees, positionFilter]);

  // Group coverage by date for the list view
  const groupedCoverage = useMemo(() => {
    const map = {};
    filteredCoverage.forEach(c => { (map[c.date] ||= []).push(c); });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredCoverage]);

  return (
    <div className="page">
      {/* Header */}
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Shift &amp; Schedule Management</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{totalShifts} shift(s) · {totalRestDays} rest day(s) scheduled</p>
        </div>
        <div className="flex-center gap-2">
          <button className="btn btn-ghost" onClick={() => setShowTemplates(true)}><Clock size={14} /> Manage Templates</button>
          <button className="btn btn-primary" onClick={() => setShowAssign(true)} disabled={employees.length === 0}><Plus size={14} /> Assign Shift</button>
        </div>
      </div>

      {/* Driver Availability (Separate Card) */}
      <DriverAvailabilityPanel onToast={onToast} />

      {/* 🌟 MERGED PANEL (Requirements LIST + Schedule GRID) */}
      <div className="card">
        {/* Panel Controls (Date range + Actions + Filter) */}
        <div className="flex-between" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', marginBottom: 0, flexWrap: 'wrap', gap: '12px' }}>
          <div className="flex-center gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(-1)}>← Prev week</button>
            <span className="mono text-sm">{range.start} → {range.end}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(1)}>Next week →</button>
          </div>
          <div className="flex-center gap-2" style={{ flexWrap: 'wrap' }}>
            <span className="text-dim text-sm">{totals.total_assigned}/{totals.total_required} filled</span>
            {totals.understaffed_slots > 0 && (
              <span className="flex-center" style={{ gap: 6, color: 'var(--danger, #ef4444)' }}><AlertTriangle size={14} /> {totals.understaffed_slots} short-staffed</span>
            )}
            
            {/* 🟢 NEW DROPDOWN FILTER */}
            <div className="flex-center" style={{ gap: 6 }}>
              <Filter size={14} className="text-dim" />
              <select 
                value={positionFilter} 
                onChange={e => setPositionFilter(e.target.value)}
                style={{ padding: '4px 8px', fontSize: '0.85rem', borderRadius: '4px', border: '1px solid var(--border)' }}
              >
                <option value="all">All Positions</option>
                {positions.map(p => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>

            <button 
              className="btn btn-primary btn-sm" 
              onClick={() => { 
                setEditingReq({ 
                  position_id: positions[0]?.id || '', 
                  shift_template_id: templates[0]?.id || '', 
                  date: toISODate(new Date()), 
                  required_count: 1, 
                  notes: '' 
                }); 
                setShowReqModal(true); 
              }} 
              disabled={positions.length === 0 || templates.length === 0}
            >
              <Plus size={13} /> Set Requirement
            </button>
          </div>
        </div>

        {loading ? (
          <div className="loading" style={{ padding: 40 }}><div className="spinner" /> Loading…</div>
        ) : (
          <>
            {/* 1. STAFFING REQUIREMENTS LIST */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-light)' }}>
              <div className="flex-center" style={{ gap: 8, marginBottom: 12 }}>
                <ClipboardList size={16} />
                <strong>Staffing Requirements</strong>
                {positionFilter !== 'all' && <span className="badge active" style={{ fontSize: '0.7rem' }}>Filtered: {positionFilter}</span>}
              </div>
              
              {filteredCoverage.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px 0' }}>
                  <ClipboardList size={28} />
                  <p>{positionFilter === 'all' ? 'No staffing requirements set for this range' : `No staffing requirements found for "${positionFilter}"`}</p>
                </div>
              ) : (
                groupedCoverage.map(([date, rows]) => (
                  <div key={date} style={{ marginBottom: 16 }}>
                    <div className="flex-center" style={{ gap: 8, marginBottom: 6 }}>
                      <strong style={{ fontSize: '0.9rem' }}>{new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
                      <span className="text-dim text-sm">{date}</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Position</th><th>Shift</th><th>Required</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
                        <tbody>
                          {rows.map(r => (
                            <tr key={r.id}>
                              <td><strong>{r.positions?.name || '—'}</strong></td>
                              <td><span className="flex-center" style={{ gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: r.roles?.color || '#3b82f6', display: 'inline-block' }} /> {r.roles?.name || '—'}</span></td>
                              <td className="mono text-sm">{r.required_count}</td>
                              <td className="mono text-sm" title={r.assigned_employees.map(e => e.name).join(', ') || undefined}>{r.assigned_count}</td>
                              <td><StatusBadge status={r.status} gap={r.gap} /></td>
                              <td>
                                <div className="flex-center gap-2">
                                  <button className="btn btn-icon btn-ghost btn-sm" onClick={() => { setEditingReq(r); setShowReqModal(true); }} title="Edit"><Edit2 size={13} /></button>
                                  <button className="btn btn-icon btn-danger btn-sm" onClick={() => removeRequirement(r)} title="Remove"><Trash2 size={13} /></button>
                                </div>
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

            {/* 2. EMPLOYEE SCHEDULE GRID */}
            <div style={{ padding: '16px 20px' }}>
              {filteredEmployees.length === 0 ? (
                <div className="empty-state"><Calendar size={36} /><p>{positionFilter === 'all' ? 'No active employees found.' : `No active employees with position "${positionFilter}" found.`}</p></div>
              ) : assignments.length === 0 ? (
                <div className="empty-state"><Calendar size={36} /><p>No shifts or rest days scheduled in this range.</p></div>
              ) : (
                <div className="table-wrap">
                  <table className="schedule-grid" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '12px 16px', borderBottom: '2px solid var(--border)', minWidth: '160px' }}>Employee</th>
                        {datesInRange.map(date => (
                          <th key={date} style={{ textAlign: 'center', padding: '8px', borderBottom: '2px solid var(--border)', minWidth: '80px' }}>
                            <div style={{ fontWeight: 600, fontSize: '0.75rem' }}>{new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</div>
                            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEmployees.map(emp => (
                        <tr key={emp.id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                          <td style={{ padding: '8px 16px', fontWeight: 500 }}>
                            {emp.name}
                            <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>{emp.employee_id} · {emp.position || '—'}</div>
                          </td>
                          {datesInRange.map(date => {
                            const assignment = assignmentMap[date]?.[emp.id];
                            const isDayOff = assignment?.is_day_off;
                            const shiftData = assignment?.shift_templates;

                            let cellContent;
                            let cellStyle = { padding: '8px', textAlign: 'center', verticalAlign: 'middle' };

                            if (!assignment) cellContent = <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>;
                            else if (isDayOff) cellContent = <span className="badge inactive" style={{ display: 'inline-block', padding: '4px 10px', borderRadius: '4px', fontSize: '0.75rem' }}>Rest day</span>;
                            else cellContent = (
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: shiftData?.color || '#3b82f6', color: '#fff', borderRadius: '6px', padding: '6px 4px', position: 'relative' }}>
                                <strong style={{ fontSize: '0.75rem', marginBottom: '2px' }}>{shiftData?.name || 'Shift'}</strong>
                                <span style={{ fontSize: '0.65rem', opacity: 0.9 }}>{formatTime(shiftData?.start_time)} - {formatTime(shiftData?.end_time)}</span>
                                <button className="btn btn-icon btn-danger" style={{ position: 'absolute', top: '-6px', right: '-6px', width: '18px', height: '18px', padding: 0, fontSize: '10px', borderRadius: '50%' }} onClick={() => removeAssignment(assignment.id)}><Trash2 size={10} /></button>
                              </div>
                            );
                            return <td key={date} style={cellStyle}>{cellContent}</td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {showTemplates && <ShiftTemplateModal templates={templates} onClose={() => setShowTemplates(false)} onSave={saveTemplate} onDelete={deleteTemplate} onToast={onToast} />}
      {showAssign && <AssignShiftModal employees={employees} templates={templates} onClose={() => setShowAssign(false)} onAssign={async (b) => { await api.assignShift(b); load(); }} onAssignRecurring={async (b) => { await api.assignRecurringShift(b); load(); }} onToast={onToast} />}
      
      {showReqModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">{editingReq?.id ? 'Edit Requirement' : 'Set Requirement'}</span>
              <button className="btn btn-icon btn-ghost" onClick={() => setShowReqModal(false)}>✕</button>
            </div>
            <div className="form-grid">
              <div className="form-group full">
                <label>Position</label>
                <select value={editingReq?.position_id || ''} onChange={e => setEditingReq(r => ({ ...r, position_id: e.target.value }))} disabled={!!editingReq?.id}>
                  {positions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="form-group full">
                <label>Shift / Role</label>
                <select value={editingReq?.shift_template_id || ''} onChange={e => setEditingReq(r => ({ ...r, shift_template_id: e.target.value }))} disabled={!!editingReq?.id}>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Date</label>
                <input 
                  type="date" 
                  value={editingReq?.date || toISODate(new Date())} 
                  onChange={e => setEditingReq(r => ({ ...r, date: e.target.value }))} 
                  disabled={!!editingReq?.id} 
                />
              </div>
              <div className="form-group">
                <label>Required</label>
                <input type="number" min="1" value={editingReq?.required_count || 1} onChange={e => setEditingReq(r => ({ ...r, required_count: parseInt(e.target.value) }))} />
              </div>
              <div className="form-group full">
                <label>Notes</label>
                <input value={editingReq?.notes || ''} onChange={e => setEditingReq(r => ({ ...r, notes: e.target.value }))} placeholder="Optional" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowReqModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveRequirement}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}