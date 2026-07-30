// The ESP32 isn't a logged-in user, so it can't carry an employee/admin JWT.
// Instead it sends a shared secret in a header. Each device gets its own key
// (DEVICE_API_KEY_ENROLL for the enrollment terminal, DEVICE_API_KEY_ATTEND
// for the attendance terminal) so a leaked/rotated key on one device doesn't
// require touching the other. Set both in your .env and flash the matching
// value into each ESP32's firmware.
export function requireDeviceKey(req, res, next) {
  const key = req.headers['x-device-key'];
  const validKeys = [
    process.env.DEVICE_API_KEY_ENROLL,
    process.env.DEVICE_API_KEY_ATTEND,
  ].filter(Boolean); // guards against an unset env var matching an empty header

  if (!key || !validKeys.includes(key)) {
    return res.status(401).json({ error: 'Invalid or missing device key' });
  }
  next();
}