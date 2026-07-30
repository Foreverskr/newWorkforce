import { Router } from 'express';
import { identify } from '../controllers/fingerprints.controller.js';
import { requireDeviceKey } from '../middleware/deviceAuth.js';

const router = Router();

router.post('/identify', requireDeviceKey, identify);

export default router;