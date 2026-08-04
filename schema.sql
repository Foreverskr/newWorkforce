-- ============================================================
-- AttendTrack — Supabase Schema
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- Employees table
CREATE TABLE IF NOT EXISTS employees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  department    TEXT,
  position      TEXT,
  shift_start   TIME NOT NULL DEFAULT '09:00',
  shift_end     TIME NOT NULL DEFAULT '18:00',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Attendance table
CREATE TABLE IF NOT EXISTS attendance (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  clock_in      TIME,
  clock_out     TIME,
  hours_worked  NUMERIC(5,2),
  status        TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'late', 'absent')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_attendance_date        ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_id ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_status      ON attendance(status);
CREATE INDEX IF NOT EXISTS idx_employees_status       ON employees(status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER attendance_updated_at
  BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Optional: seed some sample employees for testing
-- ============================================================
INSERT INTO employees (employee_id, name, email, department, position, shift_start, shift_end)
VALUES
  ('EMP-001', 'Alice Santos',   'alice@company.com',   'Engineering', 'Senior Engineer',    '09:00', '18:00'),
  ('EMP-002', 'Bob Reyes',      'bob@company.com',     'Marketing',   'Marketing Manager',  '08:00', '17:00'),
  ('EMP-003', 'Clara Lim',      'clara@company.com',   'HR',          'HR Specialist',      '09:00', '18:00'),
  ('EMP-004', 'David Cruz',     'david@company.com',   'Sales',       'Account Executive',  '08:30', '17:30'),
  ('EMP-005', 'Eva Mendoza',    'eva@company.com',     'Design',      'UI/UX Designer',     '10:00', '19:00')
ON CONFLICT DO NOTHING;
