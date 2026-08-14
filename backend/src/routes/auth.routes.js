import { Router } from 'express';
import { login, hashPassword } from '../controllers/auth.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/login', login); // stays open
router.post('/hash', requireAuth, requirePermission('admins:manage'), hashPassword);

export default router;
