import { Router } from 'express';
import { getSummary } from '../controllers/analytics.controller.js';

const router = Router();

router.get('/summary', getSummary);

export default router;
