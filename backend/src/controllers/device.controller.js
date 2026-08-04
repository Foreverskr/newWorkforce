import { supabase } from '../config/supabase.js';
import { handleError } from '../middleware/errorHandler.js';

// *** REQUIRES a schema change first ***
// ALTER TABLE public.fingerprint_enrollment_requests
//   ADD COLUMN assigned_sensor_slot_id integer;
//
// Why: the device previously picked its own slot number via
// finger.getTemplateCount() on the sensor itself. If that sensor had any
// orphaned/leftover templates from earlier testing, getTemplateCount()
// returned an inflated number and new enrollments landed on unpredictable
// slots the backend never agreed to. The fix is for the BACKEND to decide
// the slot number and hand it to the device - the device just writes
// wherever it's told.
//
// Why assign it at CLAIM time (in getNextJob), not at COMPLETE time: if we
// computed "next free slot" only when completeJob() runs, two enrollment
// jobs claimed close together could both compute the same "next free"
// number before either finishes scanning, and collide. Assigning it the
// moment a job is claimed - and persisting it on the request row - means
// each claimed job locks in its own number immediately, so a slower/faster
// scan on a concurrent job can't race it.

// GET /api/device/fingerprints/next-job?device_id=ESP32-01
export async function getNextJob(req, res) {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });

  const { data: job, error: findError } = await supabase
    .from('fingerprint_enrollment_requests')
    .select('*, employees(name, employee_id)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findError) return handleError(res, findError);
  if (!job) return res.json({ job: null });

  // Compute the next free slot number FOR THIS DEVICE, from the backend's
  // own records - never from anything the sensor reports. This mirrors the
  // same "what slot has this device already used" logic pendingSync()
  // already relies on for the attendance side, applied here for a
  // brand-new enrollment instead of a resync.
  const { data: existingSlots, error: slotError } = await supabase
    .from('employee_fingerprints')
    .select('sensor_slot_id')
    .eq('device_id', device_id)
    .order('sensor_slot_id', { ascending: false })
    .limit(1);
  if (slotError) return handleError(res, slotError);

  const nextSlot = existingSlots.length > 0 ? existingSlots[0].sensor_slot_id + 1 : 0;

  // Claim the job AND lock in the assigned slot in the same update, guarded
  // by status='pending' so a racing second device can't double-claim it.
  const { data: claimed, error: claimError } = await supabase
    .from('fingerprint_enrollment_requests')
    .update({
      status: 'capturing',
      device_id,
      assigned_sensor_slot_id: nextSlot,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('*, employees(name, employee_id)')
    .maybeSingle();
  if (claimError) return handleError(res, claimError);
  if (!claimed) return res.json({ job: null }); // another device grabbed it first

  // The firmware reads this field as job["sensor_slot_id"] (see the fixed
  // enrollment sketch), while the DB column is named assigned_sensor_slot_id
  // to avoid confusion with employee_fingerprints.sensor_slot_id (a
  // different thing - that one is the CONFIRMED slot after a successful
  // enroll, this one is the PROPOSED slot for an in-progress job). Map the
  // key explicitly here rather than renaming the column, so the two
  // meanings stay distinguishable in the database.
  res.json({
    job: {
      ...claimed,
      sensor_slot_id: claimed.assigned_sensor_slot_id,
    },
  });
}

// POST /api/device/fingerprints/complete
// body: { request_id, sensor_slot_id, template_data? }
//
// sensor_slot_id from the device is now VERIFIED against what the backend
// assigned at claim time, rather than trusted blindly. If firmware is
// ever out of sync with this backend version (e.g. still running old code
// that guesses its own slot), this catches the mismatch instead of quietly
// recording a wrong slot number.
export async function completeJob(req, res) {
  const { request_id, sensor_slot_id, template_data } = req.body;
  if (!request_id || sensor_slot_id === undefined) {
    return res.status(400).json({ error: 'request_id and sensor_slot_id are required' });
  }

  const { data: request, error: reqError } = await supabase
    .from('fingerprint_enrollment_requests')
    .select('*')
    .eq('id', request_id)
    .eq('status', 'capturing')
    .single();
  if (reqError || !request) return res.status(404).json({ error: 'No matching in-progress request' });

  if (
    request.assigned_sensor_slot_id !== null &&
    request.assigned_sensor_slot_id !== sensor_slot_id
  ) {
    console.error(
      `Slot mismatch on complete: backend assigned ${request.assigned_sensor_slot_id}, ` +
      `device reported ${sensor_slot_id}. Firmware may be out of date. Rejecting.`
    );
    return res.status(409).json({
      error: `Backend assigned slot ${request.assigned_sensor_slot_id} but device reported ${sensor_slot_id}`,
    });
  }

  const { error: upsertError } = await supabase
    .from('employee_fingerprints')
    .upsert(
      [{
        employee_id: request.employee_id,
        slot_label: request.slot_label,
        device_id: request.device_id,
        sensor_slot_id,
        template_data: template_data || null,
        enrolled_at: new Date().toISOString(),
      }],
      { onConflict: 'employee_id,slot_label,device_id' }
    );
  if (upsertError) return handleError(res, upsertError);

  await supabase
    .from('fingerprint_enrollment_requests')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', request_id);

  res.json({ message: 'Fingerprint enrolled' });
}

// POST /api/device/fingerprints/fail
// body: { request_id, error_message }
export async function failJob(req, res) {
  const { request_id, error_message } = req.body;
  if (!request_id) return res.status(400).json({ error: 'request_id is required' });

  const { data, error } = await supabase
    .from('fingerprint_enrollment_requests')
    .update({ status: 'failed', error_message: error_message || 'Unknown error', updated_at: new Date().toISOString() })
    .eq('id', request_id)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: 'Request not found' });

  res.json(data);
}