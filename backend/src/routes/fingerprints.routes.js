import { Router } from 'express';
import {
  listForEmployee,
  createEnrollRequest,
  getRequestStatus,
  cancelRequest,
  deleteFingerprint,
} from '../controllers/fingerprints.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
// mergeParams so this router can read :employeeId from the parent mount in server.js
const router = Router({ mergeParams: true });

router.get('/', requireAuth, requirePermission('fingerprints:manage'), listForEmployee);
router.post('/enroll-request', requireAuth, requirePermission('fingerprints:enroll'), createEnrollRequest);
router.get('/requests/:requestId', requireAuth, requirePermission('fingerprints:enroll'), getRequestStatus);
router.delete('/requests/:requestId', requireAuth, requirePermission('fingerprints:manage'), cancelRequest);
router.delete('/:fingerprintId', requireAuth, requirePermission('fingerprints:manage'), deleteFingerprint);

export default router;