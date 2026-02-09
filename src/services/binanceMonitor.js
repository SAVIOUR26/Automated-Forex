const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const BROWSER_DATA_DIR = path.join(__dirname, '..', '..', 'browser-data');
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'data', 'screenshots');

class BinanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.intervalMs = options.intervalMs || 10000;
    this.pollTimer = null;
    this.wsEndpoint = null;
    this.knownOrders = new Set();
    this.binanceUrl = options.binanceUrl || 'https://p2p.binance.com/en/myOrder?type=1';

    for (const dir of [BROWSER_DATA_DIR, SCREENSHOT_DIR]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  async launch() {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
      ],
    });

    this.wsEndpoint = this.browser.wsEndpoint ? this.browser.wsEndpoint() : null;

    this.context = await this.browser.newContext({
      storageState: this._getStoragePath(),
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }).catch(() => {
      // No saved storage state, create fresh context
      return this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
    });

    this.page = await this.context.newPage();

    // Save storage state periodically for session persistence
    this.context.on('page', async () => {
      await this._saveStorage();
    });

    this.emit('launched');
    console.log('[BinanceMonitor] Browser launched');
  }

  _getStoragePath() {
    const p = path.join(BROWSER_DATA_DIR, 'storage-state.json');
    return fs.existsSync(p) ? p : undefined;
  }

  async _saveStorage() {
    try {
      const storagePath = path.join(BROWSER_DATA_DIR, 'storage-state.json');
      await this.context.storageState({ path: storagePath });
    } catch (err) {
      // Ignore storage save errors
    }
  }

  async navigateToBinance() {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.goto(this.binanceUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
      return this.page.goto(this.binanceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    await this._saveStorage();
    this.emit('navigated');
    console.log('[BinanceMonitor] Navigated to Binance P2P orders');
  }

  async startMonitoring() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit('monitoring_started');
    console.log(`[BinanceMonitor] Monitoring started (interval: ${this.intervalMs}ms)`);

    this._poll();
  }

  async stopMonitoring() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.emit('monitoring_stopped');
    console.log('[BinanceMonitor] Monitoring stopped');
  }

  async _poll() {
    if (!this.isRunning) return;

    try {
      await this._checkForPaidOrders();
    } catch (err) {
      console.error('[BinanceMonitor] Poll error:', err.message);
      this.emit('error', err);
    }

    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this._poll(), this.intervalMs);
    }
  }

  async _checkForPaidOrders() {
    if (!this.page) return;

    // Reload the orders page
    await this.page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});

    // Take a screenshot for the dashboard
    const screenshotPath = path.join(SCREENSHOT_DIR, 'latest.png');
    await this.page.screenshot({ path: screenshotPath }).catch(() => {});

    // Look for "Buyer Paid" / "Paid" status indicators
    // Binance P2P order page shows orders with status badges
    // Extract both USDT amount and the local currency (UGX/KES/TZS) amount
    // shown directly on the Binance order — no manual rate calculation needed
    const orders = await this.page.evaluate(() => {
      const results = [];
      const currencies = ['UGX', 'KES', 'TZS', 'NGN', 'GHS', 'ZAR', 'RWF', 'USD', 'EUR'];

      // Strategy 1: Look for order cards/rows with "Paid" status
      const orderElements = document.querySelectorAll('[class*="order"], [class*="Order"], tr, [data-order]');

      for (const el of orderElements) {
        const text = el.textContent || '';

        // Check if this order shows "Buyer Paid" or "Paid, pending seller release"
        const isPaid = /buyer\s*paid|paid.*pending.*release|paid.*wait/i.test(text);
        if (!isPaid) continue;

        // Extract order ID (typically a long number)
        const orderIdMatch = text.match(/(\d{15,25})/);
        const orderId = orderIdMatch ? orderIdMatch[1] : null;

        // Extract USDT amount
        const usdtMatch = text.match(/([\d,.]+)\s*USDT/i);
        const usdtAmount = usdtMatch ? parseFloat(usdtMatch[1].replace(/,/g, '')) : null;

        // Extract local currency amount + currency code directly from the order
        // Binance shows something like "375,000 UGX" or "UGX 375,000"
        let localAmount = null;
        let localCurrency = null;
        for (const cur of currencies) {
          // Match: "375,000.00 UGX" or "UGX 375,000.00"
          const amountAfter = text.match(new RegExp('([\\d,]+(?:\\.\\d+)?)\\s*' + cur, 'i'));
          const amountBefore = text.match(new RegExp(cur + '\\s*([\\d,]+(?:\\.\\d+)?)', 'i'));
          const match = amountAfter || amountBefore;
          if (match) {
            const parsed = parseFloat(match[1].replace(/,/g, ''));
            // Pick the largest local amount (the fiat total, not the price-per-unit)
            if (parsed > 0 && (!localAmount || parsed > localAmount)) {
              localAmount = parsed;
              localCurrency = cur;
            }
          }
        }

        // Extract price/rate (e.g., "Price 3,750 UGX")
        let exchangeRate = null;
        const priceMatch = text.match(/price[:\s]*([\d,]+(?:\.\d+)?)/i);
        if (priceMatch) {
          exchangeRate = parseFloat(priceMatch[1].replace(/,/g, ''));
        }

        // Extract buyer name
        const nameEl = el.querySelector('[class*="name"], [class*="Name"], [class*="nick"]');
        const buyerName = nameEl ? nameEl.textContent.trim() : null;

        if (orderId && usdtAmount) {
          results.push({
            orderId,
            usdtAmount,
            localAmount,
            localCurrency,
            exchangeRate,
            buyerName,
            rawText: text.substring(0, 800),
          });
        }
      }

      // Strategy 2: Look for status-specific elements
      if (results.length === 0) {
        const statusElements = document.querySelectorAll('[class*="status"], [class*="Status"], .tag, .badge');
        for (const statusEl of statusElements) {
          const statusText = statusEl.textContent || '';
          if (!/paid/i.test(statusText)) continue;

          // Walk up to find the parent order container
          let parent = statusEl.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const parentText = parent.textContent || '';
            const orderIdMatch = parentText.match(/(\d{15,25})/);
            const usdtMatch = parentText.match(/([\d,.]+)\s*USDT/i);

            if (orderIdMatch && usdtMatch) {
              // Extract local amount from parent
              let localAmount = null;
              let localCurrency = null;
              for (const cur of currencies) {
                const amountAfter = parentText.match(new RegExp('([\\d,]+(?:\\.\\d+)?)\\s*' + cur, 'i'));
                const amountBefore = parentText.match(new RegExp(cur + '\\s*([\\d,]+(?:\\.\\d+)?)', 'i'));
                const match = amountAfter || amountBefore;
                if (match) {
                  const parsed = parseFloat(match[1].replace(/,/g, ''));
                  if (parsed > 0 && (!localAmount || parsed > localAmount)) {
                    localAmount = parsed;
                    localCurrency = cur;
                  }
                }
              }

              results.push({
                orderId: orderIdMatch[1],
                usdtAmount: parseFloat(usdtMatch[1].replace(/,/g, '')),
                localAmount,
                localCurrency,
                exchangeRate: null,
                buyerName: null,
                rawText: parentText.substring(0, 800),
              });
              break;
            }
            parent = parent.parentElement;
          }
        }
      }

      return results;
    });

    for (const order of orders) {
      if (!this.knownOrders.has(order.orderId)) {
        this.knownOrders.add(order.orderId);
        console.log(`[BinanceMonitor] New paid order detected: ${order.orderId} - ${order.usdtAmount} USDT`);
        this.emit('order_detected', order);
      }
    }
  }

  async takeScreenshot() {
    if (!this.page) return null;
    const latestPath = path.join(SCREENSHOT_DIR, 'latest.png');
    await this.page.screenshot({ path: latestPath });
    return latestPath;
  }

  async getLatestScreenshot() {
    const p = path.join(SCREENSHOT_DIR, 'latest.png');
    return fs.existsSync(p) ? p : null;
  }

  async close() {
    this.stopMonitoring();
    if (this.browser) {
      await this._saveStorage();
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    this.emit('closed');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      browserLaunched: !!this.browser,
      knownOrders: this.knownOrders.size,
      intervalMs: this.intervalMs,
    };
  }
}

module.exports = BinanceMonitor;
