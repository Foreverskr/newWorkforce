import { Router } from 'express';
import {
  getAll, getOne, create, update, remove,
  getInactivityLogs, checkInactivity,
  getFleetDrivers, getAbsentDrivers, getAvailableDrivers, setDriverAvailability,
  getReassignments, reassignDriver, deleteReassignment,
} from '../controllers/employees.controller.js';

const router = Router();

// NOTE: these literal GET routes must stay registered before GET /:id below,
// or Express will treat "inactivity-logs", "fleet-drivers", etc. as an :id value.
router.get('/inactivity-logs', getInactivityLogs);
router.post('/check-inactivity', checkInactivity);

router.get('/fleet-drivers', getFleetDrivers);
router.get('/absent-drivers', getAbsentDrivers);
router.get('/available-drivers', getAvailableDrivers);
router.patch('/:id/driver-availability', setDriverAvailability);

router.get('/reassignments', getReassignments);
router.post('/reassign-driver', reassignDriver);
router.delete('/reassignments/:id', deleteReassignment);

router.get('/', getAll);
router.post('/', create);

router.get('/:id', getOne);
router.put('/:id', update);
router.delete('/:id', remove);

export default router;
