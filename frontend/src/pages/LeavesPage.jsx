import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Check, X, Trash2, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { format } from 'date-fns';

const TYPE_COLORS = {
  sick:      { bg: 'var(--red-bg)',   color: 'var(--red)'   },
  vacation:  { bg: 'var(--green-bg)', color: 'var(--green)' },
  emergency: { bg: 'var(--amber-bg)', color: 'var(--amber)' },
  unpaid:    { bg: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' },
};

const PAGE_SIZES = [10, 25, 50, 100];

function LeaveModal({ employees, onClose, onSave }) {
  const [form, setForm] = useState({
    employee_id: '',
    type: 'sick',
    start_date: new Date().toISOString().split('T')[0],
    end_date:   new Date().toISOString().split('T')[0],
    reason: '',
  });
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  // Auto-fix end_date if before start_date
  const setStart = e => {
    const val = e.target.value;
    setForm(f => ({
      ...f,
      start_date: val,
      end_date: f.end_date < val ? val : f.end_date,
    }));
  };

  const save = async () => {
    if (!form.employee_id) return;
    setSaving(true);
    try { await onSave(form); onClose(); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">File Leave Request</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="form-grid">
          <div className="form-group full">
            <label>Employee</label>
            <select value={form.employee_id} onChange={set('employee_id')}>
              <option value="">Select employee…</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.name} · {e.employee_id}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Leave Type</label>
            <select value={form.type} onChange={set('type')}>
              <option value="sick">Sick Leave</option>
              <option value="vacation">Vacation</option>
              <option value="emergency">Emergency</option>
              <option value="unpaid">Unpaid Leave</option>
            </select>
          </div>
          <div className="form-group" />
          <div className="form-group">
            <label>Start Date</label>
            <input type="date" value={form.start_date} onChange={setStart} />
          </div>
          <div className="form-group">
            <label>End Date</label>
            <input type="date" value={form.end_date} onChange={set('end_date')} min={form.start_date} />
          </div>
          <div className="form-group full">
            <label>Reason</label>
            <textarea
              value={form.reason}
              onChange={set('reason')}
              placeholder="Brief reason for the leave…"
              rows={3}
              style={{ resize: 'vertical' }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={saving || !form.employee_id}
          >
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusModal({ leave, onClose, onSave }) {
  const [status, setStatus] = useState('approved');
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try { await onSave({ status, notes }); onClose(); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 420 }}>
        <div className="modal-header">
          <span className="modal-title">Review Leave Request</span>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div style={{ marginBottom: 20 }}>
          <p className="text-muted text-sm" style={{ marginBottom: 4 }}>
            <strong style={{ color: 'var(--text)' }}>{leave.employees?.name}</strong>
            {' · '}{leave.type} leave
          </p>
          <p className="text-dim text-sm">
            {leave.start_date} → {leave.end_date} ({leave.days} day{leave.days !== 1 ? 's' : ''})
          </p>
          {leave.reason && (
            <p className="text-muted text-sm" style={{ marginTop: 8, fontStyle: 'italic' }}>
              "{leave.reason}"
            </p>
          )}
        </div>
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label>Decision</label>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="approved">Approve</option>
            <option value="rejected">Reject</option>
          </select>
        </div>
        <div className="form-group">
          <label>Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Please coordinate with your team first"
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${status === 'approved' ? 'btn-green' : 'btn-danger'}`}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : status === 'approved' ? '✓ Approve' : '✕ Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LeavePage({ onToast }) {
  const [leaves, setLeaves]       = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [filters, setFilters]     = useState({ status: '', type: '' });
  const [showAdd, setShowAdd]     = useState(false);
  const [reviewing, setReviewing] = useState(null);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    api.getEmployees().then(d => setEmployees(d.filter(e => e.status === 'active')));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.type)   params.type   = filters.type;
      setLeaves(await api.getLeaves(params));
    } catch (e) { onToast(e.message, 'error'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (form) => {
    try {
      const created = await api.createLeave(form);
      onToast('Leave request submitted', 'success');
      setLeaves(l => [created, ...l]);
    } catch (e) { onToast(e.message, 'error'); throw e; }
  };

  const handleReview = async (payload) => {
    try {
      const updated = await api.updateLeaveStatus(reviewing.id, payload);
      setLeaves(l => l.map(x => x.id === reviewing.id ? updated : x));
      onToast(`Leave ${payload.status}`, 'success');
    } catch (e) { onToast(e.message, 'error'); throw e; }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this leave request?')) return;
    try {
      await api.deleteLeave(id);
      setLeaves(l => l.filter(x => x.id !== id));
      onToast('Deleted', 'success');
    } catch (e) { onToast(e.message, 'error'); }
  };

  const filtered = leaves.filter(l => {
    if (!search) return true;
    const q = search.toLowerCase();
    return l.employees?.name?.toLowerCase().includes(q) ||
           l.employees?.department?.toLowerCase().includes(q);
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [search, filters.status, filters.type, rowsPerPage]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const pageStart = (currentPage - 1) * rowsPerPage;
  const pageEnd = pageStart + rowsPerPage;
  const visibleLeaves = filtered.slice(pageStart, pageEnd);
  const showingStart = filtered.length ? pageStart + 1 : 0;
  const showingEnd = Math.min(pageEnd, filtered.length);

  // Summary counts
  const pending  = leaves.filter(l => l.status === 'pending').length;
  const approved = leaves.filter(l => l.status === 'approved').length;
  const rejected = leaves.filter(l => l.status === 'rejected').length;

  const setF = k => e => setFilters(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      {/* Header */}
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Leave Management</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{filtered.length} requests</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} /> File Leave
        </button>
      </div>

      {/* Stat cards */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card amber">
          <div className="stat-label">Pending</div>
          <div className="stat-value">{pending}</div>
          <div className="stat-meta">Awaiting review</div>
        </div>
        <div className="stat-card green">
          <div className="stat-label">Approved</div>
          <div className="stat-value">{approved}</div>
          <div className="stat-meta">This view</div>
        </div>
        <div className="stat-card red">
          <div className="stat-label">Rejected</div>
          <div className="stat-value">{rejected}</div>
          <div className="stat-meta">This view</div>
        </div>
        <div className="stat-card blue">
          <div className="stat-label">Total</div>
          <div className="stat-value">{leaves.length}</div>
          <div className="stat-meta">All requests</div>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search-bar" style={{ flex: 1, minWidth: 200 }}>
            <Search />
            <input
              placeholder="Search by name or department…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select value={filters.status} onChange={setF('status')} style={{ width: 160 }}>
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <select value={filters.type} onChange={setF('type')} style={{ width: 160 }}>
            <option value="">All types</option>
            <option value="sick">Sick Leave</option>
            <option value="vacation">Vacation</option>
            <option value="emergency">Emergency</option>
            <option value="unpaid">Unpaid</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /> Loading requests…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <FileText size={36} />
            <p>No leave requests found</p>
          </div>
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
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Days</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleLeaves.map(l => {
                  const typeStyle = TYPE_COLORS[l.type] || TYPE_COLORS.unpaid;
                  return (
                    <tr key={l.id}>
                      <td>
                        <div className="flex-center">
                          <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
                            {(l.employees?.name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{l.employees?.name}</div>
                            <div className="text-dim" style={{ fontSize: 11 }}>{l.employees?.department}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="badge" style={{ background: typeStyle.bg, color: typeStyle.color }}>
                          {l.type}
                        </span>
                      </td>
                      <td className="mono">{l.start_date}</td>
                      <td className="mono">{l.end_date}</td>
                      <td style={{ fontWeight: 600 }}>{l.days}d</td>
                      <td className="text-dim text-sm" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.reason || '—'}
                      </td>
                      <td>
                        <span className={`badge ${l.status}`}>
                          <span className="badge-dot" />{l.status}
                        </span>
                      </td>
                      <td className="text-dim text-sm">{l.notes || '—'}</td>
                      <td>
                        <div className="flex-center gap-2">
                          {l.status === 'pending' && (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setReviewing(l)}
                              title="Review"
                            >
                              Review
                            </button>
                          )}
                          <button
                            className="btn btn-icon btn-danger btn-sm"
                            onClick={() => handleDelete(l.id)}
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
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

      {showAdd && (
        <LeaveModal
          employees={employees}
          onClose={() => setShowAdd(false)}
          onSave={handleCreate}
        />
      )}

      {reviewing && (
        <StatusModal
          leave={reviewing}
          onClose={() => setReviewing(null)}
          onSave={handleReview}
        />
      )}
    </div>
  );
}
