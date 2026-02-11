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
const crypto = require('crypto');

const { migrate } = require('./models/migrate');
const { seed } = require('./models/seed');
const BinanceMonitor = require('./services/binanceMonitor');
const TelegramNotifier = require('./services/telegramBot');
const ExchangeEngine = require('./services/exchangeEngine');
const Settings = require('./models/Settings');
const { requireAuth } = require('./middleware/auth');
const { getDb } = require('./models/database');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

// ─── Initialize Database ─────────────────────────────────
migrate();
seed();

// ─── SQLite Session Store ────────────────────────────────
// Dashboard sessions survive server restarts (no more MemoryStore)
function createSessionStore(sessionModule) {
  const Store = sessionModule.Store;

  class SQLiteStore extends Store {
    constructor() {
      super();
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expired_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired_at);
      `);
      // Prune expired sessions every 15 minutes
      this._pruneInterval = setInterval(() => this._prune(), 15 * 60 * 1000);
    }

    get(sid, cb) {
      try {
        const db = getDb();
        const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired_at > ?').get(sid, Date.now());
        cb(null, row ? JSON.parse(row.sess) : null);
      } catch (err) { cb(err); }
    }

    set(sid, sess, cb) {
      try {
        const db = getDb();
        const maxAge = (sess.cookie && sess.cookie.maxAge) || 86400000;
        const expiredAt = Date.now() + maxAge;
        db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expiredAt);
        if (cb) cb(null);
      } catch (err) { if (cb) cb(err); }
    }

    destroy(sid, cb) {
      try {
        const db = getDb();
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        if (cb) cb(null);
      } catch (err) { if (cb) cb(err); }
    }

    _prune() {
      try {
        const db = getDb();
        db.prepare('DELETE FROM sessions WHERE expired_at < ?').run(Date.now());
      } catch (err) {
        console.error('[SessionStore] Prune error:', err.message);
      }
    }
  }

  return new SQLiteStore();
}

// ─── Express App ─────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── WebSocket for live updates (with auth + ping/pong) ──
const wss = new WebSocket.Server({ noServer: true });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// WebSocket authentication — verify session or API key before allowing connection
server.on('upgrade', (request, socket, head) => {
  // Only handle /ws path
  if (request.url !== '/ws') {
    socket.destroy();
    return;
  }

  // Check for API key in query string (for programmatic access)
  const url = new URL(request.url, `http://${request.headers.host}`);
  const apiKey = url.searchParams.get('apiKey');
  if (apiKey && apiKey === process.env.ANDROID_API_KEY) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }

  // Parse session cookie for dashboard users
  const cookieHeader = request.headers.cookie || '';
  const sidMatch = cookieHeader.match(/connect\.sid=([^;]+)/);
  if (sidMatch) {
    const rawSid = decodeURIComponent(sidMatch[1]);
    // express-session signs cookies as s:<sid>.<signature>
    const sidParts = rawSid.match(/^s:(.+)\./);
    const sid = sidParts ? sidParts[1] : rawSid;

    const db = getDb();
    const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired_at > ?').get(sid, Date.now());
    if (row) {
      try {
        const sess = JSON.parse(row.sess);
        if (sess.authenticated) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
          return;
        }
      } catch (e) { /* invalid session */ }
    }
  }

  // Reject unauthenticated connections
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  socket.destroy();
});

// WebSocket ping/pong keep-alive — detects dead connections
const WS_PING_INTERVAL = 30000;
const wsAliveCheck = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

wss.on('close', () => clearInterval(wsAliveCheck));

// ─── Security & Middleware ───────────────────────────────

// Trust Nginx reverse proxy (fixes X-Forwarded-For and secure cookies)
app.set('trust proxy', 1);

const DOMAIN = process.env.DOMAIN || 'ngabopay.online';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameSrc: ["'self'"],
    },
  },
}));

// CORS locked to our domain only (not wide open)
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [`https://${DOMAIN}`, `https://www.${DOMAIN}`]
    : true,
  credentials: true,
}));

app.use(morgan('short'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session with SQLite store — survives server restarts
const sessionMiddleware = session({
  store: createSessionStore(session),
  secret: process.env.SESSION_SECRET || 'ngabopay-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Nginx handles HTTPS termination
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);

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
  binanceUrl: process.env.BINANCE_P2P_URL || 'https://www.binance.com/en/my/orders/p2p',
});

const exchangeEngine = new ExchangeEngine(telegram);

// Store services on app for route access
app.set('monitor', monitor);
app.set('exchangeEngine', exchangeEngine);
app.set('telegram', telegram);
app.set('broadcast', broadcast);

// ─── Monitor Events ─────────────────────────────────────
monitor.on('order_detected', async (order) => {
  console.log(`[Server] Order detected: ${order.orderId} (Binance: ${order.binanceStatus})`);
  const transaction = await exchangeEngine.processDetectedOrder(order);
  if (transaction) {
    broadcast('new_transaction', transaction);
  }
});

// Binance status changed for a known order (e.g. buyer_paid → completed)
monitor.on('order_status_changed', async (order) => {
  console.log(`[Server] Order status changed: ${order.orderId} → ${order.binanceStatus}`);
  const transaction = await exchangeEngine.handleBinanceStatusChange(order);
  if (transaction) {
    broadcast('transaction_updated', transaction);
  }
});

monitor.on('monitoring_started', () => broadcast('monitor_status', { isRunning: true, browserLaunched: true, sessionHealthy: true }));
monitor.on('monitoring_stopped', () => broadcast('monitor_status', { isRunning: false, browserLaunched: !!monitor.browser }));
monitor.on('error', (err) => broadcast('monitor_error', { message: err.message }));

// Session expired — Binance login required again
monitor.on('session_expired', async () => {
  console.warn('[Server] Binance session expired! Re-login required.');
  broadcast('monitor_error', { message: 'Binance session expired. Please log in again via the Browser tab.' });
  if (telegram) {
    await telegram.send('⚠️ <b>Binance session expired!</b>\nMonitoring is paused. Open the dashboard and re-login to Binance via the Browser tab.').catch(() => {});
  }
});

// Session expiring soon — early warning
monitor.on('session_expiring', async ({ minutesLeft }) => {
  console.warn(`[Server] Binance session expiring in ${minutesLeft} minutes`);
  broadcast('monitor_warning', { message: `Binance session expires in ~${minutesLeft} minutes. Consider re-logging in soon.` });
  if (telegram) {
    await telegram.send(`⏰ <b>Binance session expiring soon!</b>\nSession will expire in ~${minutesLeft} minutes. Please re-login via the Browser tab to avoid interruption.`).catch(() => {});
  }
});

// Monitor stale — no successful polls
monitor.on('monitor_stale', () => {
  broadcast('monitor_warning', { message: 'No successful poll in 5 minutes. The page may be unresponsive.' });
});

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
║  Sessions:  SQLite-backed (persistent)   ║
║  CORS:      ${process.env.NODE_ENV === 'production' ? 'Locked to ' + DOMAIN : 'Open (dev mode)'}  ║
╚══════════════════════════════════════════╝
  `);
});

// ─── Graceful Shutdown ──────────────────────────────────
async function shutdown() {
  console.log('\n[Server] Shutting down...');
  clearInterval(wsAliveCheck);
  await monitor.close();
  const { closeDb } = require('./models/database');
  closeDb();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
