import { Router } from 'express';
import {
  listForEmployee,
  createEnrollRequest,
  getRequestStatus,
  cancelRequest,
  deleteFingerprint,
} from '../controllers/fingerprints.controller.js';

// mergeParams so this router can read :employeeId from the parent mount in server.js
const router = Router({ mergeParams: true });

router.get('/', listForEmployee);
router.post('/enroll-request', createEnrollRequest);
router.get('/requests/:requestId', getRequestStatus);
router.delete('/requests/:requestId', cancelRequest);
router.delete('/:fingerprintId', deleteFingerprint);

export default router;