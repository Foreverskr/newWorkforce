import { Router } from 'express';
import { check } from '../controllers/health.controller.js';

const router = Router();

router.get('/', check);

export default router;
