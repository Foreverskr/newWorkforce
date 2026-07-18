// Centralizes the `if (error) return res.status(500).json({ error: error.message })`
// pattern that was repeated in nearly every route.
//
// Usage in a controller:
//   const { data, error } = await supabase.from('employees').select('*');
//   if (error) return handleError(res, error);
//   res.json(data);
export function handleError(res, error, status = 500) {
  console.error(error.message || error);
  return res.status(status).json({ error: error.message || 'Unexpected error' });
}

// Optional catch-all for anything that throws instead of returning
// { error }, e.g. a bug in a controller. Mount last, after all routes.
export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(err.stack || err);
  res.status(500).json({ error: err.message || 'Internal server error' });
}
