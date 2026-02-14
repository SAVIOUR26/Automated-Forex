const express = require('express');
const router = express.Router();
const { login, changePassword, resetPassword } = require('../middleware/auth');

router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile('login.html', { root: './public' });
});

router.post('/login', express.json(), (req, res) => {
  const { username, password } = req.body;

  if (login(username, password)) {
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ success: true, redirect: '/' });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Change password (requires current session)
router.post('/change-password', express.json(), (req, res) => {
  if (!req.session || !req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const result = changePassword(current_password, new_password);
  if (result.success) {
    res.json({ success: true, message: 'Password changed successfully' });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Reset password (localhost only — for SSH admin recovery)
router.post('/reset-password', express.json(), (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || '';
  const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp);

  if (!isLocalhost) {
    return res.status(403).json({ error: 'Password reset only available from the server itself' });
  }

  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  resetPassword(new_password);
  res.json({ success: true, message: 'Password reset successfully. You can now log in with the new password.' });
});

module.exports = router;
