import { getToken, clearSession } from '../utils/session.js';

const BASE = `${import.meta.env.VITE_API_URL || ''}/api`;

async function request(path, options = {}) {
  const token = getToken();

  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    ...options,
  });

  if (res.status === 401) {
    // Token missing/expired/invalid — the backend is the source of truth here.
    // Clear the stale session and tell the app to show the login screen.
    clearSession();
    window.dispatchEvent(new CustomEvent('session-expired'));
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Health Check
  getHealth: () => request('/health'),

  // Employees
  getEmployees: () => request('/employees'),
  getEmployee: (id) => request(`/employees/${id}`),
  createEmployee: (body) => request('/employees', { method: 'POST', body: JSON.stringify(body) }),
  updateEmployee: (id, body) => request(`/employees/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteEmployee: (id) => request(`/employees/${id}`, { method: 'DELETE' }),

  // Employee attendance inactivity (flags employees with no attendance record
  // for 7+ consecutive working days — separate from driver inactivity below)
  checkEmployeeInactivity: () => request('/employees/check-inactivity', { method: 'POST' }),
  getEmployeeInactivityLogs: () => request('/employees/inactivity-logs'),
  notifyInactiveEmployee: (id) => request(`/employees/${id}/notify-inactive`, { method: 'POST' }),

  // Fingerprint enrollment (primary + 2 backups per employee, captured by an
  // ESP32 + sensor terminal — see routes/fingerprints.routes.js)
  getEmployeeFingerprints: (employeeId) => request(`/employees/${employeeId}/fingerprints`),
  requestFingerprintEnrollment: (employeeId, slot_label) =>
    request(`/employees/${employeeId}/fingerprints/enroll-request`, { method: 'POST', body: JSON.stringify({ slot_label }) }),
  getFingerprintRequestStatus: (employeeId, requestId) =>
    request(`/employees/${employeeId}/fingerprints/requests/${requestId}`),
  cancelFingerprintRequest: (employeeId, requestId) =>
    request(`/employees/${employeeId}/fingerprints/requests/${requestId}`, { method: 'DELETE' }),
  deleteEmployeeFingerprint: (employeeId, fingerprintId) =>
    request(`/employees/${employeeId}/fingerprints/${fingerprintId}`, { method: 'DELETE' }),

  // Attendance
  getAttendance: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/attendance${qs ? `?${qs}` : ''}`);
  },
  getToday: () => request('/attendance/today'),
  clockIn:    (employee_id) => request('/attendance/clock-in',    { method: 'POST', body: JSON.stringify({ employee_id }) }),
  clockOut:   (employee_id) => request('/attendance/clock-out',   { method: 'PUT',  body: JSON.stringify({ employee_id }) }),
  breakStart: (employee_id) => request('/attendance/break-start', { method: 'POST', body: JSON.stringify({ employee_id }) }),
  breakEnd:   (employee_id) => request('/attendance/break-end',   { method: 'POST', body: JSON.stringify({ employee_id }) }),
  manualAttendance: (body) => request('/attendance', { method: 'POST', body: JSON.stringify(body) }),
  bulkImportAttendance: (records) => request('/attendance/bulk-import', { method: 'POST', body: JSON.stringify({ records }) }),
  deleteAttendance: (id) => request(`/attendance/${id}`, { method: 'DELETE' }),

  // Leaves
  getLeaves: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/leaves${qs ? `?${qs}` : ''}`);
  },
  createLeave: (body) => request('/leaves', { method: 'POST', body: JSON.stringify(body) }),
  updateLeaveStatus: (id, body) => request(`/leaves/${id}/status`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLeave: (id) => request(`/leaves/${id}`, { method: 'DELETE' }),

  // Analytics
  getSummary: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/analytics/summary${qs ? `?${qs}` : ''}`);
  },
  getCutoffReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/analytics/cutoff${qs ? `?${qs}` : ''}`);
  },
  getCutoffDetails: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/analytics/cutoff/details${qs ? `?${qs}` : ''}`);
  },

  // Shift templates (reusable shift definitions, e.g. "Morning Shift" 06:00-14:00)
  getShiftTemplates: () => request('/shift-templates'),
  createShiftTemplate: (body) => request('/shift-templates', { method: 'POST', body: JSON.stringify(body) }),
  updateShiftTemplate: (id, body) => request(`/shift-templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteShiftTemplate: (id) => request(`/shift-templates/${id}`, { method: 'DELETE' }),

  // Schedule (which employee has which shift template on which date)
  getSchedule: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/schedule${qs ? `?${qs}` : ''}`);
  },
  assignShift: (body) => request('/schedule', { method: 'POST', body: JSON.stringify(body) }),
  assignRecurringShift: (body) => request('/schedule/recurring', { method: 'POST', body: JSON.stringify(body) }),
  deleteShiftAssignment: (id) => request(`/schedule/${id}`, { method: 'DELETE' }),

  // Drivers (external `drivers` table — license/trip tracking, unrelated to
  // the fleet-driver coverage logic below)
  getDrivers: () => request('/drivers'),
  createDriver: (body) => request('/drivers', { method: 'POST', body: JSON.stringify(body) }),
  updateDriver: (id, body) => request(`/drivers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteDriver: (id) => request(`/drivers/${id}`, { method: 'DELETE' }),
  checkDriverInactivity: () => request('/drivers/check-inactivity', { method: 'POST' }),
  getInactivityLogs: () => request('/drivers/inactivity-logs'),

  // Fleet driver coverage (employees with position 'Driver' — one morning
  // driver, one night driver, one reserve driver on standby). Lives under
  // /api/schedule since it's schedule/coverage logic, not employee CRUD.
  getFleetDrivers: (date) => request(`/schedule/fleet-drivers${date ? `?date=${date}` : ''}`),
  getAbsentDrivers: (date) => request(`/schedule/absent-drivers${date ? `?date=${date}` : ''}`),
  getAvailableDrivers: (date, excludeEmployeeId) => {
    const qs = new URLSearchParams({ ...(date && { date }), ...(excludeEmployeeId && { exclude_employee_id: excludeEmployeeId }) }).toString();
    return request(`/schedule/available-drivers${qs ? `?${qs}` : ''}`);
  },
  setDriverAvailability: (id, availability, reason) => request(`/schedule/drivers/${id}/availability`, { method: 'PATCH', body: JSON.stringify({ availability, reason }) }),
  reassignDriver: (body) => request('/schedule/reassign-driver', { method: 'POST', body: JSON.stringify(body) }),
  autoReassignDrivers: (date) => request('/schedule/auto-reassign-drivers', { method: 'POST', body: JSON.stringify({ date }) }),
  getDriverReassignments: (date) => request(`/schedule/reassignments${date ? `?date=${date}` : ''}`),
  deleteDriverReassignment: (id) => request(`/schedule/reassignments/${id}`, { method: 'DELETE' }),

  // Staffing requirements (how many of a position are needed for a given
  // role/shift on a given date) + coverage (required vs. actually assigned)
  getStaffingRequirements: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/staffing-requirements${qs ? `?${qs}` : ''}`);
  },
  getCoverage: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/staffing-requirements/coverage${qs ? `?${qs}` : ''}`);
  },
  createStaffingRequirement: (body) => request('/staffing-requirements', { method: 'POST', body: JSON.stringify(body) }),
  createRecurringStaffingRequirement: (body) => request('/staffing-requirements/recurring', { method: 'POST', body: JSON.stringify(body) }),
  updateStaffingRequirement: (id, body) => request(`/staffing-requirements/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteStaffingRequirement: (id) => request(`/staffing-requirements/${id}`, { method: 'DELETE' }),

  getPositions: () => request('/positions'),

  // Excel export is a blob response (not JSON), so it can't go through the
  // shared request() helper above — but it still needs the same base URL,
  // auth header, and 401 handling.
  async exportAttendance(rows, password, filename) {
    const token = getToken();
    const res = await fetch(`${BASE}/attendance/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ rows, password, filename }),
    });

    if (res.status === 401) {
      clearSession();
      window.dispatchEvent(new CustomEvent('session-expired'));
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Export failed');
    }

    return res.blob();
  },
};