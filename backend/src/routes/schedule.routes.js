import { Router } from 'express';
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  getSchedule, createAssignment, createRecurring, deleteAssignment,
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

export default router;
