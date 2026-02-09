require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { migrate } = require('./models/migrate');
const { seed } = require('./models/seed');
const BinanceMonitor = require('./services/binanceMonitor');
const TelegramNotifier = require('./services/telegramBot');
const ExchangeEngine = require('./services/exchangeEngine');
const Settings = require('./models/Settings');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

// ─── Initialize Database ─────────────────────────────────
migrate();
seed();

// ─── Express App ─────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── WebSocket for live updates ──────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ─── Security & Middleware ───────────────────────────────

// Trust Nginx reverse proxy (fixes X-Forwarded-For and secure cookies)
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(morgan('short'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'ngabopay-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Nginx handles HTTPS termination
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Rate limit login POST attempts only (not redirects to login page)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/login', (req, res, next) => {
  if (req.method === 'POST') return loginLimiter(req, res, next);
  next();
});

// ─── Initialize Services ────────────────────────────────
const telegram = new TelegramNotifier(
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_CHAT_ID
);

const monitor = new BinanceMonitor({
  intervalMs: parseInt(process.env.MONITOR_INTERVAL_MS) || 10000,
  binanceUrl: process.env.BINANCE_P2P_URL || 'https://p2p.binance.com/en/myOrder?type=1',
});

const exchangeEngine = new ExchangeEngine(telegram);

// Store services on app for route access
app.set('monitor', monitor);
app.set('exchangeEngine', exchangeEngine);
app.set('telegram', telegram);

// ─── Monitor Events ─────────────────────────────────────
monitor.on('order_detected', async (order) => {
  console.log(`[Server] Order detected: ${order.orderId}`);
  const transaction = await exchangeEngine.processDetectedOrder(order);
  if (transaction) {
    broadcast('new_transaction', transaction);
  }
});

monitor.on('monitoring_started', () => broadcast('monitor_status', { isRunning: true }));
monitor.on('monitoring_stopped', () => broadcast('monitor_status', { isRunning: false }));
monitor.on('error', (err) => broadcast('monitor_error', { message: err.message }));

// ─── Routes ─────────────────────────────────────────────

// Auth routes (login/logout) - no auth required
app.use('/', authRoutes);

// Static assets (CSS, JS, images) - no auth required
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, '..', 'public', 'img')));

// API routes - auth checked per-route
app.use('/api', apiRoutes(app));

// Login page - no auth required
app.get('/login', (req, res) => {
  res.sendFile('login.html', { root: path.join(__dirname, '..', 'public') });
});

// Dashboard - auth required
app.get('/', requireAuth, (req, res) => {
  res.sendFile('index.html', { root: path.join(__dirname, '..', 'public') });
});

// All other routes - auth required, serve dashboard
app.get('*', requireAuth, (req, res) => {
  res.sendFile('index.html', { root: path.join(__dirname, '..', 'public') });
});

// ─── Error Handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ───────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║         NgaboPay Forex Exchange          ║
║──────────────────────────────────────────║
║  Dashboard: http://localhost:${PORT}        ║
║  WebSocket: ws://localhost:${PORT}/ws       ║
║  Status:    Running                      ║
╚══════════════════════════════════════════╝
  `);
});

// ─── Graceful Shutdown ──────────────────────────────────
async function shutdown() {
  console.log('\n[Server] Shutting down...');
  await monitor.close();
  const { closeDb } = require('./models/database');
  closeDb();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
