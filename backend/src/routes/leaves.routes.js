import { Router } from 'express';
import { getAll, create, updateStatus, remove } from '../controllers/leaves.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

router.get('/', requireAuth, requirePermission('leaves:read'), getAll);
router.post('/', requireAuth, requirePermission('leaves:create'), create);
router.patch('/:id/status', requireAuth, requirePermission('leaves:approve'), updateStatus);
router.delete('/:id', requireAuth, requirePermission('leaves:delete'), remove);
export default router;
