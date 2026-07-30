import { Router } from 'express';
import { requireDeviceKey } from '../middleware/deviceAuth.js';
import { getNextJob, completeJob, failJob } from '../controllers/device.controller.js';
import { identify, pendingSync, registerSynced, resetDeviceSync } from '../controllers/fingerprints.controller.js';
import { punch } from '../controllers/attendance.controller.js';


const router = Router();

router.use(requireDeviceKey);

// Existing — fingerprint enrollment job polling
router.get('/fingerprints/next-job', getNextJob);
router.post('/fingerprints/complete', completeJob);
router.post('/fingerprints/fail', failJob);

// Kiosk attendance flow — no buttons, one auto-detecting endpoint
router.post('/fingerprints/identify', identify);
router.post('/attendance/punch', punch);

// Cross-device template sync
router.get('/fingerprints/pending-sync', pendingSync);
router.post('/fingerprints/register-synced', registerSynced);

// Cross-device template sync
router.get('/fingerprints/pending-sync', pendingSync);
router.post('/fingerprints/register-synced', registerSynced);
router.delete('/fingerprints/reset-device-sync', resetDeviceSync);
export default router;