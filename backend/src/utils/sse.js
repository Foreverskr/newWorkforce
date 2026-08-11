const clients = new Set();

export function addSseClient(res, req) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 1000\n\n');
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
}

export function broadcastSseEvent(eventName, payload = {}) {
  const data = JSON.stringify(payload);

  for (const client of [...clients]) {
    try {
      client.write(`event: ${eventName}\n`);
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      clients.delete(client);
    }
  }
}
