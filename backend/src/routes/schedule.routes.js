import { Router } from 'express';
import {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  getSchedule, createAssignment, createRecurring, deleteAssignment,
  proposeAssignment, proposeRecurringAssignment, getPendingProposals,
  approveProposal, rejectProposal, approveProposalBatch, rejectProposalBatch,
  getFleetDrivers, getAbsentDrivers, getAvailableDrivers, setDriverAvailability,
  getReassignments, reassignDriver, deleteReassignment, autoReassignDrivers,
} from '../controllers/schedule.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

// ── Shift templates ── mounted at /api/shift-templates in server.js
export const templateRouter = Router();
templateRouter.get('/', requireAuth, requirePermission('shiftTemplates:read'), listTemplates);
templateRouter.post('/', requireAuth, requirePermission('shiftTemplates:manage'), createTemplate);
templateRouter.put('/:id', requireAuth, requirePermission('shiftTemplates:manage'), updateTemplate);
templateRouter.delete('/:id', requireAuth, requirePermission('shiftTemplates:manage'), deleteTemplate);

// ── Schedule (shift assignments) ── mounted at /api/schedule in server.js
// Direct writes stay admin-only — hr_staff must go through /propose instead.
router.get('/', requireAuth, requirePermission('schedule:read'), getSchedule);
router.post('/', requireAuth, requirePermission('schedule:update'), createAssignment);
router.post('/recurring', requireAuth, requirePermission('schedule:update'), createRecurring);
router.delete('/:id', requireAuth, requirePermission('schedule:update'), deleteAssignment);

// ── Schedule change proposals (hr_staff / hr_manager propose → gets approved) ──
router.post('/propose', requireAuth, requirePermission('schedule:propose'), proposeAssignment);
router.post('/propose/recurring', requireAuth, requirePermission('schedule:propose'), proposeRecurringAssignment);
router.get('/pending', requireAuth, requirePermission('schedule:approve'), getPendingProposals);
router.patch('/proposals/:id/approve', requireAuth, requirePermission('schedule:approve'), approveProposal);
router.patch('/proposals/:id/reject', requireAuth, requirePermission('schedule:approve'), rejectProposal);
router.patch('/proposals/batch/:batchId/approve', requireAuth, requirePermission('schedule:approve'), approveProposalBatch);
router.patch('/proposals/batch/:batchId/reject', requireAuth, requirePermission('schedule:approve'), rejectProposalBatch);

// ── Fleet driver coverage (reserve-driver auto/manual replacement) ──
router.get('/fleet-drivers', requireAuth, requirePermission('drivers:read'), getFleetDrivers);
router.get('/absent-drivers', requireAuth, requirePermission('drivers:read'), getAbsentDrivers);
router.get('/available-drivers', requireAuth, requirePermission('drivers:read'), getAvailableDrivers);
router.patch('/drivers/:id/availability', requireAuth, requirePermission('drivers:manage'), setDriverAvailability);
router.get('/reassignments', requireAuth, requirePermission('drivers:read'), getReassignments);
router.post('/reassign-driver', requireAuth, requirePermission('drivers:manage'), reassignDriver);
router.post('/auto-reassign-drivers', requireAuth, requirePermission('drivers:manage'), autoReassignDrivers);
router.delete('/reassignments/:id', requireAuth, requirePermission('drivers:manage'), deleteReassignment);

export default router;