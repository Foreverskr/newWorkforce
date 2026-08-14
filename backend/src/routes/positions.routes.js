import { Router } from 'express';
import { listPositions, createPosition } from '../controllers/positions.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

// Mounted at /api/positions in server.js
router.get('/', requireAuth, requirePermission('positions:read'), listPositions);
router.post('/', requireAuth, requirePermission('positions:manage'), createPosition);
export default router;