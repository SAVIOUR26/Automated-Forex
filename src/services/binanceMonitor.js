const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const BROWSER_DATA_DIR = path.join(__dirname, '..', '..', 'browser-data');
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'data', 'screenshots');

// Current Chrome user agent — keep updated to avoid detection
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class BinanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.intervalMs = options.intervalMs || 10000;
    this.pollTimer = null;
    this.activityTimer = null;
    this.healthTimer = null;
    this.knownOrders = new Set();
    this.binanceUrl = options.binanceUrl || 'https://p2p.binance.com/en/myOrder?type=1';
    this.sessionHealthy = true;
    this.lastSuccessfulPoll = null;

    for (const dir of [BROWSER_DATA_DIR, SCREENSHOT_DIR]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Launch browser using launchPersistentContext — saves EVERYTHING to disk:
   * cookies, sessionStorage, IndexedDB, cache, service workers.
   * The Binance session survives server restarts completely.
   */
  async launch() {
    if (this.browser) return;

    this.context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      userAgent: CHROME_USER_AGENT,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
      ],
      bypassCSP: false,
      locale: 'en-US',
      timezoneId: 'Africa/Kampala',
    });

    // launchPersistentContext returns a BrowserContext, not a Browser
    this.browser = this.context;

    // Apply stealth scripts to every page — hides automation signals
    await this.context.addInitScript(() => {
      // Hide navigator.webdriver flag (Binance checks this)
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Provide realistic plugins array
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Realistic languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override chrome runtime to look like real Chrome
      window.chrome = { runtime: {} };

      // Realistic permissions query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    // Get existing page or create new one
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

    this.emit('launched');
    console.log('[BinanceMonitor] Browser launched with persistent context + stealth');
  }

  async navigateToBinance() {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.goto(this.binanceUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
      return this.page.goto(this.binanceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    this.emit('navigated');
    console.log('[BinanceMonitor] Navigated to Binance P2P orders');
  }

  async startMonitoring() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.sessionHealthy = true;
    this.lastSuccessfulPoll = Date.now();
    this.emit('monitoring_started');
    console.log(`[BinanceMonitor] Monitoring started (interval: ${this.intervalMs}ms)`);

    this._poll();
    this._startHumanSimulation();
    this._startSessionHealthCheck();
  }

  async stopMonitoring() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.emit('monitoring_stopped');
    console.log('[BinanceMonitor] Monitoring stopped');
  }

  // ─── Human Activity Simulation ───────────────────────────
  // Prevents Binance inactivity timeout by mimicking real user behavior.
  // Runs every 2-4 minutes with randomized mouse movements and scrolls.

  _startHumanSimulation() {
    if (this.activityTimer) clearTimeout(this.activityTimer);

    const simulate = async () => {
      if (!this.isRunning || !this.page) return;
      try {
        // Random mouse movement with natural curve
        const x = 200 + Math.floor(Math.random() * 800);
        const y = 150 + Math.floor(Math.random() * 500);
        await this.page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });

        // Random scroll (up or down)
        const scrollY = Math.floor(Math.random() * 400) - 200;
        await this.page.mouse.wheel(0, scrollY);

        // Occasionally move mouse to a second random spot
        if (Math.random() < 0.3) {
          const x2 = 100 + Math.floor(Math.random() * 1000);
          const y2 = 100 + Math.floor(Math.random() * 600);
          await this.page.mouse.move(x2, y2, { steps: 8 + Math.floor(Math.random() * 12) });
        }
      } catch (err) {
        // Ignore simulation errors — page might be navigating
      }
    };

    // Run every 2-4 minutes (randomized to avoid pattern detection)
    const scheduleNext = () => {
      if (!this.isRunning) return;
      const delay = (120 + Math.floor(Math.random() * 120)) * 1000;
      this.activityTimer = setTimeout(() => {
        simulate();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  // ─── Proactive Session Health Monitoring ──────────────────
  // Checks cookie expiry BEFORE the session dies so we can alert early.

  _startSessionHealthCheck() {
    if (this.healthTimer) clearInterval(this.healthTimer);

    this.healthTimer = setInterval(async () => {
      if (!this.isRunning || !this.context || !this.page) return;

      try {
        // Check cookies for approaching expiry
        const cookies = await this.context.cookies('https://www.binance.com');
        const now = Math.floor(Date.now() / 1000);
        let soonestExpiry = Infinity;

        for (const cookie of cookies) {
          if (cookie.expires > 0 && cookie.expires < soonestExpiry) {
            soonestExpiry = cookie.expires;
          }
        }

        const minutesUntilExpiry = (soonestExpiry - now) / 60;
        if (minutesUntilExpiry < 30 && minutesUntilExpiry > 0) {
          console.warn(`[BinanceMonitor] Session cookie expires in ${Math.round(minutesUntilExpiry)} minutes`);
          this.emit('session_expiring', { minutesLeft: Math.round(minutesUntilExpiry) });
        }

        // Check if we haven't had a successful poll in 5 minutes
        if (this.lastSuccessfulPoll && (Date.now() - this.lastSuccessfulPoll) > 5 * 60 * 1000) {
          console.warn('[BinanceMonitor] No successful poll in 5 minutes');
          this.emit('monitor_stale', { lastPoll: this.lastSuccessfulPoll });
        }
      } catch (err) {
        // Ignore health check errors
      }
    }, 60 * 1000); // Check every minute
  }

  async _poll() {
    if (!this.isRunning) return;

    try {
      await this._checkForPaidOrders();
      this.lastSuccessfulPoll = Date.now();
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

    // Detect if Binance session has expired (redirected to login page)
    const currentUrl = this.page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/account/login')) {
      console.warn('[BinanceMonitor] Session expired! Binance redirected to login page.');
      this.sessionHealthy = false;
      this.emit('session_expired', { url: currentUrl });
      return;
    }

    this.sessionHealthy = true;

    // Look for "Buyer Paid" / "Paid" status indicators
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
        let localAmount = null;
        let localCurrency = null;
        for (const cur of currencies) {
          const amountAfter = text.match(new RegExp('([\\d,]+(?:\\.\\d+)?)\\s*' + cur, 'i'));
          const amountBefore = text.match(new RegExp(cur + '\\s*([\\d,]+(?:\\.\\d+)?)', 'i'));
          const match = amountAfter || amountBefore;
          if (match) {
            const parsed = parseFloat(match[1].replace(/,/g, ''));
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
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.browser = null;
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
      sessionHealthy: this.sessionHealthy,
      lastSuccessfulPoll: this.lastSuccessfulPoll,
    };
  }
}

module.exports = BinanceMonitor;
