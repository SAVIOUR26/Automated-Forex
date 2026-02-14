const bcrypt = require('bcryptjs');
const Settings = require('../models/Settings');

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

  // Check DB-stored hashed password first (set via Change Password)
  const storedHash = Settings.get('dealer_password_hash', null);
  if (storedHash && username === validUser) {
    return bcrypt.compareSync(password, storedHash);
  }

  // Fall back to .env plain text
  const validPass = process.env.DEALER_PASSWORD || 'admin';
  return username === validUser && password === validPass;
}

function changePassword(currentPassword, newPassword) {
  // Verify current password first
  const validUser = process.env.DEALER_USERNAME || 'admin';
  if (!login(validUser, currentPassword)) {
    return { success: false, error: 'Current password is incorrect' };
  }

  // Hash and store the new password
  const hash = bcrypt.hashSync(newPassword, 10);
  Settings.set('dealer_password_hash', hash);
  return { success: true };
}

function resetPassword(newPassword) {
  // Force reset — no current password check (for CLI use only)
  const hash = bcrypt.hashSync(newPassword, 10);
  Settings.set('dealer_password_hash', hash);
  return { success: true };
}

module.exports = { requireAuth, requireApiKey, login, changePassword, resetPassword };
