import { Router } from 'express';
import {
  getAll, getOne, create, update, remove,
  getInactivityLogs, checkInactivity, notifyInactive,
} from '../controllers/employees.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

// NOTE: these literal GET routes must stay registered before GET /:id below,
// or Express will treat "inactivity-logs" etc. as an :id value.
router.get('/inactivity-logs', requireAuth, requirePermission('employees:read'), getInactivityLogs);
router.post('/check-inactivity', requireAuth, requirePermission('employees:update'), checkInactivity);
router.post('/:id/notify-inactive', requireAuth, requirePermission('employees:update'), notifyInactive);

// 🟢 Fleet-driver routes moved to schedule.routes.js (mounted at
// /api/schedule) — see that file for fleet-drivers, reassign-driver, etc.

router.get('/', requireAuth, requirePermission('employees:read'), getAll);
router.post('/', requireAuth, requirePermission('employees:create'), create);
router.get('/:id', requireAuth, requirePermission('employees:read'), getOne);
router.put('/:id', requireAuth, requirePermission('employees:update'), update);
router.delete('/:id', requireAuth, requirePermission('employees:delete'), remove);
export default router;