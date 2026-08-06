-- Temporary operational restrictions belong to a driver on a specific date.
-- Do not use employees.driver_availability as the live availability source.
CREATE TABLE IF NOT EXISTS public.driver_availability_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date date NOT NULL,
  availability text NOT NULL CHECK (availability IN ('unavailable', 'restricted')),
  reason text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, date)
);

CREATE INDEX IF NOT EXISTS idx_driver_availability_overrides_date_employee
  ON public.driver_availability_overrides (date, employee_id);
