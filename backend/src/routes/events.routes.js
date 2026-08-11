import { Router } from 'express';
import { addSseClient } from '../utils/sse.js';

const router = Router();

router.get('/', (req, res) => {
  addSseClient(res, req);
});

export default router;