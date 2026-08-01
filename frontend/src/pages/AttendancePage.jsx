import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Plus, Trash2, Calendar, Upload, Download } from 'lucide-react';
import { api } from '../lib/api';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';

// Builds a local YYYY-MM-DD string without going through UTC (toISOString()
// converts to UTC first, which shows yesterday's date for users east of UTC
// during their early-morning hours).
function toISODate(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
}

// Handles Excel/Sheets date cells. Sheets store dates as plain serial numbers
// with no timezone attached, so we parse that number directly (pure arithmetic,
// no JS Date involved) — the only reliable way to avoid off-by-one shifts for
// users outside UTC. A Date object is only handled here as a defensive fallback,
// using local getters since that's how such a Date would have been constructed.
function normalizeImportDate(value) {
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  if (value instanceof Date && !isNaN(value)) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const dd = String(value.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(value ?? '').trim();
}

// Handles "Clock In"/"Clock Out" cells the same way — parsed straight from the
// numeric time serial (fraction of a day), with no JS Date/timezone involved.
function normalizeImportTime(value) {
  if (value === '' || value === null || value === undefined) return null;

  if (typeof value === 'number') {
    const totalSeconds = Math.round((value % 1) * 86400);
    const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  if (value instanceof Date && !isNaN(value)) {
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');
    const ss = String(value.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  return String(value).trim();
}

function ManualModal({ employees, onClose, onSave }) {
  const [form, setForm] = useState({
    employee_id: '', date: toISODate(new Date()),
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
    start_date: toISODate(new Date()),
    end_date: toISODate(new Date()),
    status: '', employee_id: '',
  });
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

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

  // Export currently filtered records to .xlsx — opens fine in Excel or Google Sheets (File > Import)
  const handleExport = () => {
    const rows = filtered.map(r => ({
      'Employee Name': r.employees?.name || '',
      'Employee Code': r.employees?.employee_id || '',
      'Department': r.employees?.department || '',
      'Date': r.date,
      'Clock In': r.clock_in || '',
      'Clock Out': r.clock_out || '',
      'Hours': r.hours_worked ?? '',
      'Status': r.status,
      'Notes': r.notes || '',
    }));

    if (rows.length === 0) { onToast('No records to export', 'error'); return; }

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    const filename = `attendance_${filters.start_date}_to_${filters.end_date}.xlsx`;
    XLSX.writeFile(wb, filename);
    onToast(`Exported ${rows.length} record(s)`, 'success');
  };

  // Import from an .xlsx/.xls/.csv file (works with files exported from Excel or Google Sheets).
  // Matches rows to employees by "Employee Code" first, falling back to "Employee Name".
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (rows.length === 0) { onToast('No rows found in file', 'error'); return; }

      const byCode = new Map(employees.map(emp => [String(emp.employee_id).trim().toLowerCase(), emp]));
      const byName = new Map(employees.map(emp => [String(emp.name).trim().toLowerCase(), emp]));

      const records = [];
      let skipped = 0;

      for (const row of rows) {
        const code = String(row['Employee Code'] ?? row['employee_code'] ?? '').trim().toLowerCase();
        const name = String(row['Employee Name'] ?? row['Employee'] ?? row['employee_name'] ?? '').trim().toLowerCase();
        const emp = (code && byCode.get(code)) || (name && byName.get(name));
        const rawDate = row['Date'] ?? row['date'];

        if (!emp || !rawDate) { skipped++; continue; }

        records.push({
          employee_id: emp.id,
          date: normalizeImportDate(rawDate),
          clock_in: normalizeImportTime(row['Clock In'] ?? row['clock_in']),
          clock_out: normalizeImportTime(row['Clock Out'] ?? row['clock_out']),
          status: String(row['Status'] || row['status'] || 'present').toLowerCase(),
          notes: row['Notes'] || row['notes'] || null,
        });
      }

      if (records.length === 0) {
        onToast('No rows matched a known employee — check "Employee Code" or "Employee Name" column', 'error');
        return;
      }

      const result = await api.bulkImportAttendance(records);
      onToast(
        `Imported ${result.imported} record(s)${skipped ? `, skipped ${skipped} unmatched row(s)` : ''}`,
        'success'
      );
      load();
    } catch (err) {
      onToast(err.message || 'Import failed — check the file format', 'error');
    } finally {
      setImporting(false);
      e.target.value = ''; // allow re-selecting the same file later
    }
  };

  return (
    <div className="page">
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>Attendance Records</h2>
          <p className="text-dim text-sm" style={{ marginTop: 4 }}>{filtered.length} records</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="file"
            ref={fileInputRef}
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
          <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            <Upload size={14} /> {importing ? 'Importing…' : 'Import'}
          </button>
          <button className="btn btn-ghost" onClick={handleExport}>
            <Download size={14} /> Export
          </button>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={14} /> Add Record
          </button>
        </div>
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
                    <td>{r.employees?.department ? r.employees.department : '⚠️ MISSING'}</td>
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