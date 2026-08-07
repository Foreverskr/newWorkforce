import { Router } from 'express';
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  getSchedule, createAssignment, createRecurring, deleteAssignment,
  getFleetDrivers, getAbsentDrivers, getAvailableDrivers, setDriverAvailability,
  getReassignments, reassignDriver, deleteReassignment, autoReassignDrivers,
} from '../controllers/schedule.controller.js';

const router = Router();

// ── Shift templates ── mounted at /api/shift-templates in server.js
export const templateRouter = Router();
templateRouter.get('/', listTemplates);
templateRouter.post('/', createTemplate);
templateRouter.put('/:id', updateTemplate);
templateRouter.delete('/:id', deleteTemplate);

// ── Schedule (shift assignments) ── mounted at /api/schedule in server.js
router.get('/', getSchedule);
router.post('/', createAssignment);
router.post('/recurring', createRecurring);
router.delete('/:id', deleteAssignment);

// ── Fleet driver coverage (reserve-driver auto/manual replacement) ──
// Lives here rather than under /api/employees since this is schedule/coverage
// logic, not employee CRUD — see schedule.controller.js for the roster logic.
router.get('/fleet-drivers', getFleetDrivers);
router.get('/absent-drivers', getAbsentDrivers);
router.get('/available-drivers', getAvailableDrivers);
router.patch('/drivers/:id/availability', setDriverAvailability);

router.get('/reassignments', getReassignments);
router.post('/reassign-driver', reassignDriver);
router.post('/auto-reassign-drivers', autoReassignDrivers);
router.delete('/reassignments/:id', deleteReassignment);

export default router;