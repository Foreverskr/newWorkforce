import { Router } from 'express';
import { listPositions, createPosition } from '../controllers/positions.controller.js';

const router = Router();

// Mounted at /api/positions in server.js
router.get('/', listPositions);
router.post('/', createPosition);

export default router;