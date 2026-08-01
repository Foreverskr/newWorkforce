import { useState, useEffect, useMemo } from 'react';
import { ClipboardList, Plus, Trash2, Edit2, Repeat, Calendar, AlertTriangle, CheckCircle2 } from 'lucide-react';
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

function StatusBadge({ status, gap }) {
  if (status === 'full') {
    return (
      <span className="badge active" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <CheckCircle2 size={12} /> Full
      </span>
    );
  }
  if (status === 'understaffed') {
    return (
      <span className="badge inactive" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--danger, #ef4444)' }}>
        <AlertTriangle size={12} /> Short {gap}
      </span>
    );
  }
  return (
    <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      +{Math.abs(gap)} over
    </span>
  );
}

// positions: [{id, name}], roles: [{id, name, start_time, end_time, color, allowed_positions?}]
// allowed_positions on a role, if present, is treated as an array of position
// ids and narrows the Position dropdown to just those — remove that filter
// below if allowed_positions actually stores position names instead.
function RequirementModal({ positions, roles, onClose, onSave, onSaveRecurring, onToast, editing }) {
  const today = toISODate(new Date());
  const isEdit = !!editing;
  const [mode, setMode] = useState('single'); // 'single' | 'recurring'
  const [form, setForm] = useState({
    position_id: editing?.position_id || positions[0]?.id || '',
    shift_template_id: editing?.shift_template_id || roles[0]?.id || '',
    date: editing?.date || today,
    start_date: today,
    end_date: today,
    days_of_week: [1, 2, 3, 4, 5],
    required_count: editing?.required_count ?? 1,
    notes: editing?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const selectedRole = roles.find(r => r.id === form.shift_template_id);
  const availablePositions = (selectedRole?.allowed_positions?.length)
    ? positions.filter(p => selectedRole.allowed_positions.includes(p.id))
    : positions;

  const toggleDay = (d) => {
    setForm(f => ({
      ...f,
      days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d],
    }));
  };

  const submit = async () => {
    if (!form.position_id) return onToast('Select a position', 'error');
    if (!form.shift_template_id) return onToast('Select a shift/role', 'error');
    const count = Number(form.required_count);
    if (!Number.isFinite(count) || count < 1) return onToast('Required count must be at least 1', 'error');

    setSaving(true);
    try {
      if (isEdit) {
        await onSave(editing.id, { required_count: count, notes: form.notes || null });
        onToast('Requirement updated', 'success');
      } else if (mode === 'single') {
        await onSave(null, {
          position_id: form.position_id,
          shift_template_id: form.shift_template_id,
          date: form.date,
          required_count: count,
          notes: form.notes || null,
        });
        onToast('Staffing requirement set', 'success');
      } else {
        if (form.days_of_week.length === 0) return onToast('Pick at least one day of the week', 'error');
        const result = await onSaveRecurring({
          position_id: form.position_id,
          shift_template_id: form.shift_template_id,
          start_date: form.start_date,
          end_date: form.end_date,
          days_of_week: form.days_of_week,
          required_count: count,
          notes: form.notes || null,
        });
        onToast(`${result.created} requirement(s) set`, 'success');
      }
      onClose();
    } catch (e) { onToast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">{isEdit ? 'Edit Staffing Requirement' : 'Set Staffing Requirement'}</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>

        {!isEdit && (
          <div className="flex-center gap-2" style={{ marginBottom: 16 }}>
            <button className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('single')}>
              <Calendar size={13} /> Single date
            </button>
            <button className={`btn btn-sm ${mode === 'recurring' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('recurring')}>
              <Repeat size={13} /> Recurring
            </button>
          </div>
        )}

        <div className="form-grid">
          <div className="form-group full">
            <label>Shift / role</label>
            <select value={form.shift_template_id} onChange={set('shift_template_id')} disabled={isEdit}>
              {roles.map(r => <option key={r.id} value={r.id}>{r.name} — {formatTime(r.start_time)} to {formatTime(r.end_time)}</option>)}
            </select>
          </div>

          <div className="form-group full">
            <label>Position</label>
            <select value={form.position_id} onChange={set('position_id')} disabled={isEdit}>
              {availablePositions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {selectedRole?.allowed_positions?.length > 0 && availablePositions.length < positions.length && (
              <p className="text-dim text-sm" style={{ marginTop: 4 }}>
                Narrowed to positions allowed on this role.
              </p>
            )}
          </div>

          {isEdit ? (
            <div className="form-group full">
              <p className="text-dim text-sm">{editing.positions?.name} · {editing.roles?.name} · {editing.date}</p>
            </div>
          ) : mode === 'single' ? (
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
            </>
          )}

          <div className="form-group">
            <label>Required employees</label>
            <input type="number" min="1" value={form.required_count} onChange={set('required_count')} />
          </div>
          <div className="form-group">
            <label>Notes (optional)</label>
            <input value={form.notes} onChange={set('notes')} placeholder="e.g. peak season" />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Update' : 'Save Requirement'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Position -> Shift Requirement -> Employee Assignment, made concrete:
// set required headcount per position/role/date, then see it against who's
// actually assigned so gaps are visible without a manual headcount.
//
// Props:
//   positions — [{id, name}] — fetch however your app already does
//     (e.g. api.getPositions() if that exists; swap in the real call).
//   roles     — [{id, name, start_time, end_time, color, allowed_positions?}]
//     — same idea, whatever your existing roles-list call is called now
//     that shift_templates was renamed to roles.
export default function StaffingRequirementsPanel({ positions, roles, onToast }) {
  const [coverage, setCoverage] = useState([]);
  const [totals, setTotals] = useState({ total_required: 0, total_assigned: 0, understaffed_slots: 0 });
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);

  const [range, setRange] = useState(() => {
    const start = startOfWeek(new Date());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toISODate(start), end: toISODate(end) };
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getCoverage({ start_date: range.start, end_date: range.end });
      setCoverage(res.coverage);
      setTotals(res.totals);
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [range.start, range.end]);

  const shiftWeek = (dir) => {
    const start = new Date(range.start);
    start.setDate(start.getDate() + dir * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    setRange({ start: toISODate(start), end: toISODate(end) });
  };

  const saveRequirement = async (id, body) => {
    if (id) await api.updateStaffingRequirement(id, body);
    else await api.createStaffingRequirement(body);
    await load();
  };

  const saveRecurring = async (body) => {
    const result = await api.createRecurringStaffingRequirement(body);
    await load();
    return result;
  };

  const removeRequirement = async (row) => {
    if (!confirm(`Remove the ${row.positions?.name || 'position'} requirement for ${row.date}?`)) return;
    try {
      await api.deleteStaffingRequirement(row.id);
      onToast('Requirement removed', 'success');
      load();
    } catch (e) { onToast(e.message, 'error'); }
  };

  const grouped = useMemo(() => {
    const map = {};
    coverage.forEach(c => { (map[c.date] ||= []).push(c); });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [coverage]);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="flex-between" style={{ marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div className="flex-center" style={{ gap: 8 }}>
          <ClipboardList size={16} />
          <strong>Staffing Requirements</strong>
          {totals.understaffed_slots > 0 && (
            <span className="flex-center" style={{ gap: 6, color: 'var(--danger, #ef4444)' }}>
              <AlertTriangle size={14} /> {totals.understaffed_slots} short-staffed
            </span>
          )}
          <span className="text-dim text-sm">
            {totals.total_assigned}/{totals.total_required} filled this range
          </span>
        </div>
        <div className="flex-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(-1)}>← Prev week</button>
          <span className="mono text-sm">{range.start} → {range.end}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftWeek(1)}>Next week →</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => { setEditing(null); setShowModal(true); }}
            disabled={roles.length === 0 || positions.length === 0}
            title={roles.length === 0 ? 'No roles defined yet' : positions.length === 0 ? 'No positions defined yet' : undefined}
          >
            <Plus size={13} /> Set Requirement
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" /> Loading coverage…</div>
      ) : coverage.length === 0 ? (
        <div className="empty-state">
          <ClipboardList size={32} />
          <p>No staffing requirements set for this range</p>
        </div>
      ) : (
        grouped.map(([date, rows]) => (
          <div key={date} style={{ marginBottom: 16 }}>
            <div className="flex-center" style={{ gap: 8, marginBottom: 8 }}>
              <strong>{new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
              <span className="text-dim text-sm">{date}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Position</th><th>Shift</th><th>Required</th><th>Assigned</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id}>
                      <td>{r.positions?.name || '—'}</td>
                      <td>
                        <span className="flex-center" style={{ gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.roles?.color || '#3b82f6', display: 'inline-block' }} />
                          {r.roles?.name || '—'}
                        </span>
                      </td>
                      <td className="mono text-sm">{r.required_count}</td>
                      <td className="mono text-sm" title={r.assigned_employees.map(e => e.name).join(', ') || undefined}>
                        {r.assigned_count}
                      </td>
                      <td><StatusBadge status={r.status} gap={r.gap} /></td>
                      <td>
                        <div className="flex-center gap-2">
                          <button className="btn btn-icon btn-ghost btn-sm" onClick={() => { setEditing(r); setShowModal(true); }} title="Edit">
                            <Edit2 size={13} />
                          </button>
                          <button className="btn btn-icon btn-danger btn-sm" onClick={() => removeRequirement(r)} title="Remove">
                            <Trash2 size={13} />
                          </button>
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

      {showModal && (
        <RequirementModal
          positions={positions}
          roles={roles}
          editing={editing}
          onClose={() => setShowModal(false)}
          onSave={saveRequirement}
          onSaveRecurring={saveRecurring}
          onToast={onToast}
        />
      )}
    </div>
  );
}