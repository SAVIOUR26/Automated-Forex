const bcrypt = require('bcryptjs');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  // Check for API key (for modem engine / external devices)
  const apiKey = req.headers['x-api-key'];
  const deviceKey = process.env.DEVICE_API_KEY || process.env.ANDROID_API_KEY;
  if (apiKey && deviceKey && apiKey === deviceKey) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.redirect('/login');
}

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const deviceKey = process.env.DEVICE_API_KEY || process.env.ANDROID_API_KEY;
  if (apiKey && deviceKey && apiKey === deviceKey) {
    return next();
  }

  // Also allow session-authenticated requests
  if (req.session && req.session.authenticated) {
    return next();
  }

  res.status(401).json({ error: 'Invalid API key' });
}

function login(username, password) {
  const validUser = process.env.DEALER_USERNAME || 'admin';
  const validPass = process.env.DEALER_PASSWORD || 'admin';

  return username === validUser && password === validPass;
}

module.exports = { requireAuth, requireApiKey, login };
