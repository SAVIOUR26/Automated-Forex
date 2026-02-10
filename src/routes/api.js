const express = require('express');
const router = express.Router();
const { requireAuth, requireApiKey } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const ActivityLog = require('../models/ActivityLog');

module.exports = function(app) {
  const monitor = app.get('monitor');
  const exchangeEngine = app.get('exchangeEngine');
  const telegram = app.get('telegram');

  // ─── Dashboard Stats ───────────────────────────────────
  router.get('/stats', requireAuth, (req, res) => {
    const stats = Transaction.getStats();
    const monitorStatus = monitor ? monitor.getStatus() : { isRunning: false };
    res.json({ ...stats, monitor: monitorStatus });
  });

  // ─── Transactions ──────────────────────────────────────
  router.get('/transactions', requireAuth, (req, res) => {
    const { limit, offset, status, payout_status } = req.query;
    const transactions = Transaction.findAll({
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      status,
      payout_status,
    });
    res.json(transactions);
  });

  router.get('/transactions/:id', requireAuth, (req, res) => {
    const transaction = Transaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Not found' });
    const logs = ActivityLog.getByTransaction(transaction.id);
    res.json({ ...transaction, activity: logs });
  });

  // Set customer phone for a transaction
  router.put('/transactions/:id/phone', requireAuth, express.json(), (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const transaction = exchangeEngine.setCustomerPhone(parseInt(req.params.id), phone);
    res.json(transaction);
  });

  // Mark USDT released
  router.post('/transactions/:id/release', requireAuth, (req, res) => {
    const transaction = exchangeEngine.markUsdtReleased(parseInt(req.params.id));
    res.json(transaction);
  });

  // Manually create a transaction (if order not auto-detected)
  router.post('/transactions', requireAuth, express.json(), (req, res) => {
    const { binance_order_id, usdt_amount, customer_phone, customer_name, local_currency } = req.body;

    if (!binance_order_id || !usdt_amount) {
      return res.status(400).json({ error: 'Order ID and USDT amount required' });
    }

    const currency = local_currency || Settings.get('default_currency', 'UGX');
    const rate = Settings.getExchangeRate(currency);
    const feePercent = Settings.getFeePercent();
    const grossLocal = usdt_amount * rate;
    const feeAmount = grossLocal * (feePercent / 100);
    const localAmount = grossLocal - feeAmount;

    const transaction = Transaction.create({
      binance_order_id,
      usdt_amount: parseFloat(usdt_amount),
      exchange_rate: rate,
      local_currency: currency,
      local_amount: Math.round(localAmount),
      fee_percent: feePercent,
      fee_amount: Math.round(feeAmount),
      customer_phone: customer_phone || null,
      customer_name: customer_name || null,
      status: 'detected',
      payout_status: 'pending',
    });

    ActivityLog.log('manual_order_created', { binance_order_id, usdt_amount }, transaction.id);
    res.json(transaction);
  });

  // ─── Monitor Control (3-step flow) ──────────────────────
  //
  // Step 1: Launch Browser  → opens Chromium on VPS display
  // Step 2: (User logs into Binance via noVNC manually)
  // Step 3: Start Monitoring → polls for "Buyer Paid" orders
  //

  // Step 1: Launch the browser (user then logs in via noVNC)
  router.post('/monitor/launch', requireAuth, async (req, res) => {
    try {
      if (!monitor) return res.status(500).json({ error: 'Monitor not initialized' });

      if (monitor.browser) {
        return res.json({ success: true, message: 'Browser already running', status: monitor.getStatus() });
      }

      await monitor.launch();

      // Navigate to Binance login page so user can see it in noVNC
      await monitor.page.goto('https://www.binance.com/en/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});

      // Take initial screenshot
      await monitor.takeScreenshot();

      ActivityLog.log('browser_launched');
      res.json({ success: true, message: 'Browser launched. Log into Binance via the noVNC viewer, then click Start Monitoring.', status: monitor.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Step 3: Start monitoring (after user has logged into Binance)
  router.post('/monitor/start', requireAuth, async (req, res) => {
    try {
      if (!monitor) return res.status(500).json({ error: 'Monitor not initialized' });

      if (!monitor.browser) {
        return res.status(400).json({ error: 'Browser not launched. Click "Launch Browser" first and log into Binance.' });
      }

      // Navigate to P2P orders page and start polling
      await monitor.navigateToBinance();
      await monitor.startMonitoring();

      Settings.set('monitor_active', 'true');
      ActivityLog.log('monitor_started');
      if (telegram) telegram.notifyMonitorStatus('started');

      res.json({ success: true, status: monitor.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stop monitoring (keeps browser open)
  router.post('/monitor/stop', requireAuth, async (req, res) => {
    try {
      if (monitor) {
        await monitor.stopMonitoring();
        Settings.set('monitor_active', 'false');
        ActivityLog.log('monitor_stopped');
        if (telegram) telegram.notifyMonitorStatus('stopped');
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Close browser entirely
  router.post('/monitor/close', requireAuth, async (req, res) => {
    try {
      if (monitor) {
        await monitor.close();
        Settings.set('monitor_active', 'false');
        ActivityLog.log('browser_closed');
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/monitor/status', requireAuth, (req, res) => {
    res.json(monitor ? monitor.getStatus() : { isRunning: false, browserLaunched: false });
  });

  router.get('/monitor/screenshot', requireAuth, async (req, res) => {
    if (!monitor) return res.status(404).json({ error: 'Monitor not initialized' });

    // Take a fresh screenshot if browser is running
    if (monitor.browser && monitor.page) {
      await monitor.takeScreenshot().catch(() => {});
    }

    const screenshotPath = await monitor.getLatestScreenshot();
    if (screenshotPath) {
      res.sendFile(screenshotPath);
    } else {
      res.status(404).json({ error: 'No screenshot available. Launch the browser first.' });
    }
  });

  // ─── Settings ──────────────────────────────────────────
  router.get('/settings', requireAuth, (req, res) => {
    res.json(Settings.getAll());
  });

  router.put('/settings', requireAuth, express.json(), (req, res) => {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      Settings.set(key, value);
    }
    ActivityLog.log('settings_updated', updates);
    res.json(Settings.getAll());
  });

  router.put('/settings/rate', requireAuth, express.json(), (req, res) => {
    const { currency, rate } = req.body;
    if (!currency || !rate) return res.status(400).json({ error: 'Currency and rate required' });
    Settings.setExchangeRate(currency, parseFloat(rate));
    ActivityLog.log('rate_updated', { currency, rate });
    res.json({ currency, rate: Settings.getExchangeRate(currency) });
  });

  // ─── Activity Log ──────────────────────────────────────
  router.get('/activity', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(ActivityLog.getRecent(limit));
  });

  // ─── Android App Endpoints ─────────────────────────────
  // The Android app polls these to get pending payouts and report results

  router.get('/payout/pending', requireApiKey, (req, res) => {
    const pending = Transaction.getPendingPayouts();
    res.json(pending);
  });

  router.post('/payout/start', requireApiKey, express.json(), async (req, res) => {
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Transaction ID required' });

    const transaction = await exchangeEngine.markProcessing(transaction_id);
    res.json(transaction);
  });

  router.post('/payout/complete', requireApiKey, express.json(), async (req, res) => {
    const { transaction_id, reference } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Transaction ID required' });

    const transaction = await exchangeEngine.markPayoutComplete(transaction_id, reference || 'USSD');
    res.json(transaction);
  });

  router.post('/payout/failed', requireApiKey, express.json(), async (req, res) => {
    const { transaction_id, reason } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Transaction ID required' });

    const transaction = await exchangeEngine.markPayoutFailed(transaction_id, reason || 'Unknown error');
    res.json(transaction);
  });

  // ─── Phone App Heartbeat / Status ─────────────────────
  // The Android app sends heartbeats so the dashboard can show connection status
  let phoneStatus = {
    connected: false,
    last_seen: null,
    device: null,
    is_polling: false,
    payouts_completed: 0,
  };

  router.post('/phone/heartbeat', requireApiKey, express.json(), (req, res) => {
    const { device, is_polling, payouts_completed } = req.body;
    phoneStatus = {
      connected: true,
      last_seen: new Date().toISOString(),
      device: device || 'Android',
      is_polling: is_polling || false,
      payouts_completed: payouts_completed || phoneStatus.payouts_completed,
    };
    res.json({ success: true });
  });

  router.get('/phone/status', requireAuth, (req, res) => {
    // Mark disconnected if no heartbeat in last 60 seconds
    if (phoneStatus.last_seen) {
      const elapsed = Date.now() - new Date(phoneStatus.last_seen).getTime();
      if (elapsed > 60000) {
        phoneStatus.connected = false;
      }
    }
    res.json(phoneStatus);
  });

  // ─── Daily Summary ─────────────────────────────────────
  router.post('/summary', requireAuth, async (req, res) => {
    const stats = Transaction.getStats();
    if (telegram) {
      await telegram.notifyDailySummary(stats);
    }
    res.json(stats);
  });

  return router;
};
