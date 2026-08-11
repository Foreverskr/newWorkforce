# Workforce System Audit: What Is Actually Active vs. What Looks Optional

Date: 2026-08-10

This document is a practical audit of the current Workforce system based on the active backend route wiring, frontend navigation, and the database schema usage in the repository. It does not change any code.

## 1. What is actually running in the current app

### Frontend entry points
The current web app is wired through:
- [frontend/src/App.jsx](../frontend/src/App.jsx) — main router and page entry points
- [frontend/src/components/Sidebar.jsx](../frontend/src/components/Sidebar.jsx) — visible navigation menu

The currently reachable frontend pages are:
- Dashboard
- Clock In / Out
- Timesheet Management
- Status & Biometrics Management
- Shift & Schedule Management
- Leave Management
- Drivers
- Analytics

### Backend entry point
The live backend server is started from:
- [backend/src/server.js](../backend/src/server.js)

This server mounts the active API modules for:
- Authentication
- Health checks
- Employees
- Attendance
- Leaves
- Analytics
- Schedule and shift templates
- Drivers
- Fingerprint/device workflows
- Events for real-time refresh

### Runtime features that are actually wired
These pieces are currently connected to the running app:
- Login and session-based auth
- Employee management
- Attendance clock-in/out and attendance records
- Leave management
- Daily/period analytics and cutoff reports
- Shift scheduling and recurring assignments
- Driver management and driver availability logic
- Fingerprint enrollment and device-based identity/punch flow
- Server-sent events used to refresh analytics/attendance views
- Nightly attendance reconciliation job

---

## 2. Core modules that look essential

These are the parts that appear to be part of the real working system and should be considered the core of the product.

### A. Core workforce operations
These are the most important operational modules:
- Employees: employee records, status, department, position, and inactivity checks
- Attendance: clock-in/out, attendance status, hours, breaks, manual records, and daily summaries
- Leaves: leave requests and approval state
- Schedule: assigned shifts, recurring assignments, shift templates, and staffing coverage logic

### B. Driver and staffing support
These are active but more specialized than the core attendance flow:
- Drivers and driver inactivity
- Driver availability overrides and reassignments
- Positions and staffing requirements
- Coverage tracking for staffing needs

### C. Fingerprint/device workflow
This is a real system feature, not just a placeholder:
- Enrollment requests
- Fingerprint templates
- ESP32 device identification and punch submission
- Device sync state

### D. Analytics and reporting
The analytics UI is active and is wired to the backend:
- Summary reporting
- Cutoff monthly reports
- Cutoff detail reports
- Live event updates for reporting views

---

## 3. Tables in the schema that are actively used

The following schema tables are directly referenced by the currently mounted backend controllers and routes.

### Definitely active tables
- employees
- attendance
- admins
- leaves
- drivers
- driver_inactivity_logs
- roles
- shift_assignments
- positions
- staffing_requirements
- employee_inactivity_logs
- fingerprint_enrollment_requests
- employee_fingerprints
- employee_reassignments
- driver_availability_overrides

### Why these are considered active
They are referenced directly by the current controllers under:
- [backend/src/controllers/attendance.controller.js](../backend/src/controllers/attendance.controller.js)
- [backend/src/controllers/employees.controller.js](../backend/src/controllers/employees.controller.js)
- [backend/src/controllers/leaves.controller.js](../backend/src/controllers/leaves.controller.js)
- [backend/src/controllers/schedule.controller.js](../backend/src/controllers/schedule.controller.js)
- [backend/src/controllers/staffingRequirements.controller.js](../backend/src/controllers/staffingRequirements.controller.js)
- [backend/src/controllers/device.controller.js](../backend/src/controllers/device.controller.js)
- [backend/src/controllers/fingerprints.controller.js](../backend/src/controllers/fingerprints.controller.js)
- [backend/src/controllers/analytics.controller.js](../backend/src/controllers/analytics.controller.js)

---

## 4. Tables or modules that look optional, legacy, or not needed for the current app

These pieces are present in the repository, but they do not appear to be part of the current active runtime path.

### A. Likely legacy or unused schema tables
The following tables appear to be present but are not currently used by the active backend code paths:
- shift_coverage
- shift_requirements
- role_requirements

Reason:
They are not referenced in the active controller files or the mounted routes that drive the current app.

### B. Duplicate or unused route files
These files exist but are not mounted by the main server:
- [backend/src/routes/fingerprintIdentify.routes.js](../backend/src/routes/fingerprintIdentify.routes.js)
- [backend/realtime/sse.route.js](../backend/realtime/sse.route.js)

Reason:
The live server uses [backend/src/routes/device.routes.js](../backend/src/routes/device.routes.js) for fingerprint/device handling, and the app uses the EventSource route from [backend/src/routes/events.routes.js](../backend/src/routes/events.routes.js).

### C. Prototype or refactor folder
The folder [backend-refactor](../backend-refactor) appears to be a separate prototype or draft implementation.

Reason:
It is not wired into the main runtime server and does not appear to be part of the currently running app.

### D. Reconciliation module is useful, but secondary
The reconciliation feature is active and exposed through API routes, but it is not the main daily attendance flow.
- [backend/src/routes/attendance.reconciliation.routes.js](../backend/src/routes/attendance.reconciliation.routes.js)
- [backend/src/jobs/reconcileAttendanceCron.js](../backend/src/jobs/reconcileAttendanceCron.js)

Reason:
It helps fill in absent attendance rows and improve reporting, but the core app can still function without it. It is more of an operational support feature than the essential user-facing workflow.

---

## 5. What should be kept if you want a leaner system

If the goal is to keep only what is truly necessary for the current product, the minimum useful set is:

### Keep as core
- Authentication and health checks
- Employees
- Attendance
- Leaves
- Scheduling and shift templates
- Positions and staffing requirements
- Drivers
- Analytics
- Fingerprint/device attendance flow

### Keep as supporting features
- Reconciliation job
- Driver reassignments and availability overrides
- Event stream refresh

### Consider archiving or removing later
- shift_coverage
- shift_requirements
- role_requirements
- duplicate fingerprint route file
- prototype backend-refactor folder
- any older SSE prototype code not used by the current server

---

## 6. Practical conclusion

From the current repository structure, the active and meaningful system is centered around:
- attendance tracking,
- employee and driver management,
- staffing/scheduling,
- fingerprint-based attendance,
- analytics,
- and admin auth.

The database schema contains a few extra tables that look like they were planned for earlier or alternative workflows, but they are not part of the currently active code path.

If you want a cleaner future version of the system, the best first step is to keep the core modules above and retire or archive the unused schema and route pieces listed here.
