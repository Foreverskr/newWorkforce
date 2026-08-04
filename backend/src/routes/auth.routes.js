import { Router } from 'express';
import { login, hashPassword } from '../controllers/auth.controller.js';

const router = Router();

// POST /api/auth/login
router.post('/login', login);

// POST /api/auth/hash
router.post('/hash', hashPassword);

export default router;
