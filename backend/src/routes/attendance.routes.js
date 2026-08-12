import { Router } from 'express';
import {
  getAll, getToday, clockIn, clockOut, breakStart, breakEnd, create, remove, bulkImport, exportExcel,
  getBreakPolicyConfig, updateBreakPolicyConfig,
} from '../controllers/attendance.controller.js';

const router = Router();

router.get('/', getAll);
router.get('/today', getToday);

router.post('/clock-in', clockIn);
router.put('/clock-out', clockOut);

router.post('/break-start', breakStart);
router.post('/break-end', breakEnd);

router.get('/break-policies', getBreakPolicyConfig);
router.put('/break-policies', updateBreakPolicyConfig);

router.post('/export', exportExcel);
router.post('/bulk-import', bulkImport);
router.post('/', create);
router.delete('/:id', remove);

export default router;