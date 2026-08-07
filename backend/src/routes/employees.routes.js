import { Router } from 'express';
import {
  getAll, getOne, create, update, remove,
  getInactivityLogs, checkInactivity, notifyInactive,
} from '../controllers/employees.controller.js';

const router = Router();

// NOTE: these literal GET routes must stay registered before GET /:id below,
// or Express will treat "inactivity-logs" etc. as an :id value.
router.get('/inactivity-logs', getInactivityLogs);
router.post('/check-inactivity', checkInactivity);
router.post('/:id/notify-inactive', notifyInactive);

// 🟢 Fleet-driver routes moved to schedule.routes.js (mounted at
// /api/schedule) — see that file for fleet-drivers, reassign-driver, etc.

router.get('/', getAll);
router.post('/', create);

router.get('/:id', getOne);
router.put('/:id', update);
router.delete('/:id', remove);

export default router;