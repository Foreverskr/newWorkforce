import { Router } from 'express';
import {
  getAll, create, update, remove, getInactivityLogs, checkInactivity,
} from '../controllers/drivers.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

// NOTE: literal routes registered before /:id, same reasoning as employees.routes.js
router.get('/inactivity-logs', requireAuth, requirePermission('drivers:read'), getInactivityLogs);
router.post('/check-inactivity', requireAuth, requirePermission('drivers:manage'), checkInactivity);
router.get('/', requireAuth, requirePermission('drivers:read'), getAll);
router.post('/', requireAuth, requirePermission('drivers:manage'), create);
router.put('/:id', requireAuth, requirePermission('drivers:manage'), update);
router.delete('/:id', requireAuth, requirePermission('drivers:manage'), remove);
export default router;
