import { useState, useEffect, useMemo, useRef } from 'react';
import { Calendar, Plus, Trash2, Clock, AlertTriangle, Truck, Users, UserCheck, Search, Sun, Moon, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import { getRole, getCurrentUser } from '../utils/session.js';

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

// Compact "9AM" / "6:30PM" style time, for tight schedule cells
function shortTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  let hour = h % 12;
  if (hour === 0) hour = 12;
  return m === 0 ? `${hour}${period}` : `${hour}:${String(m).padStart(2, '0')}${period}`;
}

function shortRange(start, end) {
  if (!start || !end) return '';
  return `${shortTime(start)}-${shortTime(end)}`;
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f43f5e'];
function avatarColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function shiftIcon(name = '') {
  const n = name.toLowerCase();
  if (n.includes('morning') || n.includes('day')) return Sun;
  if (n.includes('night')) return Moon;
  return Clock;
}

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// A leave record covers either a single `date` field, or a `start_date`/`end_date`
// range, depending on how it comes back from /leaves — handle both shapes so this
// doesn't silently stop matching if the API changes which one it sends.
function leaveCoversDate(leave, date) {
  if (leave.date) return leave.date === date;
  if (leave.start_date && leave.end_date) return date >= leave.start_date && date <= leave.end_date;
  return false;
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

function AssignShiftModal({ employees, templates, positions, defaultPosition, directWrite, onClose, onAssign, onAssignRecurring, onToast }) {
  const [mode, setMode] = useState('single');
  const [entryType, setEntryType] = useState(templates.length === 0 ? 'dayoff' : 'shift');
  const [positionFilter, setPositionFilter] = useState(defaultPosition || 'all');
  const today = toISODate(new Date());

  const firstMatch = (positionFilter === 'all' ? employees : employees.filter(e => e.position === positionFilter))[0];
  const [form, setForm] = useState({ employee_id: firstMatch?.id || employees[0]?.id || '', shift_template_id: templates[0]?.id || '', date: today, start_date: today, end_date: today, days_of_week: [1, 2, 3, 4, 5], notes: '' });
  const [saving, setSaving] = useState(false);
  const [autoRestDays, setAutoRestDays] = useState(true);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const toggleDay = (d) => setForm(f => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d] }));
  const isDayOff = entryType === 'dayoff';

  const employeesByPosition = useMemo(() => {
    const filtered = positionFilter === 'all' ? employees : employees.filter(e => e.position === positionFilter);
    const groups = {};
    filtered.forEach(e => {
      const key = e.position || 'Unassigned';
      (groups[key] ||= []).push(e);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [employees, positionFilter]);

  const submit = async () => {
    if (!form.employee_id) return onToast('Select an employee', 'error');
    if (!isDayOff && !form.shift_template_id) return onToast('Select a shift', 'error');
    setSaving(true);
    try {
      if (mode === 'single') {
        await onAssign({ employee_id: form.employee_id, shift_template_id: isDayOff ? null : form.shift_template_id, date: form.date, notes: form.notes || null, is_day_off: isDayOff });
      } else {
        if (form.days_of_week.length === 0) return onToast('Pick at least one day', 'error');
        await onAssignRecurring({ employee_id: form.employee_id, shift_template_id: isDayOff ? null : form.shift_template_id, start_date: form.start_date, end_date: form.end_date, days_of_week: form.days_of_week, notes: form.notes || null, is_day_off: isDayOff });

        // The days NOT picked above would otherwise stay blank in the schedule —
        // fill them in as rest days for the same range so every day is accounted for.
        if (!isDayOff && autoRestDays) {
          const restDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !form.days_of_week.includes(d));
          if (restDays.length > 0) {
            await onAssignRecurring({ employee_id: form.employee_id, shift_template_id: null, start_date: form.start_date, end_date: form.end_date, days_of_week: restDays, notes: null, is_day_off: true });
          }
        }
      }
      const verb = directWrite ? (isDayOff ? 'Rest day set' : 'Shift assigned') : (isDayOff ? 'Rest day proposed — pending approval' : 'Shift proposed — pending approval');
      onToast(verb, 'success');
      onClose();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header"><span className="modal-title">{directWrite ? 'Assign Shift' : 'Propose Shift'}</span><button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button></div>
        <div className="flex-center gap-2" style={{ marginBottom: 12 }}>
          <button className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('single')}><Calendar size={13} /> Single</button>
          <button className={`btn btn-sm ${mode === 'recurring' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('recurring')}><Clock size={13} /> Recurring</button>
        </div>
        <div className="flex-center gap-2" style={{ marginBottom: 16 }}>
          <button className={`btn btn-sm ${entryType === 'shift' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEntryType('shift')} disabled={templates.length === 0}><Clock size={13} /> Shift</button>
          <button className={`btn btn-sm ${entryType === 'dayoff' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEntryType('dayoff')}>Rest day</button>
        </div>
        <div className="form-grid">
          <div className="form-group full">
            <label>Filter by position</label>
            <select value={positionFilter} onChange={e => setPositionFilter(e.target.value)}>
              <option value="all">All positions</option>
              {positions.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </div>

          <div className="form-group full">
            <label>Employee</label>
            <select value={form.employee_id} onChange={set('employee_id')}>
              {employeesByPosition.map(([position, emps]) => (
                <optgroup key={position} label={position}>
                  {emps.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          {!isDayOff && (
            <div className="form-group full">
              <label>Shift template</label>
              <select value={form.shift_template_id} onChange={set('shift_template_id')}>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
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
                <label>Start</label>
                <input type="date" value={form.start_date} onChange={set('start_date')} />
              </div>
              <div className="form-group">
                <label>End</label>
                <input type="date" value={form.end_date} onChange={set('end_date')} />
              </div>
              <div className="form-group full">
                <label>Repeat on</label>
                <div className="flex-center gap-2" style={{ flexWrap: 'wrap' }}>
                  {[1, 2, 3, 4, 5, 6, 0].map(d => (
                    <button key={d} type="button" className={`btn btn-sm ${form.days_of_week.includes(d) ? 'btn-primary' : 'btn-ghost'}`} onClick={() => toggleDay(d)}>
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}
                    </button>
                  ))}
                </div>
                {!isDayOff && (
                  <label className="flex-center" style={{ gap: 6, marginTop: 10, fontSize: '0.82rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoRestDays}
                      onChange={e => setAutoRestDays(e.target.checked)}
                      style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--primary, #3b82f6)' }}
                    />
                    Mark the other days in this range as rest days
                  </label>
                )}
              </div>
            </>
          )}

          <div className="form-group full">
            <label>Notes</label>
            <input value={form.notes} onChange={set('notes')} placeholder="Optional" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : directWrite ? 'Assign' : 'Propose'}</button>
        </div>
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
  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 5;
  const load = async () => { setLoading(true); try { setDrivers(await api.getFleetDrivers(date)); } catch (e) { onToast(e.message, 'error'); } finally { setLoading(false); } };
  useEffect(() => {
    load();
  }, [date]);

  // Keep a ref to the latest `load` so the SSE listener always calls the
  // current version without needing to reconnect every time `date` changes.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('attendance:updated', () => {
      loadRef.current();
    });
    return () => source.close();
  }, []); // connect once, stay connected for the life of this component
  useEffect(() => { setPage(0); }, [date]);
  const pageCount = Math.max(1, Math.ceil(drivers.length / PAGE_SIZE));
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [pageCount, page]);
  const pagedDrivers = drivers.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ marginBottom: collapsed ? 0 : 12 }}>
        <div className="flex-center" style={{ gap: 8 }}>
          <button
            className="btn btn-icon btn-ghost btn-sm"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <Truck size={16} /><strong>Fleet Driver Availability</strong>
          {drivers.some(d => d.needs_replacement) && <span className="flex-center" style={{ gap: 6, color: 'var(--danger, #ef4444)' }}><AlertTriangle size={14} />{drivers.filter(d => d.needs_replacement).length} need coverage</span>}
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 160 }} />
      </div>
      {!collapsed && (loading ? <div className="loading"><div className="spinner" /> Loading...</div> : (
        <>
          <div className="table-wrap"><table><thead><tr><th>Driver</th><th>Shift</th><th>Clock In</th><th>Status</th><th>Reason</th><th>Coverage</th><th></th></tr></thead><tbody>{pagedDrivers.map(d => <tr key={d.id}><td><div style={{ fontWeight: 600 }}>{d.name}</div><div className="text-dim" style={{ fontSize: 11 }}>{d.employee_id}</div></td><td>{d.shift_name || '—'}{d.shift_start && <div className="text-dim" style={{ fontSize: 11 }}>{d.shift_start.slice(0, 5)}</div>}</td><td>{d.clock_in ? d.clock_in.slice(0, 5) : '—'}</td><td><span className={`badge ${d.effective_availability === 'available' ? 'active' : 'inactive'}`}>{d.effective_availability === 'available' ? 'Available' : 'Not Available'}</span></td><td className="text-sm">{d.availability_reason}</td><td className="text-sm">{d.coverage_status === 'active' ? <span style={{ color: 'var(--green)' }}>Covered by {d.replacement_name}</span> : d.coverage_status === 'invalid' ? <span style={{ color: 'var(--danger, #ef4444)' }}>Invalid: {d.coverage_invalid_reason}</span> : '—'}</td><td><button className={`btn btn-sm ${d.needs_replacement ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setReplacing(d)}><UserCheck size={13} /> {d.needs_replacement ? 'Replace' : 'Override'}</button></td></tr>)}</tbody></table></div>
          {drivers.length > PAGE_SIZE && (
            <div className="flex-between" style={{ marginTop: 12 }}>
              <span className="text-dim text-sm">{drivers.length} driver{drivers.length === 1 ? '' : 's'}</span>
              <div className="flex-center gap-2">
                <button className="btn btn-sm btn-ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>Previous</button>
                <span className="text-dim text-sm">Page {page + 1} of {pageCount}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next</button>
              </div>
            </div>
          )}
        </>
      ))}
      {replacing && <ReplacementModal absentDriver={replacing} date={date} onClose={() => setReplacing(null)} onAssigned={load} onToast={onToast} />}
    </div>
  );
}

// ─── Pending Schedule Proposals Panel (hr_manager / admin only) ────────────────
// Groups a flat proposal list into { batches: [[batch_id, rows]], singles: [rows without a batch_id] }
// so a recurring submission (one row per date, sharing a batch_id) reviews as one item.
function groupProposals(list) {
  const batchMap = {};
  const singles = [];
  for (const p of list) {
    if (p.batch_id) (batchMap[p.batch_id] ||= []).push(p);
    else singles.push(p);
  }
  return { batches: Object.entries(batchMap), singles };
}

function ProposalRowActions({ id, batchId, proposedBy, currentUserId, actingKey, onApprove, onReject }) {
  const key = batchId || id;
  const isOwn = proposedBy && currentUserId && proposedBy === currentUserId;
  if (isOwn) {
    return <span className="text-dim text-sm" title="Someone else needs to review this">Awaiting another reviewer</span>;
  }
  return (
    <div className="flex-center gap-2">
      <button className="btn btn-primary btn-sm" onClick={() => onApprove(key, batchId)} disabled={actingKey === key}>Approve</button>
      <button className="btn btn-danger btn-sm" onClick={() => onReject(key, batchId)} disabled={actingKey === key}>Reject</button>
    </div>
  );
}

function PendingProposalsPanel({ onToast, refreshSignal }) {
  const currentUserId = getCurrentUser()?.id;
  const [shiftProposals, setShiftProposals] = useState([]);
  const [reqProposals, setReqProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actingKey, setActingKey] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [shifts, reqs] = await Promise.all([api.getPendingProposals(), api.getPendingStaffingProposals()]);
      setShiftProposals(shifts);
      setReqProposals(reqs);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [refreshSignal]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('schedule:updated', () => {
      loadRef.current();
    });
    return () => source.close();
  }, []);

  const approveShift = async (key, batchId) => {
    setActingKey(key);
    try {
      if (batchId) await api.approveProposalBatch(batchId); else await api.approveProposal(key);
      onToast('Proposal approved', 'success'); load();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setActingKey(null); }
  };
  const rejectShift = async (key, batchId) => {
    const reason = prompt('Reason for rejecting this proposal (optional):') || '';
    setActingKey(key);
    try {
      if (batchId) await api.rejectProposalBatch(batchId, reason); else await api.rejectProposal(key, reason);
      onToast('Proposal rejected', 'success'); load();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setActingKey(null); }
  };

  const approveReq = async (key, batchId) => {
    setActingKey(key);
    try {
      if (batchId) await api.approveStaffingProposalBatch(batchId); else await api.approveStaffingProposal(key);
      onToast('Proposal approved', 'success'); load();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setActingKey(null); }
  };
  const rejectReq = async (key, batchId) => {
    const reason = prompt('Reason for rejecting this proposal (optional):') || '';
    setActingKey(key);
    try {
      if (batchId) await api.rejectStaffingProposalBatch(batchId, reason); else await api.rejectStaffingProposal(key, reason);
      onToast('Proposal rejected', 'success'); load();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setActingKey(null); }
  };

  const totalCount = shiftProposals.length + reqProposals.length;
  if (!loading && totalCount === 0) return null; // nothing to review — stay out of the way

  const { batches: shiftBatches, singles: shiftSingles } = groupProposals(shiftProposals);
  const { batches: reqBatches, singles: reqSingles } = groupProposals(reqProposals);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ marginBottom: collapsed ? 0 : 12 }}>
        <div className="flex-center" style={{ gap: 8 }}>
          <button className="btn btn-icon btn-ghost btn-sm" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <Calendar size={16} /><strong>Pending Proposals</strong>
          <span className="badge" style={{ background: 'rgba(245,158,11,0.18)', color: '#f59e0b' }}>{totalCount}</span>
        </div>
      </div>
      {!collapsed && (loading ? <div className="loading"><div className="spinner" /> Loading...</div> : (
        <>
          {(shiftSingles.length > 0 || shiftBatches.length > 0) && (
            <div className="table-wrap" style={{ marginBottom: (reqSingles.length > 0 || reqBatches.length > 0) ? 16 : 0 }}>
              <table>
                <thead><tr><th>Employee</th><th>Date(s)</th><th>Shift</th><th>Proposed by</th><th></th></tr></thead>
                <tbody>
                  {shiftSingles.map(p => (
                    <tr key={p.id}>
                      <td>{p.employees?.name || '—'}</td>
                      <td>{p.date}</td>
                      <td>{p.is_day_off ? <span className="badge inactive">Rest Day</span> : (p.shift_templates?.name || '—')}</td>
                      <td className="text-dim text-sm">{p.proposer?.username || '—'}</td>
                      <td>
                        <ProposalRowActions id={p.id} proposedBy={p.proposed_by} currentUserId={currentUserId} actingKey={actingKey} onApprove={approveShift} onReject={rejectShift} />
                      </td>
                    </tr>
                  ))}
                  {shiftBatches.map(([batchId, rows]) => {
                    const dates = rows.map(r => r.date).sort();
                    const first = rows[0];
                    return (
                      <tr key={batchId}>
                        <td>{first.employees?.name || '—'}</td>
                        <td>{dates[0]} → {dates[dates.length - 1]} <span className="text-dim text-sm">({rows.length} day(s))</span></td>
                        <td>{first.is_day_off ? <span className="badge inactive">Rest Day</span> : (first.shift_templates?.name || '—')}</td>
                        <td className="text-dim text-sm">{first.proposer?.username || '—'}</td>
                        <td>
                          <ProposalRowActions id={first.id} batchId={batchId} proposedBy={first.proposed_by} currentUserId={currentUserId} actingKey={actingKey} onApprove={approveShift} onReject={rejectShift} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(reqSingles.length > 0 || reqBatches.length > 0) && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Position</th><th>Date(s)</th><th>Shift</th><th>Required</th><th>Proposed by</th><th></th></tr></thead>
                <tbody>
                  {reqSingles.map(p => (
                    <tr key={p.id}>
                      <td>{p.positions?.name || '—'}</td>
                      <td>{p.date}</td>
                      <td>{p.roles?.name || '—'}</td>
                      <td>{p.required_count}</td>
                      <td className="text-dim text-sm">{p.proposer?.username || '—'}</td>
                      <td>
                        <ProposalRowActions id={p.id} proposedBy={p.proposed_by} currentUserId={currentUserId} actingKey={actingKey} onApprove={approveReq} onReject={rejectReq} />
                      </td>
                    </tr>
                  ))}
                  {reqBatches.map(([batchId, rows]) => {
                    const dates = rows.map(r => r.date).sort();
                    const first = rows[0];
                    return (
                      <tr key={batchId}>
                        <td>{first.positions?.name || '—'}</td>
                        <td>{dates[0]} → {dates[dates.length - 1]} <span className="text-dim text-sm">({rows.length} day(s))</span></td>
                        <td>{first.roles?.name || '—'}</td>
                        <td>{first.required_count}</td>
                        <td className="text-dim text-sm">{first.proposer?.username || '—'}</td>
                        <td>
                          <ProposalRowActions id={first.id} batchId={batchId} proposedBy={first.proposed_by} currentUserId={currentUserId} actingKey={actingKey} onApprove={approveReq} onReject={rejectReq} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ))}
    </div>
  );
}

// ─── Requirements Matrix (compact, one row per shift type) ─────────────────────
function RequirementsMatrix({ positionName, rows, dates, onCellClick, onDeleteRow, highlightedCell }) {
  const cellRefs = useRef({});

  useEffect(() => {
    if (!highlightedCell) return;
    const el = cellRefs.current[highlightedCell];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedCell, rows]);

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="text-dim text-sm" style={{ marginBottom: 8, fontWeight: 600 }}>{positionName} requirements this week</div>
      <div className="table-wrap">
        <table className="req-matrix" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '6px' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', minWidth: 100 }}></th>
              {dates.map(date => {
                const d = new Date(date + 'T00:00:00');
                return (
                  <th key={date} style={{ textAlign: 'center', padding: '4px 8px', fontWeight: 600, fontSize: '0.75rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{WEEKDAY_SHORT[(d.getDay() + 6) % 7]} </span>{d.getDate()}
                  </th>
                );
              })}
              <th style={{ padding: '4px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const Icon = shiftIcon(row.name);
              return (
                <tr key={row.id}>
                  <td style={{ padding: '4px 8px' }}>
                    <span className="flex-center" style={{ gap: 6, fontSize: '0.85rem' }}>
                      <Icon size={13} style={{ color: row.color }} /> {row.name}
                    </span>
                  </td>
                  {dates.map(date => {
                    const cell = row.cells[date];
                    const cellKey = `${row.id}-${date}`;
                    const isHighlighted = cellKey === highlightedCell;
                    if (!cell) {
                      return (
                        <td key={date} style={{ textAlign: 'center', padding: 0 }}>
                          <button
                            className="btn-ghost"
                            onClick={() => onCellClick({ position_id: row.position_id, shift_template_id: row.id, date, required_count: 1, notes: '' })}
                            style={{ width: '100%', minWidth: 56, padding: '6px 4px', borderRadius: 6, border: '1px dashed var(--border)', color: 'var(--text-muted)', background: 'transparent', cursor: 'pointer', fontSize: '0.8rem' }}
                            title="Click to add a requirement"
                          >—</button>
                        </td>
                      );
                    }
                    const full = cell.status === 'full';
                    return (
                      <td key={date} style={{ textAlign: 'center', padding: 0 }}>
                        <button
                          ref={el => { if (el) cellRefs.current[cellKey] = el; }}
                          onClick={() => onCellClick(cell)}
                          title={`${cell.assigned_count}/${cell.required_count} filled — click to edit or remove`}
                          style={{
                            width: '100%', minWidth: 56, padding: '6px 4px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                            background: full ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                            color: full ? 'var(--green, #10b981)' : 'var(--danger, #ef4444)',
                            boxShadow: isHighlighted ? '0 0 0 3px var(--accent, #3b82f6)' : undefined,
                            transition: 'box-shadow 0.2s ease',
                          }}
                        >{cell.assigned_count}/{cell.required_count}</button>
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'center', padding: '0 4px' }}>
                    {onDeleteRow && (
                      <button
                        className="btn btn-icon btn-ghost btn-sm"
                        onClick={() => onDeleteRow(row)}
                        title={`Remove ${row.name} for the whole week`}
                        style={{ color: 'var(--danger, #ef4444)' }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-dim" style={{ fontSize: '0.72rem', marginTop: 6 }}>One row per shift type. Dashed cells mean no requirement set — click a filled cell to edit or remove that single day, or use the trash icon to remove the whole week for that shift at once.</p>
    </div>
  );
}

// ─── Assignment Detail (pop-up) ─────────────────────────────────────────────
function AssignmentDetailModal({ assignment, employee, onClose, onRemove }) {
  const isDayOff = assignment.is_day_off;
  const [removing, setRemoving] = useState(false);

  const doRemove = async () => {
    setRemoving(true);
    try { await onRemove(assignment); onClose(); }
    finally { setRemoving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 380 }}>
        <div className="modal-header">
          <span className="modal-title">Assignment Detail</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '4px 0 16px', fontSize: '0.85rem' }}>
          <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span className="text-dim">Employee</span>
            <span style={{ fontWeight: 600 }}>{employee?.name || '—'} {employee?.employee_id ? `(${employee.employee_id})` : ''}</span>
          </div>
          <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span className="text-dim">Date</span>
            <span style={{ fontWeight: 600 }}>
              {new Date(assignment.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span className="text-dim">Shift</span>
            {isDayOff ? (
              <span className="badge inactive">Rest Day</span>
            ) : (
              <span className="flex-center" style={{ gap: 6, fontWeight: 600 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: assignment.shift_templates?.color || '#3b82f6' }} />
                {assignment.shift_templates?.name || 'Shift'} ({formatTime(assignment.shift_templates?.start_time)} – {formatTime(assignment.shift_templates?.end_time)})
              </span>
            )}
          </div>
          <div className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span className="text-dim">Status</span>
            <span style={{ fontWeight: 600 }}>Assigned</span>
          </div>
          {assignment.notes && (
            <div style={{ padding: '8px 0' }}>
              <span className="text-dim">Notes</span>
              <div style={{ marginTop: 4 }}>{assignment.notes}</div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-danger" onClick={doRemove} disabled={removing}>
            <Trash2 size={13} /> {removing ? 'Removing…' : 'Remove'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Employee schedule list (compact, single position) ─────────────────────────
function EmployeeScheduleGroup({ position, employees, dates, assignmentMap, leaveMap, onRemove }) {
  const scheduledCount = employees.filter(e => dates.some(date => assignmentMap[date]?.[e.id])).length;
  const [detail, setDetail] = useState(null); // { assignment, employee }

  const legendShifts = useMemo(() => {
    const seen = new Map();
    dates.forEach(date => {
      employees.forEach(e => {
        const a = assignmentMap[date]?.[e.id];
        if (a && !a.is_day_off && a.shift_templates?.name && !seen.has(a.shift_templates.name)) {
          seen.set(a.shift_templates.name, a.shift_templates);
        }
      });
    });
    return [...seen.values()];
  }, [dates, employees, assignmentMap]);

  return (
    <div>
      <div className="text-dim text-sm" style={{ marginBottom: 8, fontWeight: 600 }}>
        {position} · {employees.length} {employees.length === 1 ? 'person' : 'people'}, {scheduledCount} scheduled
      </div>
      <div className="table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', minWidth: 180 }}></th>
              {dates.map(date => {
                const d = new Date(date + 'T00:00:00');
                return <th key={date} style={{ textAlign: 'center', padding: '6px 4px', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{WEEKDAY_SHORT[(d.getDay() + 6) % 7]} {d.getDate()}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => (
              <tr key={emp.id} style={{ borderTop: '1px solid var(--border-light)' }}>
                <td style={{ padding: '8px' }}>
                  <div className="flex-center" style={{ gap: 8 }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: avatarColor(emp.id), color: '#fff', fontSize: '0.7rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{initials(emp.name)}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{emp.name}</div>
                      <div className="text-dim" style={{ fontSize: '0.7rem' }}>{emp.employee_id}</div>
                    </div>
                  </div>
                </td>
                {dates.map(date => {
                  const leave = leaveMap[date]?.[emp.id];
                  const a = assignmentMap[date]?.[emp.id];
                  return (
                    <td key={date} style={{ textAlign: 'center', padding: '4px' }}>
                      {leave ? (
                        <span
                          className="badge"
                          style={{ fontSize: '0.68rem', padding: '3px 6px', background: 'rgba(139,92,246,0.18)', color: '#8b5cf6', fontWeight: 700, cursor: 'default' }}
                          title={`On leave${leave.leave_type || leave.type ? ` — ${leave.leave_type || leave.type}` : ''}${leave.reason || leave.notes ? `: ${leave.reason || leave.notes}` : ''}`}
                        >
                          Leave
                        </span>
                      ) : !a ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : a.is_day_off ? (
                        <span className="badge inactive" style={{ fontSize: '0.68rem', padding: '3px 6px', cursor: 'pointer' }} onClick={() => setDetail({ assignment: a, employee: emp })} title="Click for details">Rest</span>
                      ) : (
                        (() => {
                          const ShiftGlyph = shiftIcon(a.shift_templates?.name);
                          return (
                            <span
                              onClick={() => setDetail({ assignment: a, employee: emp })}
                              title={`${a.shift_templates?.name || 'Shift'} · click for details`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 5,
                                fontSize: '0.7rem', fontWeight: 700, color: '#fff',
                                background: a.shift_templates?.color || '#3b82f6', cursor: 'pointer',
                              }}
                            >
                              <ShiftGlyph size={10} />
                              {shortRange(a.shift_templates?.start_time, a.shift_templates?.end_time)}
                            </span>
                          );
                        })()
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(legendShifts.length > 0 || employees.some(e => dates.some(d => assignmentMap[d]?.[e.id]?.is_day_off))) && (
        <div className="flex-center gap-3" style={{ flexWrap: 'wrap', marginTop: 10, fontSize: '0.72rem' }}>
          {legendShifts.map(t => (
            <span key={t.name} className="flex-center" style={{ gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: t.color || '#3b82f6', display: 'inline-block' }} />
              <span className="text-dim">{t.name} ({shortRange(t.start_time, t.end_time)})</span>
            </span>
          ))}
          <span className="flex-center" style={{ gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--border)', display: 'inline-block' }} />
            <span className="text-dim">Rest / Off</span>
          </span>
          <span className="flex-center" style={{ gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: '#8b5cf6', display: 'inline-block' }} />
            <span className="text-dim">Leave</span>
          </span>
        </div>
      )}

      {detail && (
        <AssignmentDetailModal
          assignment={detail.assignment}
          employee={detail.employee}
          onClose={() => setDetail(null)}
          onRemove={onRemove}
        />
      )}
    </div>
  );
}

// ─── Stat Cards ──────────────────────────────────────────────────────────────
function StatCard({ label, value, tone, icon: Icon, onClick }) {
  const toneColor = tone === 'danger' ? 'var(--danger, #ef4444)'
    : tone === 'warn' ? '#f59e0b'
    : tone === 'accent' ? 'var(--primary, #3b82f6)'
    : 'var(--green, #10b981)';
  return (
    <div
      className="card"
      onClick={onClick}
      style={{
        flex: '1 1 140px', padding: '14px 16px', cursor: onClick ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', gap: 12, minWidth: 140,
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0,
        background: `${toneColor}22`, color: toneColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={17} />
      </div>
      <div>
        <div style={{ fontSize: '1.15rem', fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
        <div className="text-dim" style={{ fontSize: '0.72rem', marginTop: 2 }}>{label}</div>
      </div>
    </div>
  );
}

function ScheduleStatCards({ totals, understaffedCount, onLeaveCount, unscheduledCount, onJumpShortStaffed }) {
  return (
    <div className="flex-center gap-2" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
      <StatCard label="Slots filled" value={`${totals.total_assigned}/${totals.total_required}`} tone="accent" icon={UserCheck} />
      <StatCard
        label="Short-staffed"
        value={understaffedCount}
        tone={understaffedCount > 0 ? 'danger' : 'success'}
        icon={AlertTriangle}
        onClick={understaffedCount > 0 ? onJumpShortStaffed : undefined}
      />
      <StatCard label="On leave today" value={onLeaveCount} tone="warn" icon={Calendar} />
      <StatCard label="Unscheduled" value={unscheduledCount} tone={unscheduledCount > 0 ? 'warn' : 'success'} icon={Users} />
    </div>
  );
}

// ─── Position Picker ─────────────────────────────────────────────────────────
function PositionPicker({ tabs, selected, onSelect, threshold = 6 }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  if (tabs.length === 0) return null;

  if (tabs.length <= threshold) {
    return (
      <div className="flex-center gap-2" style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', overflowX: 'auto' }}>
        {tabs.map(t => (
          <button
            key={t.name}
            className={`btn btn-sm ${selected === t.name ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onSelect(t.name)}
            style={{ whiteSpace: 'nowrap' }}
          >
            {t.name} <span style={{ opacity: 0.7, marginLeft: 4 }}>({t.count})</span>
          </button>
        ))}
      </div>
    );
  }

  const filtered = tabs.filter(t => t.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(o => !o)}
        style={{ minWidth: 220, justifyContent: 'space-between', display: 'inline-flex', alignItems: 'center' }}
      >
        <span>{selected || 'Select position'} {selected && <span className="text-dim">({tabs.find(t => t.name === selected)?.count})</span>}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <>
          <div onClick={() => { setOpen(false); setQuery(''); }} style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
          <div className="card" style={{ position: 'absolute', top: '100%', left: 20, marginTop: 4, width: 260, zIndex: 10, padding: 8, maxHeight: 320, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search positions"
                style={{ width: '100%', paddingLeft: 26, fontSize: '0.85rem' }}
              />
            </div>
            {filtered.length === 0 ? (
              <div className="text-dim text-sm" style={{ padding: '6px 4px' }}>No positions match.</div>
            ) : filtered.map(t => (
              <button
                key={t.name}
                onClick={() => { onSelect(t.name); setOpen(false); setQuery(''); }}
                className="btn btn-ghost btn-sm"
                style={{
                  width: '100%', justifyContent: 'space-between', display: 'flex', marginBottom: 2,
                  background: selected === t.name ? 'var(--surface-hover, rgba(255,255,255,0.08))' : 'transparent'
                }}
              >
                <span>{t.name}</span><span className="text-dim">({t.count})</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── MAIN SCHEDULE PAGE ──────────────────────────────────────────────────────
export default function SchedulePage({ onToast }) {
  const role = getRole(); // 'admin' | 'hr_manager' | 'hr_staff'
  const canManageDirectly = role === 'admin'; // direct writes are admin-only per backend
  const canApprove = role === 'admin' || role === 'hr_manager';

  const [employees, setEmployees] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [positions, setPositions] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [totals, setTotals] = useState({ total_required: 0, total_assigned: 0, understaffed_slots: 0 });
  const [loading, setLoading] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  // Requirement Modal State
  const [showReqModal, setShowReqModal] = useState(false);
  const [editingReq, setEditingReq] = useState(null);
  const [reqDays, setReqDays] = useState([]);

  const [selectedPosition, setSelectedPosition] = useState(null);

  const [search, setSearch] = useState('');
  const [showScheduled, setShowScheduled] = useState(false);
  const [showNoShifts, setShowNoShifts] = useState(false);

  const [highlightedCell, setHighlightedCell] = useState(null);
  const [understaffedCursor, setUnderstaffedCursor] = useState(0);

  const [range, setRange] = useState(() => {
    const start = startOfWeek(new Date());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toISODate(start), end: toISODate(end) };
  });

  const load = async () => {
    setLoading(true);
    try {
      const [emps, tmpls, positionsList, sched, cov, leavesData] = await Promise.all([
        api.getEmployees(),
        api.getShiftTemplates(),
        api.getPositions(),
        api.getSchedule({ start_date: range.start, end_date: range.end }),
        api.getCoverage({ start_date: range.start, end_date: range.end }),
        api.getLeaves({ start_date: range.start, end_date: range.end, status: 'approved' }),
      ]);
      setEmployees(emps);
      setTemplates(tmpls);
      setPositions(positionsList);
      setAssignments(sched);
      setCoverage(cov.coverage);
      setTotals(cov.totals);
      setLeaves(leavesData);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [range.start, range.end]);

  // Keep a ref to the latest `load` so the SSE listener always calls the
  // current version without needing to reconnect every time the visible
  // date range changes.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('attendance:updated', () => {
      loadRef.current();
    });
    // Assignment/requirement changes (assign, remove, propose, approve, reject)
    // are a different kind of change than clock-in/out — listen separately so
    // a delete made in one session (e.g. Admin) refreshes other open sessions
    // (e.g. HR) instead of only updating local state for whoever clicked it.
    source.addEventListener('schedule:updated', () => {
      loadRef.current();
    });
    return () => source.close();
  }, []); // connect once, stay connected for the life of this component

  useEffect(() => {
    if (!highlightedCell) return;
    const t = setTimeout(() => setHighlightedCell(null), 2500);
    return () => clearTimeout(t);
  }, [highlightedCell]);

  const saveTemplate = async (id, form) => {
    if (id) { const updated = await api.updateShiftTemplate(id, form); setTemplates(ts => ts.map(t => t.id === id ? updated : t)); }
    else { const created = await api.createShiftTemplate(form); setTemplates(ts => [...ts, created]); }
    onToast('Template saved', 'success');
  };
  const deleteTemplate = async (id) => { await api.deleteShiftTemplate(id); setTemplates(ts => ts.filter(t => t.id !== id)); onToast('Template deleted', 'success'); };

  const removeAssignment = async (assignment) => {
    try { await api.deleteShiftAssignment(assignment.id); setAssignments(a => a.filter(x => x.id !== assignment.id)); onToast('Assignment removed', 'success'); }
    catch (e) { onToast(e.message, 'error'); }
  };

  const removeRequirement = async (row) => {
    if (!confirm(`Remove requirement for ${row.positions?.name || 'position'}?`)) return;
    try { await api.deleteStaffingRequirement(row.id); onToast('Requirement removed', 'success'); load(); }
    catch (e) { onToast(e.message, 'error'); }
  };

  const deleteRequirementRow = async (row) => {
    const cellIds = Object.values(row.cells).map(c => c.id).filter(Boolean);
    if (cellIds.length === 0) return;
    if (!confirm(`Remove ${row.name} for the whole week? This deletes all ${cellIds.length} day(s) of this requirement.`)) return;
    try {
      await Promise.all(cellIds.map(id => api.deleteStaffingRequirement(id)));
      onToast(`${row.name} removed for the week`, 'success');
      load();
    } catch (e) { onToast(e.message, 'error'); }
  };

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

  const leaveMap = useMemo(() => {
    const map = {};
    leaves
      .filter(l => !l.status || l.status.toLowerCase() === 'approved')
      .forEach(l => {
        datesInRange.forEach(date => {
          if (leaveCoversDate(l, date)) {
            if (!map[date]) map[date] = {};
            map[date][l.employee_id] = l;
          }
        });
      });
    return map;
  }, [leaves, datesInRange]);

  const activeEmployees = useMemo(() => employees.filter(e => e.status === 'active'), [employees]);

  const positionTabs = useMemo(() => {
    const counts = {};
    activeEmployees.forEach(e => { const key = e.position || 'Unassigned'; counts[key] = (counts[key] || 0) + 1; });
    return Object.entries(counts)
      .sort(([a], [b]) => (a === 'Unassigned') - (b === 'Unassigned') || a.localeCompare(b))
      .map(([name, count]) => ({ name, count }));
  }, [activeEmployees]);

  useEffect(() => {
    if (positionTabs.length === 0) { setSelectedPosition(null); return; }
    if (!selectedPosition || !positionTabs.some(t => t.name === selectedPosition)) {
      setSelectedPosition(positionTabs[0].name);
    }
  }, [positionTabs]);

  const activePositions = useMemo(() => {
    const usedNames = new Set(positionTabs.map(t => t.name));
    const seen = new Set();
    return positions.filter(p => {
      if (!usedNames.has(p.name) || seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  }, [positions, positionTabs]);

  const assignablePositions = useMemo(
    () => positionTabs.map(t => ({ id: t.name, name: t.name })),
    [positionTabs]
  );

  const openReqModal = (prefill) => {
    setEditingReq(prefill);
    if (!prefill?.id) setReqDays(datesInRange);
    setShowReqModal(true);
  };

  const toggleReqDay = (date) => setReqDays(days => days.includes(date) ? days.filter(x => x !== date) : [...days, date]);

  const saveRequirement = async () => {
    try {
      if (canManageDirectly) {
        if (editingReq?.id) {
          await api.updateStaffingRequirement(editingReq.id, { required_count: editingReq.required_count, notes: editingReq.notes });
          onToast('Requirement saved', 'success');
        } else {
          if (reqDays.length === 0) return onToast('Pick at least one day', 'error');
          const existingDates = new Set(
            coverage
              .filter(c => c.position_id === editingReq.position_id && c.shift_template_id === editingReq.shift_template_id)
              .map(c => c.date)
          );
          const toCreate = reqDays.filter(d => !existingDates.has(d));
          if (toCreate.length === 0) return onToast('Those days already have a requirement set', 'error');
          await Promise.all(toCreate.map(date => api.createStaffingRequirement({
            position_id: editingReq.position_id,
            shift_template_id: editingReq.shift_template_id,
            date,
            required_count: editingReq.required_count,
            notes: editingReq.notes
          })));
          const skipped = reqDays.length - toCreate.length;
          onToast(skipped > 0 ? `Added for ${toCreate.length} day(s) — ${skipped} already had a requirement` : `Added for ${toCreate.length} day(s)`, 'success');
        }
      } else {
        // hr_staff / hr_manager: propose instead of writing live — approval
        // upserts onto the matching date whether one already exists or not,
        // so editing an existing cell and adding a new one both just propose.
        if (editingReq?.id) {
          await api.proposeStaffingRequirement({
            position_id: editingReq.position_id,
            shift_template_id: editingReq.shift_template_id,
            date: editingReq.date,
            required_count: editingReq.required_count,
            notes: editingReq.notes,
          });
          onToast('Change proposed — pending approval', 'success');
        } else {
          if (reqDays.length === 0) return onToast('Pick at least one day', 'error');
          await Promise.all(reqDays.map(date => api.proposeStaffingRequirement({
            position_id: editingReq.position_id,
            shift_template_id: editingReq.shift_template_id,
            date,
            required_count: editingReq.required_count,
            notes: editingReq.notes,
          })));
          onToast(`Proposed for ${reqDays.length} day(s) — pending approval`, 'success');
        }
      }
      setShowReqModal(false);
      load();
    } catch (e) { onToast(e.message, 'error'); }
  };

  const shiftWeek = (dir) => {
    const s = new Date(range.start); s.setDate(s.getDate() + dir * 7);
    const e = new Date(s); e.setDate(e.getDate() + 6);
    setRange({ start: toISODate(s), end: toISODate(e) });
  };

  const rangeLabel = useMemo(() => {
    const s = new Date(range.start + 'T00:00:00'), e = new Date(range.end + 'T00:00:00');
    const opts = { month: 'short', day: 'numeric' };
    const year = e.getFullYear();
    return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}, ${year}`;
  }, [range]);

  const filteredCoverage = useMemo(() => {
    if (!selectedPosition) return [];
    return coverage.filter(c => (c.positions?.name || 'Unassigned') === selectedPosition);
  }, [coverage, selectedPosition]);

  const requirementRows = useMemo(() => {
    const rows = {};
    filteredCoverage.forEach(c => {
      const shiftId = c.shift_template_id;
      if (!rows[shiftId]) rows[shiftId] = { id: shiftId, position_id: c.position_id, name: c.roles?.name || 'Shift', color: c.roles?.color || '#3b82f6', cells: {} };
      rows[shiftId].cells[c.date] = c;
    });
    return Object.values(rows);
  }, [filteredCoverage]);

  const positionEmployees = useMemo(() => {
    if (!selectedPosition) return [];
    let list = activeEmployees.filter(e => (e.position || 'Unassigned') === selectedPosition);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(e => e.name.toLowerCase().includes(q) || (e.employee_id || '').toLowerCase().includes(q));
    }
    if (showScheduled || showNoShifts) {
      list = list.filter(e => {
        const hasShift = datesInRange.some(date => assignmentMap[date]?.[e.id]);
        return (showScheduled && hasShift) || (showNoShifts && !hasShift);
      });
    }
    return list;
  }, [activeEmployees, selectedPosition, search, showScheduled, showNoShifts, datesInRange, assignmentMap]);

  const currentPositionId = activePositions.find(p => p.name === selectedPosition)?.id || activePositions[0]?.id || '';

  const todayStr = toISODate(new Date());
  const onLeaveTodayCount = useMemo(
    () => Object.keys(leaveMap[todayStr] || {}).length,
    [leaveMap, todayStr]
  );
  const unscheduledCount = useMemo(
    () => activeEmployees.filter(e => !datesInRange.some(date => assignmentMap[date]?.[e.id])).length,
    [activeEmployees, datesInRange, assignmentMap]
  );

  const understaffedList = useMemo(
    () => coverage.filter(c => c.status !== 'full').sort((a, b) => a.date.localeCompare(b.date)),
    [coverage]
  );

  const jumpToShortStaffed = () => {
    if (understaffedList.length === 0) return;
    const idx = understaffedCursor % understaffedList.length;
    const target = understaffedList[idx];
    setUnderstaffedCursor(idx + 1);
    setHighlightedCell(`${target.shift_template_id}-${target.date}`);
    const posName = target.positions?.name || 'Unassigned';
    if (posName !== selectedPosition) setSelectedPosition(posName);
  };

  return (
    <div className="page">
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Shift &amp; Schedule Management</h2>
        <p className="text-dim text-sm" style={{ marginTop: 4 }}>{assignments.filter(a => !a.is_day_off).length} shift(s) · {assignments.filter(a => a.is_day_off).length} rest day(s) scheduled</p>
      </div>

      {/* Driver Availability */}
      <DriverAvailabilityPanel onToast={onToast} />

      {/* Pending schedule proposals — managers/admin only */}
      {canApprove && <PendingProposalsPanel onToast={onToast} refreshSignal={range.start} />}

      <ScheduleStatCards
        totals={totals}
        understaffedCount={totals.understaffed_slots}
        onLeaveCount={onLeaveTodayCount}
        unscheduledCount={unscheduledCount}
        onJumpShortStaffed={jumpToShortStaffed}
      />

      <div className="card">
        <div className="flex-between" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: '12px' }}>
          <div className="flex-center gap-2">
            <button className="btn btn-icon btn-ghost btn-sm" onClick={() => shiftWeek(-1)}><ChevronLeft size={14} /></button>
            <span style={{ fontWeight: 600 }}>{rangeLabel}</span>
            <button className="btn btn-icon btn-ghost btn-sm" onClick={() => shiftWeek(1)}><ChevronRight size={14} /></button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const start = startOfWeek(new Date());
                const end = new Date(start); end.setDate(end.getDate() + 6);
                setRange({ start: toISODate(start), end: toISODate(end) });
              }}
              style={{ marginLeft: 4 }}
            >
              Today
            </button>
          </div>
          <div className="flex-center gap-2" style={{ flexWrap: 'wrap' }}>
            <span className="text-dim text-sm">{totals.total_assigned} of {totals.total_required} slots filled</span>
            {totals.understaffed_slots > 0 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={jumpToShortStaffed}
                title="Click to jump to a short-staffed slot"
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--danger, #ef4444)' }}
              >
                <AlertTriangle size={14} /> {totals.understaffed_slots} short-staffed
              </button>
            )}
            <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
            {canManageDirectly && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTemplates(true)}><Clock size={13} /> Manage Templates</button>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => openReqModal({
                position_id: currentPositionId,
                shift_template_id: templates[0]?.id || '',
                required_count: 1,
                notes: ''
              })}
              disabled={activePositions.length === 0 || templates.length === 0}
            >
              <Plus size={13} /> {canManageDirectly ? 'Add requirement' : 'Propose requirement'}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAssign(true)} disabled={employees.length === 0}>
              <Plus size={13} /> {canManageDirectly ? 'Assign Shift' : 'Propose Shift'}
            </button>
          </div>
        </div>

        <PositionPicker tabs={positionTabs} selected={selectedPosition} onSelect={setSelectedPosition} />

        {loading ? (
          <div className="loading" style={{ padding: 40 }}><div className="spinner" /> Loading…</div>
        ) : !selectedPosition ? (
          <div className="empty-state" style={{ padding: 40 }}><Users size={32} /><p>No active employees yet.</p></div>
        ) : (
          <div style={{ padding: '16px 20px' }}>
            {requirementRows.length === 0 ? (
              <div className="empty-state" style={{ padding: '12px 0 24px' }}>
                <p className="text-dim text-sm">No staffing requirements set for {selectedPosition} this week yet.</p>
              </div>
            ) : (
              <RequirementsMatrix
                positionName={selectedPosition}
                rows={requirementRows}
                dates={datesInRange}
                onCellClick={openReqModal}
                onDeleteRow={canManageDirectly ? deleteRequirementRow : undefined}
                highlightedCell={highlightedCell}
              />
            )}

            <div style={{ marginTop: 8 }}>
              <div className="flex-between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
                <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search employees"
                    style={{ width: '100%', paddingLeft: 30 }}
                  />
                </div>
                <div className="flex-center gap-2" style={{ fontSize: '0.82rem' }}>
                  <label className="flex-center" style={{ gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={showScheduled}
                      onChange={e => setShowScheduled(e.target.checked)}
                      style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--primary, #3b82f6)' }}
                    /> Scheduled
                  </label>
                  <label className="flex-center" style={{ gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={showNoShifts}
                      onChange={e => setShowNoShifts(e.target.checked)}
                      style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--primary, #3b82f6)' }}
                    /> No shifts
                  </label>
                </div>
              </div>

              {positionEmployees.length === 0 ? (
                <div className="empty-state"><Users size={32} /><p>No employees match this filter.</p></div>
              ) : (
                <EmployeeScheduleGroup
                  position={selectedPosition}
                  employees={positionEmployees}
                  dates={datesInRange}
                  assignmentMap={assignmentMap}
                  leaveMap={leaveMap}
                  onRemove={removeAssignment}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showTemplates && <ShiftTemplateModal templates={templates} onClose={() => setShowTemplates(false)} onSave={saveTemplate} onDelete={deleteTemplate} onToast={onToast} />}
      {showAssign && (
        <AssignShiftModal
          employees={employees}
          templates={templates}
          positions={assignablePositions}
          defaultPosition={selectedPosition}
          directWrite={canManageDirectly}
          onClose={() => setShowAssign(false)}
          onAssign={async (b) => {
            if (canManageDirectly) { await api.assignShift(b); }
            else { await api.proposeShift(b); }
            load();
          }}
          onAssignRecurring={async (b) => {
            if (canManageDirectly) { await api.assignRecurringShift(b); }
            else { await api.proposeRecurringShift(b); }
            load();
          }}
          onToast={onToast}
        />
      )}

      {showReqModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">
                {editingReq?.id
                  ? (canManageDirectly ? 'Edit Requirement' : 'Propose Requirement Change')
                  : (canManageDirectly ? 'Set Requirement' : 'Propose Requirement')}
              </span>
              <button className="btn btn-icon btn-ghost" onClick={() => setShowReqModal(false)}>✕</button>
            </div>
            <div className="form-grid">
              <div className="form-group full">
                <label>Position</label>
                <select value={editingReq?.position_id || ''} onChange={e => setEditingReq(r => ({ ...r, position_id: e.target.value }))} disabled={!!editingReq?.id}>
                  {activePositions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="form-group full">
                <label>Shift / Role</label>
                <select value={editingReq?.shift_template_id || ''} onChange={e => setEditingReq(r => ({ ...r, shift_template_id: e.target.value }))} disabled={!!editingReq?.id}>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {editingReq?.id ? (
                <div className="form-group">
                  <label>Date</label>
                  <input type="date" value={editingReq.date} disabled />
                </div>
              ) : (
                <div className="form-group full">
                  <label>Apply to</label>
                  <div className="flex-center gap-2" style={{ marginBottom: 8 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReqDays(datesInRange)}>Whole week</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReqDays([])}>Clear</button>
                  </div>
                  <div className="flex-center gap-2" style={{ flexWrap: 'wrap' }}>
                    {datesInRange.map(date => {
                      const d = new Date(date + 'T00:00:00');
                      const active = reqDays.includes(date);
                      return (
                        <button
                          key={date}
                          type="button"
                          className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                          onClick={() => toggleReqDay(date)}
                        >
                          {WEEKDAY_SHORT[(d.getDay() + 6) % 7]} {d.getDate()}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-dim" style={{ fontSize: '0.72rem', marginTop: 6 }}>
                    {canManageDirectly
                      ? 'Creates one requirement per selected day. Days that already have one are skipped — edit those from the matrix instead.'
                      : 'Proposes one requirement per selected day, pending approval — including days that already have one set.'}
                  </p>
                </div>
              )}
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
              {editingReq?.id && canManageDirectly && (
                <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => { setShowReqModal(false); removeRequirement(editingReq); }}>
                  <Trash2 size={13} /> Delete
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => setShowReqModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveRequirement}>{canManageDirectly ? 'Save' : 'Propose'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}