import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { addClient, removeClient } from './sseManager.js';
import authenticate from '../middleware/auth.middleware.js'; // adjust to your actual export

const router = express.Router();

router.get('/events', authenticate, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const clientId = uuidv4();
  addClient(clientId, res);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(clientId);
  });
});

export default router;