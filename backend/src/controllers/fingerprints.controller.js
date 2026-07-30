import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

const SLOTS = ['primary', 'backup_1', 'backup_2'];

// GET /api/employees/:employeeId/fingerprints
// Returns the 3 slots with whatever state they're in: enrolled, a pending/
// capturing request, or empty — so the UI can render all 3 rows every time.
// UNCHANGED.
export async function listForEmployee(req, res) {
  const { employeeId } = req.params;

  const { data: enrolled, error: enrolledError } = await supabase
    .from('employee_fingerprints')
    .select('id, slot_label, device_id, sensor_slot_id, enrolled_at')
    .eq('employee_id', employeeId);
  if (enrolledError) return handleError(res, enrolledError);

  const { data: pending, error: pendingError } = await supabase
    .from('fingerprint_enrollment_requests')
    .select('id, slot_label, status, device_id, error_message, created_at')
    .eq('employee_id', employeeId)
    .in('status', ['pending', 'capturing'])
    .order('created_at', { ascending: false });
  if (pendingError) return handleError(res, pendingError);

  const enrolledBySlot = Object.fromEntries(enrolled.map(f => [f.slot_label, f]));
  const pendingBySlot = Object.fromEntries(pending.map(r => [r.slot_label, r]));

  const slots = SLOTS.map(slot_label => ({
    slot_label,
    fingerprint: enrolledBySlot[slot_label] || null,
    request: pendingBySlot[slot_label] || null,
  }));

  res.json({ employee_id: employeeId, slots });
}

// POST /api/employees/:employeeId/fingerprints/enroll-request
// body: { slot_label }
// Creates a pending job for the ESP32 to pick up. Re-enrolling a slot just
// cancels any stale pending/capturing request for it first.
// UNCHANGED.
export async function createEnrollRequest(req, res) {
  const { employeeId } = req.params;
  const { slot_label } = req.body;

  if (!SLOTS.includes(slot_label)) {
    return res.status(400).json({ error: `slot_label must be one of: ${SLOTS.join(', ')}` });
  }

  const { data: employee, error: empError } = await supabase
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .single();
  if (empError || !employee) return res.status(404).json({ error: 'Employee not found' });

  await supabase
    .from('fingerprint_enrollment_requests')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('employee_id', employeeId)
    .eq('slot_label', slot_label)
    .in('status', ['pending', 'capturing']);

  const { data, error } = await supabase
    .from('fingerprint_enrollment_requests')
    .insert([{ employee_id: employeeId, slot_label }])
    .select()
    .single();
  if (error) return handleError(res, error);

  res.status(201).json(data);
}

// GET /api/employees/:employeeId/fingerprints/requests/:requestId
// UNCHANGED.
export async function getRequestStatus(req, res) {
  const { data, error } = await supabase
    .from('fingerprint_enrollment_requests')
    .select('*')
    .eq('id', req.params.requestId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Request not found' });
  res.json(data);
}

// DELETE /api/employees/:employeeId/fingerprints/requests/:requestId
// UNCHANGED.
export async function cancelRequest(req, res) {
  const { data, error } = await supabase
    .from('fingerprint_enrollment_requests')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', req.params.requestId)
    .in('status', ['pending', 'capturing'])
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: 'No cancellable request found' });
  res.json(data);
}

// DELETE /api/employees/:employeeId/fingerprints/:fingerprintId
// Only removes our record. It does NOT delete the template off the sensor
// itself — see the note in device.controller.js if you want to add that.
// UNCHANGED.
export async function deleteFingerprint(req, res) {
  const { error } = await supabase
    .from('employee_fingerprints')
    .delete()
    .eq('id', req.params.fingerprintId)
    .eq('employee_id', req.params.employeeId);
  if (error) return handleError(res, error);
  res.json({ message: 'Fingerprint record removed' });
}

// POST /api/device/fingerprints/identify
// Called by the attendance kiosk after a successful LOCAL match against the
// sensor's own template library. Resolves (device_id, sensor_slot_id) -> employee.
// UNCHANGED.
export async function identify(req, res) {
  const { device_id, sensor_slot_id } = req.body;

  if (!device_id || sensor_slot_id === undefined || sensor_slot_id === null) {
    return res.status(400).json({ error: 'device_id and sensor_slot_id are required' });
  }

  const { data: match, error } = await supabase
    .from('employee_fingerprints')
    .select('employee_id, slot_label, employees(id, name, employee_id, status, department)')
    .eq('device_id', device_id)
    .eq('sensor_slot_id', sensor_slot_id)
    .maybeSingle();

  if (error) return handleError(res, error);

  if (!match) {
    return res.status(404).json({ error: 'No employee enrolled for this fingerprint slot on this device' });
  }

  if (match.employees.status !== 'active') {
    return res.status(403).json({ error: `${match.employees.name} is marked inactive` });
  }

  res.json({
    employee_id: match.employees.id,
    name: match.employees.name,
    employee_code: match.employees.employee_id,
    department: match.employees.department,
    slot_label: match.slot_label,
  });
}

// GET /api/device/fingerprints/pending-sync?device_id=kiosk-front-door-01
// Called by the attendance kiosk (e.g. on boot, or on a timer) to ask:
// "which enrolled employees do I not have an up-to-date local template for?"
//
// CHANGED (this revision): previously, a first-time sync (this device has
// never synced this employee+slot before) sent existing_local_slot: null,
// and firmware fell back to finger.getTemplateCount() to guess a slot -
// which lies right after a wipe (reports 0 for everyone, colliding with
// whatever else gets assigned slot 0 next). Now the backend assigns a REAL
// slot for every entry, first-time or not, the same way getNextJob() does
// for enrollment: track the highest sensor_slot_id this device has already
// used, and hand out highest+1, highest+2, etc. for each new entry in this
// batch. The firmware never needs to guess a slot number again.
export async function pendingSync(req, res) {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });

  const { data: allRows, error } = await supabase
    .from('employee_fingerprints')
    .select('employee_id, slot_label, device_id, sensor_slot_id, template_data, employees(name)')
    .not('template_data', 'is', null);

  if (error) return handleError(res, error);

  // Group by (employee, slot). Track every device's copy of template_data
  // and slot, and separately remember the "source of truth" template_data
  // (prefer the enrollment device's copy over the syncing device's own).
  const bySlot = {};
  for (const row of allRows) {
    const key = `${row.employee_id}:${row.slot_label}`;
    if (!bySlot[key]) {
      bySlot[key] = {
        employee_id: row.employee_id,
        slot_label: row.slot_label,
        name: row.employees.name,
        sourceTemplateData: row.template_data,
        byDevice: {},
      };
    }
    bySlot[key].byDevice[row.device_id] = { template_data: row.template_data, sensor_slot_id: row.sensor_slot_id };
    if (row.device_id !== device_id) {
      bySlot[key].sourceTemplateData = row.template_data;
    }
  }

  const pendingEntries = Object.values(bySlot).filter(entry => {
    const mine = entry.byDevice[device_id];
    if (!mine) return true; // never synced to this device at all
    return mine.template_data !== entry.sourceTemplateData; // synced, but stale
  });

  // Highest slot THIS device already uses, from data already loaded above -
  // no extra query needed. Each first-time assignment in the loop below
  // bumps this, so a batch of several new employees in one response each
  // get distinct numbers instead of colliding on the same "next free" slot.
  let highestKnownSlot = -1;
  for (const entry of Object.values(bySlot)) {
    const mine = entry.byDevice[device_id];
    if (mine && mine.sensor_slot_id > highestKnownSlot) {
      highestKnownSlot = mine.sensor_slot_id;
    }
  }

  const pending = pendingEntries.map(entry => {
    const mine = entry.byDevice[device_id];
    let assignedSlot;
    if (mine) {
      // Re-sync of a stale template: reuse this device's own existing slot -
      // storeModel() overwrites it in place on the AS608/R307.
      assignedSlot = mine.sensor_slot_id;
    } else {
      // First-time sync for this employee on this device: assign the next
      // free slot for THIS device, backend-side.
      highestKnownSlot += 1;
      assignedSlot = highestKnownSlot;
    }
    return {
      employee_id: entry.employee_id,
      slot_label: entry.slot_label,
      name: entry.name,
      template_data: entry.sourceTemplateData,
      existing_local_slot: assignedSlot,
    };
  });

  res.json({ device_id, pending });
}

// DELETE /api/device/fingerprints/reset-device-sync
// body: { device_id }
//
// NEW. Call this ONCE, as part of the "wipe" flow (the attendance firmware
// calls it automatically right after emptyDatabase() succeeds). It deletes
// this device's rows from employee_fingerprints, so the backend's belief
// about "what this device already has" matches physical reality again.
// Without this, wiping the sensor and calling pending-sync afterward
// reports "0 pending" forever, since the backend still thinks everything
// was already synced to this device.
//
// This only removes rows WHERE device_id matches - it does not touch other
// devices' rows (e.g. the enrollment device's original template_data stays
// intact, since that's a separate row keyed by its own device_id).
export async function resetDeviceSync(req, res) {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });

  const { data, error } = await supabase
    .from('employee_fingerprints')
    .delete()
    .eq('device_id', device_id)
    .select();
  if (error) return handleError(res, error);

  res.json({ message: `Reset sync state for ${device_id}`, rows_removed: data.length });
}

// POST /api/device/fingerprints/register-synced
// body: { employee_id, slot_label, device_id, sensor_slot_id }
// Called by the attendance kiosk AFTER it has successfully written a synced
// template into its own sensor's local memory at sensor_slot_id.
// UNCHANGED.
export async function registerSynced(req, res) {
  const { employee_id, slot_label, device_id, sensor_slot_id } = req.body;

  if (!employee_id || !slot_label || !device_id || sensor_slot_id === undefined) {
    return res.status(400).json({ error: 'employee_id, slot_label, device_id, sensor_slot_id are required' });
  }

  const { data: source } = await supabase
    .from('employee_fingerprints')
    .select('template_data')
    .eq('employee_id', employee_id)
    .eq('slot_label', slot_label)
    .not('template_data', 'is', null)
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from('employee_fingerprints')
    .upsert(
      [{
        employee_id,
        slot_label,
        device_id,
        sensor_slot_id,
        template_data: source?.template_data || null,
      }],
      { onConflict: 'employee_id,slot_label,device_id' }
    )
    .select()
    .single();

  if (error) {
    console.error("registerSynced error:", error);
    return handleError(res, error);
  }

  res.json({ message: 'Synced', data });
}