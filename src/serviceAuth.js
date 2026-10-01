'use strict';
const crypto = require('crypto');

function requireServiceAuth(req, res, next) {
  if (req.method === 'GET' && ['/', '/health'].includes(req.path)) return next();
  const expected = process.env.ROBOT_SERVICE_KEY || '';
  if (!expected) return res.status(503).json({ error: 'ROBOT_AUTH_NOT_CONFIGURED' });
  const supplied = req.get('X-Robot-Service-Key') || '';
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}
module.exports = { requireServiceAuth };
