import { Router } from 'express';
import {
  listRequirements, createRequirement, createRecurringRequirement,
  updateRequirement, deleteRequirement, getCoverage,
} from '../controllers/staffingRequirements.controller.js';

const router = Router();

// mounted at /api/staffing-requirements in server.js
router.get('/', listRequirements);
router.get('/coverage', getCoverage);
router.post('/', createRequirement);
router.post('/recurring', createRecurringRequirement);
router.put('/:id', updateRequirement);
router.delete('/:id', deleteRequirement);

export default router;