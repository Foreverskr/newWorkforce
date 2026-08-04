# AttendTrack — Full-Stack Attendance System

Node.js + React + Supabase attendance management system with real-time clock-in/out, employee management, and analytics.

---

## Stack

| Layer    | Technology                  |
|----------|-----------------------------|
| Frontend | React 18, Vite, Recharts    |
| Backend  | Node.js, Express            |
| Database | Supabase (PostgreSQL)       |
| Styling  | Plain CSS (no framework)    |

---

## Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Open **SQL Editor** and paste + run `schema.sql` (included in root)
3. Copy your **Project URL** and **service_role key** from:  
   Settings → API → Project API keys

### 2. Configure the backend

```bash
cd backend
cp .env.example .env
# Edit .env and fill in your Supabase URL and service role key
```

`.env`:
```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...your-service-role-key
PORT=3001
```

### 3. Install dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 4. Run the app

Open two terminals:

```bash
# Terminal 1 — Backend API (port 3001)
cd backend
npm start

# Terminal 2 — Frontend (port 5173)
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## API Reference

### Employees
| Method | Endpoint              | Description          |
|--------|-----------------------|----------------------|
| GET    | /api/employees        | List all employees   |
| GET    | /api/employees/:id    | Get one employee     |
| POST   | /api/employees        | Create employee      |
| PUT    | /api/employees/:id    | Update employee      |
| DELETE | /api/employees/:id    | Delete employee      |

### Attendance
| Method | Endpoint                    | Description            |
|--------|-----------------------------|------------------------|
| GET    | /api/attendance             | List records (filterable by date, status, employee) |
| GET    | /api/attendance/today       | Today's summary        |
| POST   | /api/attendance/clock-in    | Clock in               |
| PUT    | /api/attendance/clock-out   | Clock out              |
| POST   | /api/attendance             | Manual record (admin)  |
| DELETE | /api/attendance/:id         | Delete record          |

### Analytics
| Method | Endpoint                    | Description         |
|--------|-----------------------------|---------------------|
| GET    | /api/analytics/summary      | Summary with charts data (start_date, end_date query params) |

---

## Features

- **Dashboard** — Today's live stats: present, absent, late counts + shift progress bars
- **Clock In/Out** — Employee select + animated clock buttons with late detection (15 min grace period)
- **Attendance** — Date range filter, status filter, employee filter, manual add, delete
- **Employees** — Full CRUD: add, edit, delete, search, department filter
- **Analytics** — 7/14/30/90-day trend charts, pie chart, department breakdown table

---

## Folder Structure

```
attendance-system/
├── schema.sql              ← Run this in Supabase SQL Editor
├── backend/
│   ├── .env.example
│   ├── package.json
│   ├── server.js           ← Express API
│   └── supabase.js         ← Supabase client
└── frontend/
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── App.jsx
        ├── index.css
        ├── main.jsx
        ├── lib/api.js       ← API client
        ├── components/
        │   ├── Sidebar.jsx
        │   └── Toast.jsx
        └── pages/
            ├── Dashboard.jsx
            ├── ClockPage.jsx
            ├── AttendancePage.jsx
            ├── EmployeesPage.jsx
            └── AnalyticsPage.jsx
```
