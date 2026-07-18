const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
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

  // Drivers
  getDrivers: () => request('/drivers'),
  createDriver: (body) => request('/drivers', { method: 'POST', body: JSON.stringify(body) }),
  updateDriver: (id, body) => request(`/drivers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteDriver: (id) => request(`/drivers/${id}`, { method: 'DELETE' }),
  checkDriverInactivity: () => request('/drivers/check-inactivity', { method: 'POST' }),
  getInactivityLogs: () => request('/drivers/inactivity-logs'),

  // Fleet driver replacement (employees flagged is_fleet_driver — separate from the external drivers table above)
  getFleetDrivers: (date) => request(`/employees/fleet-drivers${date ? `?date=${date}` : ''}`),
  getAbsentDrivers: (date) => request(`/employees/absent-drivers${date ? `?date=${date}` : ''}`),
  getAvailableDrivers: (date, excludeEmployeeId) => {
    const qs = new URLSearchParams({ ...(date && { date }), ...(excludeEmployeeId && { exclude_employee_id: excludeEmployeeId }) }).toString();
    return request(`/employees/available-drivers${qs ? `?${qs}` : ''}`);
  },
  setDriverAvailability: (id, availability, reason) => request(`/employees/${id}/driver-availability`, { method: 'PATCH', body: JSON.stringify({ availability, reason }) }),
  reassignDriver: (body) => request('/employees/reassign-driver', { method: 'POST', body: JSON.stringify(body) }),
  getDriverReassignments: (date) => request(`/employees/reassignments${date ? `?date=${date}` : ''}`),
  deleteDriverReassignment: (id) => request(`/employees/reassignments/${id}`, { method: 'DELETE' }),
};