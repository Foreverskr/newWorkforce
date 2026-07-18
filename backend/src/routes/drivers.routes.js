import { Router } from 'express';
import {
  getAll, create, update, remove, getInactivityLogs, checkInactivity,
} from '../controllers/drivers.controller.js';

const router = Router();

// NOTE: literal routes registered before /:id, same reasoning as employees.routes.js
router.get('/inactivity-logs', getInactivityLogs);
router.post('/check-inactivity', checkInactivity);

router.get('/', getAll);
router.post('/', create);
router.put('/:id', update);
router.delete('/:id', remove);

export default router;
