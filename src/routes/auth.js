const express = require('express');
const router = express.Router();
const { login } = require('../middleware/auth');

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

module.exports = router;
