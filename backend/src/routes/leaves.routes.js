import { Router } from 'express';
import { getAll, create, updateStatus, remove } from '../controllers/leaves.controller.js';

const router = Router();

router.get('/', getAll);
router.post('/', create);
router.patch('/:id/status', updateStatus);
router.delete('/:id', remove);

export default router;
