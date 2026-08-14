import { Router } from 'express';
import {
  getAll, getToday, clockIn, clockOut, breakStart, breakEnd, create, remove, bulkImport, exportExcel,
  getBreakPolicyConfig, updateBreakPolicyConfig,
} from '../controllers/attendance.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

router.get('/', requireAuth, requirePermission('attendance:read'), getAll);
router.get('/today', requireAuth, requirePermission('attendance:read'), getToday);
router.post('/clock-in', requireAuth, requirePermission('attendance:update'), clockIn);
router.put('/clock-out', requireAuth, requirePermission('attendance:update'), clockOut);
router.post('/break-start', requireAuth, requirePermission('attendance:update'), breakStart);
router.post('/break-end', requireAuth, requirePermission('attendance:update'), breakEnd);
router.get('/break-policies', requireAuth, requirePermission('attendance:read'), getBreakPolicyConfig);
router.put('/break-policies', requireAuth, requirePermission('attendance:configure'), updateBreakPolicyConfig);
router.post('/export', requireAuth, requirePermission('attendance:export'), exportExcel);
router.post('/bulk-import', requireAuth, requirePermission('attendance:import'), bulkImport);
router.post('/', requireAuth, requirePermission('attendance:create'), create);
router.delete('/:id', requireAuth, requirePermission('attendance:delete'), remove);

export default router;