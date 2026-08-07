import { Router } from 'express';
import {
  previewReconciliation,
  commitReconciliation,
  commitReconciliationRange,
} from '../controllers/attendance.reconciliation.controller.js';
import { reconcileDate } from '../jobs/reconcileAttendanceCron.js';

// Adjust the import paths above to wherever you place these files
// (matches the existing pattern in schedule.routes.js / attendance.routes.js
// — controllers live in ../controllers, this file lives in routes/, the
// cron job lives in ../jobs/).

const router = Router();

// GET /api/attendance/reconcile/preview?date=2026-08-06&verbose=true
// Read-only — safe to call anytime, changes nothing.
router.get('/reconcile/preview', previewReconciliation);

// POST /api/attendance/reconcile/commit
// Body: { date: '2026-08-06', employee_ids?: ['uuid1', 'uuid2'] }
// Writes status: 'absent' rows for reconciliation candidates.
router.post('/reconcile/commit', commitReconciliation);

// POST /api/attendance/reconcile/run-range
// Body: { start_date: '2026-08-01', end_date: '2026-08-15' }
// Backfills a whole range — e.g. call this right before pulling
// getCutoffReport / getCutoffDetails for the same period.
router.post('/reconcile/run-range', commitReconciliationRange);

// POST /api/attendance/reconcile/run-now
// Body: {} or { date: '2026-08-06' } — defaults to today (Manila) if omitted.
// Manually fires the SAME function the 11:55 PM cron job calls — this isn't
// a separate implementation, so testing this endpoint tells you the actual
// nightly job works, not just a stand-in for it. Use this from
// Postman/admin panel instead of waiting for 11:55 PM to see if it's wired
// up correctly.
router.post('/reconcile/run-now', async (req, res) => {
  // reconcileDate takes an explicit date — it doesn't default internally —
  // so we compute "today" (Manila) here if the caller didn't pass one.
  const date = req.body?.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  try {
    const result = await reconcileDate(date);
    res.json({ triggered: 'manual', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Reconciliation run failed' });
  }
});

export default router;

// ── Mounting ────────────────────────────────────────────────────────────
// In your main routes file (wherever attendance.routes.js currently gets
// mounted), add this alongside it:
//
//   import attendanceReconciliationRoutes from './routes/attendance_reconciliation.routes.js';
//   app.use('/api/attendance', attendanceReconciliationRoutes);
//
// This assumes attendance.routes.js is already mounted at '/api/attendance'
// — adjust the base path to match your app's actual convention if it's
// mounted somewhere else.