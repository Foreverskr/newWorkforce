import { Router } from 'express';
import {
  getAll, getToday, clockIn, clockOut, breakStart, breakEnd, create, remove,
} from '../controllers/attendance.controller.js';

const router = Router();

router.get('/', getAll);
router.get('/today', getToday);

router.post('/clock-in', clockIn);
router.put('/clock-out', clockOut);

router.post('/break-start', breakStart);
router.post('/break-end', breakEnd);

router.post('/', create);
router.delete('/:id', remove);

export default router;
