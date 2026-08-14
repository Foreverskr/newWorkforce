import { Router } from 'express';
import { 
  getSummary,
  getCutoffReport,
  getCutoffDetails 
} from '../controllers/analytics.controller.js';
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js';
const router = Router();

// Existing endpoint - Overview analytics (7, 14, 30, 90 day ranges)
router.get('/summary', requireAuth, requirePermission('analytics:read'), getSummary);

// 🆕 NEW: Get monthly cutoff report (both cutoff periods at a glance)
// Returns summary data for both cutoff 1 (1-15) and cutoff 2 (16-end)
// Query params:
//   - year (optional): e.g., 2026 (default: current year)
//   - month (optional): 1-12 (default: current month)
// Example: GET /api/analytics/cutoff?year=2026&month=8
router.get('/cutoff', requireAuth, requirePermission('analytics:read'), getCutoffReport);

// 🆕 NEW: Get detailed cutoff report with HR recommendations
// Returns comprehensive analysis for a specific cutoff period
// Query params:
//   - year (required): e.g., 2026
//   - month (required): 1-12
//   - cutoff (required): 1 or 2
// Example: GET /api/analytics/cutoff/details?year=2026&month=8&cutoff=1
router.get('/cutoff/details', requireAuth, requirePermission('analytics:read'), getCutoffDetails);

export default router;