# Workforce System Overview

Workforce is an attendance and workforce-management system built from a React web application, an Express API, Supabase, and ESP32 fingerprint kiosks.

## Main Parts

- **Frontend (`frontend/`)**: React/Vite dashboard used by HR and administrators. It provides login, dashboard, clocking, attendance, employees, schedules, leaves, drivers, and analytics screens.
- **Backend (`backend/src/`)**: Express REST API. Routes receive requests, middleware checks authentication, controllers apply business rules, and Supabase stores or retrieves data.
- **Database (`schema.sql` / Supabase)**: PostgreSQL data store for employees, attendance, shifts, leaves, drivers, fingerprints, staffing, and related records.
- **ESP32 kiosk (`ESP32 Files/`)**: Connects to Wi-Fi, reads a fingerprint sensor, shows status on the display, identifies an employee, and sends attendance punches to the API.

## Backend Modules

- **Auth and health**: User login, password hashing, session validation, and API health checks.
- **Employees**: Employee CRUD, inactivity checks, fleet-driver availability, and driver reassignment.
- **Attendance**: Clock-in/out(BIOMETRICS), breaks, manual records, bulk import, daily summaries, and deletion.
- **Fingerprints and devices**: Enrollment requests, fingerprint identification, device jobs, template synchronization, and device reset.
- **Schedules**: Shift templates, one-time assignments, and recurring assignments.
- **Leaves**: Leave creation, approval/status changes, listing, and removal.
- **Drivers**: Driver records, inactivity checks, and driver management.
- **Positions and staffing**: Position definitions, staffing requirements, recurring requirements, and coverage checks.
- **Analytics**: Attendance summaries and trend data for the dashboard and reports.

## How It Works

1. A user signs in through the frontend. The backend returns a token, which the frontend sends with protected API requests.
2. The frontend calls `/api/...` endpoints. Express routes apply either user JWT authentication or, for kiosk routes, the shared device key.
3. Controllers validate the request, perform the business operation, and read or write Supabase data.
4. The frontend displays the returned data in the relevant page. It also checks API health periodically and logs out when a session expires.

## Fingerprint Attendance Flow

1. The ESP32 starts, connects to Wi-Fi, synchronizes time, and downloads pending fingerprint templates.
2. An employee places a finger on the sensor. The ESP32 matches the print locally and checks the confidence threshold.
3. The kiosk sends the sensor slot and device ID to `/api/device/fingerprints/identify`.
4. After the backend identifies the employee, the kiosk sends `/api/device/attendance/punch`.
5. The backend applies the attendance and shift rules, saves the punch, and returns the result for the kiosk display.

Fingerprint enrollment starts in the web application. The backend creates an enrollment job, the ESP32 polls for it, stores the captured template, and reports completion. Templates can then be synchronized to other registered devices.

## Security Boundary

Web management routes require a valid, non-expired user token. ESP32 routes do not use user login; they require the configured device key. Supabase access is handled by the backend, so the frontend and kiosk do not connect to the database directly.
