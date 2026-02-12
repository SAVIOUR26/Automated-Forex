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
  const broadcast = app.get('broadcast');

  // ─── Phone Status (DB-persisted via Settings) ───────────
  // Track last heartbeat time and alert on disconnect
  let phoneDisconnectAlerted = false;

  function getPhoneStatus() {
    const lastSeen = Settings.get('phone_last_seen', null);
    const device = Settings.get('phone_device', null);
    const isPolling = Settings.getBoolean('phone_is_polling', false);
    const payoutsCompleted = parseInt(Settings.get('phone_payouts_completed', '0')) || 0;

    let connected = false;
    if (lastSeen) {
      const elapsed = Date.now() - new Date(lastSeen).getTime();
      connected = elapsed < 60000;
    }

    return { connected, last_seen: lastSeen, device, is_polling: isPolling, payouts_completed: payoutsCompleted };
  }

  // ─── Stuck Payout Recovery (runs every 5 minutes) ──────
  setInterval(() => {
    const reset = Transaction.resetStuckPayouts(10);
    if (reset > 0) {
      console.log(`[API] Auto-reset ${reset} stuck payout(s) after 10min timeout`);
      ActivityLog.log('stuck_payouts_reset', { count: reset });
      if (broadcast) broadcast('payout_reset', { count: reset });
    }
  }, 5 * 60 * 1000);

  // ─── Phone Disconnect Monitor (runs every 30 seconds) ──
  setInterval(() => {
    const status = getPhoneStatus();
    if (!status.connected && status.last_seen && !phoneDisconnectAlerted) {
      phoneDisconnectAlerted = true;
      console.warn('[API] Android phone disconnected!');
      if (telegram) {
        telegram.send('⚠️ <b>Phone Disconnected!</b>\nThe Android app has not sent a heartbeat in over 60 seconds. Payouts will not be processed until the app reconnects.').catch(() => {});
      }
      if (broadcast) broadcast('phone_disconnected', { last_seen: status.last_seen });
    } else if (status.connected && phoneDisconnectAlerted) {
      phoneDisconnectAlerted = false;
      console.log('[API] Android phone reconnected');
      if (telegram) {
        telegram.send('✅ <b>Phone Reconnected!</b>\nThe Android app is back online and processing payouts.').catch(() => {});
      }
      if (broadcast) broadcast('phone_reconnected', { device: status.device });
    }
  }, 30 * 1000);

  // ─── Dashboard Stats ───────────────────────────────────
  router.get('/stats', requireAuth, (req, res) => {
    const stats = Transaction.getStats();
    const monitorStatus = monitor ? monitor.getStatus() : { isRunning: false };
    const phoneStatus = getPhoneStatus();
    res.json({ ...stats, monitor: monitorStatus, phone: phoneStatus });
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

  // Set customer phone and name for a transaction
  router.put('/transactions/:id/phone', requireAuth, express.json(), (req, res) => {
    const { phone, customer_name } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const transaction = exchangeEngine.setCustomerPhone(parseInt(req.params.id), phone, customer_name);
    res.json(transaction);
  });

  // Confirm a detected order was paid manually (skip automation)
  router.post('/transactions/:id/confirm-paid', requireAuth, express.json(), async (req, res) => {
    const { reference } = req.body;
    const id = parseInt(req.params.id);
    const existing = Transaction.findById(id);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    if (existing.status !== 'detected' || existing.payout_status !== 'pending') {
      return res.status(400).json({ error: 'Can only confirm detected/pending orders' });
    }
    const transaction = await exchangeEngine.markPayoutComplete(id, reference || 'manual');
    if (broadcast) broadcast('transaction_updated', transaction);
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

      // Navigate to Binance — if session is restored, go to orders; else login
      const page = monitor.page;
      await page.goto('https://www.binance.com/en/my/orders/p2p', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }).catch(() => {});

      // Check if redirected to login
      const url = page.url();
      if (url.includes('/login') || url.includes('/account/login')) {
        await page.goto('https://www.binance.com/en/login', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        }).catch(() => {});
      }

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

  // ─── QR Code Pairing ─────────────────────────────────────
  // Returns pairing data for the Android app to scan via QR code

  router.get('/pair/qrdata', requireAuth, (req, res) => {
    const protocol = req.protocol;
    const host = req.get('host');
    const serverUrl = `${protocol}://${host}`;
    const apiKey = process.env.ANDROID_API_KEY || '';

    res.json({
      url: serverUrl,
      key: apiKey,
      name: 'NgaboPay',
    });
  });

  // ─── Android App Endpoints ─────────────────────────────
  // The Android app polls these to get pending payouts and report results

  router.get('/payout/pending', requireApiKey, (req, res) => {
    const pending = Transaction.getPendingPayouts();
    res.json(pending);
  });

  // Atomically claim a payout — prevents double-sends
  router.post('/payout/start', requireApiKey, express.json(), async (req, res) => {
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Transaction ID required' });

    // Use atomic claim instead of plain update
    const transaction = Transaction.claimPayout(transaction_id);
    if (!transaction) {
      return res.status(409).json({ error: 'Payout already claimed or not pending' });
    }

    ActivityLog.log('payout_processing', null, transaction_id);
    if (telegram) {
      await telegram.notifyPayoutProcessing(transaction).catch(() => {});
    }
    if (broadcast) broadcast('transaction_updated', transaction);

    res.json(transaction);
  });

  router.post('/payout/complete', requireApiKey, express.json(), async (req, res) => {
    const { transaction_id, reference } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Transaction ID required' });

    const transaction = await exchangeEngine.markPayoutComplete(transaction_id, reference || 'USSD');
    if (broadcast) broadcast('transaction_updated', transaction);
    res.json(transaction);
  });

  router.post('/payout/failed', requireApiKey, express.json(), async (req, res) => {
    const { transaction_id, reason } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'Transaction ID required' });

    const transaction = await exchangeEngine.markPayoutFailed(transaction_id, reason || 'Unknown error');
    if (broadcast) broadcast('transaction_updated', transaction);
    res.json(transaction);
  });

  // ─── Phone App Heartbeat / Status ─────────────────────
  // Persisted in DB so it survives server restarts

  router.post('/phone/heartbeat', requireApiKey, express.json(), (req, res) => {
    const { device, is_polling, payouts_completed } = req.body;
    Settings.set('phone_last_seen', new Date().toISOString());
    Settings.set('phone_device', device || 'Android');
    Settings.set('phone_is_polling', String(is_polling || false));
    if (payouts_completed !== undefined) {
      Settings.set('phone_payouts_completed', String(payouts_completed));
    }
    res.json({ success: true });
  });

  router.get('/phone/status', requireAuth, (req, res) => {
    res.json(getPhoneStatus());
  });

  // ─── USSD Engine / Modem Endpoints ─────────────────────
  // Proxy to the Python USSD engine running on localhost:7001

  const modemBridge = app.get('modemBridge');

  router.get('/modem/status', requireAuth, async (req, res) => {
    try {
      const status = await modemBridge.getStatus();
      res.json(status);
    } catch (err) {
      res.json({ connected: false, error: err.message });
    }
  });

  router.post('/modem/reconnect', requireAuth, async (req, res) => {
    try {
      const result = await modemBridge.reconnect();
      ActivityLog.log('modem_reconnected', result);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/modem/test-ussd', requireAuth, express.json(), async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'USSD code required' });
    try {
      const result = await modemBridge.testUssd(code);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manually trigger a modem payout for a specific transaction
  router.post('/modem/send-payout/:id', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    const transaction = Transaction.findById(id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    if (!transaction.customer_phone) return res.status(400).json({ error: 'No phone number set' });
    if (transaction.payout_status !== 'pending') {
      return res.status(400).json({ error: `Payout is ${transaction.payout_status}, not pending` });
    }

    try {
      // Claim atomically first
      const claimed = Transaction.claimPayout(id);
      if (!claimed) return res.status(409).json({ error: 'Payout already claimed' });

      ActivityLog.log('modem_payout_triggered', { phone: transaction.customer_phone }, id);
      if (broadcast) broadcast('transaction_updated', claimed);

      await modemBridge.sendPayout(transaction);
      res.json({ success: true, message: 'Payout sent to USSD engine' });
    } catch (err) {
      // If engine rejected, reset payout status so it can be retried
      Transaction.updateStatus(id, 'detected', { payout_status: 'pending' });
      res.status(500).json({ error: err.message });
    }
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
