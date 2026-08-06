-- Fleet Driver Availability uses employees.position = 'Driver' as the source
-- of truth. The drivers table remains available for driver metadata only.

CREATE INDEX IF NOT EXISTS idx_employees_driver_position
  ON public.employees (position)
  WHERE lower(position) = 'driver';

CREATE INDEX IF NOT EXISTS idx_attendance_employee_date
  ON public.attendance (employee_id, date);

CREATE INDEX IF NOT EXISTS idx_shift_assignments_employee_date
  ON public.shift_assignments (employee_id, date);

-- A reassignment exists as an audit record even after its replacement becomes
-- unavailable. Only active coverage suppresses the need for a replacement.
ALTER TABLE public.employee_reassignments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalid', 'cancelled', 'completed')),
  ADD COLUMN IF NOT EXISTS invalid_reason text,
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_automatically boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_reassignments_active_coverage
  ON public.employee_reassignments (date, original_employee_id)
  WHERE status = 'active';
