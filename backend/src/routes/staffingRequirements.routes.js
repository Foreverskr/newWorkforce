import { Router } from 'express';
import {
  listRequirements, createRequirement, createRecurringRequirement,
  updateRequirement, deleteRequirement, getCoverage,
  proposeRequirement, proposeRecurringRequirement, getPendingRequirementProposals,
  approveRequirementProposal, rejectRequirementProposal,
  approveRequirementProposalBatch, rejectRequirementProposalBatch,
} from '../controllers/staffingRequirements.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';

const router = Router();

// mounted at /api/staffing-requirements in server.js
// 🔴 SECURITY FIX: these routes previously had no requireAuth/requirePermission
// at all — any request, logged in or not, could read or write staffing
// requirements. Every route below is now gated.
router.get('/', requireAuth, requirePermission('staffingRequirements:read'), listRequirements);
router.get('/coverage', requireAuth, requirePermission('staffingRequirements:read'), getCoverage);

// Direct writes — admin only (same model as /api/schedule).
router.post('/', requireAuth, requirePermission('staffingRequirements:manage'), createRequirement);
router.post('/recurring', requireAuth, requirePermission('staffingRequirements:manage'), createRecurringRequirement);
router.put('/:id', requireAuth, requirePermission('staffingRequirements:manage'), updateRequirement);
router.delete('/:id', requireAuth, requirePermission('staffingRequirements:manage'), deleteRequirement);

// Requirement change proposals (hr_staff / hr_manager propose → gets approved).
router.post('/propose', requireAuth, requirePermission('staffingRequirements:propose'), proposeRequirement);
router.post('/propose/recurring', requireAuth, requirePermission('staffingRequirements:propose'), proposeRecurringRequirement);
router.get('/pending', requireAuth, requirePermission('staffingRequirements:approve'), getPendingRequirementProposals);
router.patch('/proposals/:id/approve', requireAuth, requirePermission('staffingRequirements:approve'), approveRequirementProposal);
router.patch('/proposals/:id/reject', requireAuth, requirePermission('staffingRequirements:approve'), rejectRequirementProposal);
router.patch('/proposals/batch/:batchId/approve', requireAuth, requirePermission('staffingRequirements:approve'), approveRequirementProposalBatch);
router.patch('/proposals/batch/:batchId/reject', requireAuth, requirePermission('staffingRequirements:approve'), rejectRequirementProposalBatch);

export default router;