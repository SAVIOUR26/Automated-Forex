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
    secure: process.env.NODE_ENV === 'production' && false, // Set true if behind HTTPS proxy
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts' },
});
app.use('/login', loginLimiter);

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
app.use('/', authRoutes);
app.use('/api', apiRoutes(app));

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Dashboard route (protected)
app.get('/', requireAuth, (req, res) => {
  res.sendFile('index.html', { root: path.join(__dirname, '..', 'public') });
});

// Catch-all for SPA-style routing
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
