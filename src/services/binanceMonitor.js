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
    this.binanceUrl = options.binanceUrl || 'https://www.binance.com/en/my/orders/p2p';
    this.sessionHealthy = true;
    this.lastSuccessfulPoll = null;

    // API interception state
    this._interceptedOrders = [];
    this._apiInterceptorSetup = false;

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

    // Install API interceptor before navigating so we capture responses
    await this._setupApiInterception();

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
      await this._checkForOrders();
      this.lastSuccessfulPoll = Date.now();
    } catch (err) {
      console.error('[BinanceMonitor] Poll error:', err.message);
      this.emit('error', err);
    }

    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this._poll(), this.intervalMs);
    }
  }

  // ─── API Response Interception ─────────────────────────────
  // Captures Binance's internal C2C API responses to get structured order JSON.
  // Far more reliable than DOM scraping since Binance uses hashed class names.

  async _setupApiInterception() {
    if (this._apiInterceptorSetup || !this.page) return;
    this._apiInterceptorSetup = true;

    this.page.on('response', async (response) => {
      try {
        const url = response.url();

        // Match Binance C2C / P2P order-related API endpoints
        const isC2cOrder = url.includes('c2c') && url.includes('order');
        const isP2pOrder = url.includes('p2p') && url.includes('order');
        if (!isC2cOrder && !isP2pOrder) return;
        if (response.status() !== 200) return;

        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;

        const body = await response.json().catch(() => null);
        if (!body) return;

        // Binance wraps order data in various response structures
        let orders = [];
        if (Array.isArray(body.data)) {
          orders = body.data;
        } else if (body.data && Array.isArray(body.data.orderList)) {
          orders = body.data.orderList;
        } else if (body.data && Array.isArray(body.data.list)) {
          orders = body.data.list;
        }

        if (orders.length > 0) {
          console.log(`[BinanceMonitor] API intercepted ${orders.length} order(s) from: ${url.split('?')[0]}`);
          this._interceptedOrders.push(...orders);
        }
      } catch (err) {
        // Silently ignore interception errors — page may be navigating
      }
    });

    console.log('[BinanceMonitor] API response interceptor installed');
  }

  // ─── Main Order Detection ──────────────────────────────────

  async _checkForOrders() {
    if (!this.page) return;

    // Ensure interceptor is installed
    await this._setupApiInterception();

    // Clear the interception buffer before reload
    this._interceptedOrders = [];

    // Reload the page — this triggers fresh Binance API calls
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Wait for API responses to arrive and be processed
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(2000);

    // Take screenshot for dashboard
    const screenshotPath = path.join(SCREENSHOT_DIR, 'latest.png');
    await this.page.screenshot({ path: screenshotPath }).catch(() => {});

    // Check if session expired (redirected to login page)
    const currentUrl = this.page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/account/login')) {
      console.warn('[BinanceMonitor] Session expired! Redirected to login page.');
      this.sessionHealthy = false;
      this.emit('session_expired', { url: currentUrl });
      return;
    }

    this.sessionHealthy = true;

    // ── Method 1: Parse API-intercepted order data (most reliable) ──
    let orders = [];
    if (this._interceptedOrders.length > 0) {
      orders = this._parseApiOrders(this._interceptedOrders);
      console.log(`[BinanceMonitor] Parsed ${orders.length} order(s) from API interception`);
    }

    // ── Method 2: Fallback to DOM text scraping ──
    if (orders.length === 0) {
      console.log('[BinanceMonitor] No API data intercepted, trying DOM scraping...');
      orders = await this._scrapeOrdersFromDOM();
      if (orders.length > 0) {
        console.log(`[BinanceMonitor] Scraped ${orders.length} order(s) from DOM`);
      } else {
        // Debug: log page info to help diagnose
        const debugInfo = await this.page.evaluate(() => {
          const text = document.body.innerText || '';
          return { textLength: text.length, preview: text.substring(0, 300) };
        }).catch(() => ({ textLength: 0, preview: '' }));
        console.log(`[BinanceMonitor] No orders found. URL: ${currentUrl} | Page text length: ${debugInfo.textLength}`);
        console.log(`[BinanceMonitor] Page preview: ${debugInfo.preview.replace(/\n/g, ' ').substring(0, 200)}`);
      }
    }

    // Emit events for newly discovered orders
    for (const order of orders) {
      if (!this.knownOrders.has(order.orderId)) {
        this.knownOrders.add(order.orderId);
        console.log(`[BinanceMonitor] NEW ORDER: ${order.orderId} | ${order.tradeType} ${order.usdtAmount} USDT = ${order.localAmount} ${order.localCurrency} | Status: ${order.orderStatusText || 'detected'}`);
        this.emit('order_detected', order);
      }
    }
  }

  // ─── Parse Structured API Responses ────────────────────────

  _parseApiOrders(apiOrders) {
    const results = [];
    const seen = new Set();

    for (const o of apiOrders) {
      const orderId = String(o.orderNumber || o.advNo || o.orderNo || o.id || '');
      if (!orderId || seen.has(orderId)) continue;
      seen.add(orderId);

      const usdtAmount = parseFloat(o.amount) || parseFloat(o.quantity) || parseFloat(o.totalAmount) || 0;
      if (usdtAmount <= 0) continue;

      // Try to extract phone number from payment methods or buyer info
      let customerPhone = null;
      if (o.payMethods && Array.isArray(o.payMethods)) {
        for (const pm of o.payMethods) {
          const fields = pm.fields || pm.tradeMethodFieldVos || [];
          for (const f of fields) {
            const fn = (f.fieldName || f.name || '').toLowerCase();
            const fv = f.fieldValue || f.value || '';
            if ((fn.includes('phone') || fn.includes('mobile') || fn.includes('number') || fn.includes('account')) && /^\+?\d[\d\s-]{7,}$/.test(fv.trim())) {
              customerPhone = fv.trim();
              break;
            }
          }
          if (customerPhone) break;
          // Also check the identifier field directly
          const ident = pm.identifier || pm.tradeMethodIdentifier || '';
          if (/^\+?\d[\d\s-]{7,}$/.test(ident.trim())) {
            customerPhone = ident.trim();
          }
        }
      }
      // Also check direct phone fields
      if (!customerPhone) {
        customerPhone = o.buyerPhone || o.sellerPhone || o.phone || o.mobile || null;
      }

      results.push({
        orderId,
        tradeType: o.tradeType || 'UNKNOWN',
        usdtAmount,
        localAmount: parseFloat(o.totalPrice) || parseFloat(o.orderAmount) || 0,
        localCurrency: o.fiatUnit || o.fiat || null,
        exchangeRate: parseFloat(o.unitPrice) || parseFloat(o.price) || 0,
        buyerName: o.buyerNickName || o.oppositeNickName || o.sellerNickName || null,
        customerName: o.buyerNickName || o.oppositeNickName || o.sellerNickName || null,
        customerPhone,
        orderStatusText: this._mapOrderStatus(o.orderStatus || o.tradeStatus),
        rawText: JSON.stringify(o).substring(0, 800),
      });
    }

    return results;
  }

  _mapOrderStatus(status) {
    const statusMap = {
      '1': 'unpaid',
      '2': 'buyer_paid',
      '3': 'completed',
      '4': 'cancelled',
      '5': 'disputed',
    };
    return statusMap[String(status)] || String(status || 'unknown');
  }

  // ─── Fallback: DOM Text Scraping ───────────────────────────
  // Used when API interception doesn't capture data (e.g. WebSocket updates).
  // Extracts order info from the visible page text by finding order number
  // patterns and parsing surrounding context.

  async _scrapeOrdersFromDOM() {
    return this.page.evaluate(() => {
      const currencies = ['UGX', 'KES', 'TZS', 'NGN', 'GHS', 'ZAR', 'RWF', 'USD', 'EUR'];
      const bodyText = document.body.innerText || '';
      const results = [];
      const seen = new Set();

      // Find all Binance order number positions (typically 17-22 digits)
      const regex = /\b(\d{17,22})\b/g;
      let match;
      const positions = [];
      while ((match = regex.exec(bodyText)) !== null) {
        if (!seen.has(match[1])) {
          seen.add(match[1]);
          positions.push({ orderId: match[1], index: match.index });
        }
      }

      for (let i = 0; i < positions.length; i++) {
        const { orderId, index } = positions[i];

        // Extract context: 500 chars before and until next order (or 1000 after)
        const start = Math.max(0, index - 500);
        const end = positions[i + 1]
          ? positions[i + 1].index
          : Math.min(bodyText.length, index + 1000);
        const context = bodyText.substring(start, end);

        // Extract USDT amount
        const usdtMatch = context.match(/([\d,.]+)\s*USDT/i);
        const usdtAmount = usdtMatch ? parseFloat(usdtMatch[1].replace(/,/g, '')) : 0;
        if (usdtAmount <= 0) continue;

        // Determine trade type
        const tradeType = /sell/i.test(context) ? 'SELL' : /buy/i.test(context) ? 'BUY' : 'UNKNOWN';

        // Extract local currency amount
        let localAmount = 0;
        let localCurrency = null;
        for (const cur of currencies) {
          const m = context.match(new RegExp('([\\d,]+(?:\\.\\d+)?)\\s*' + cur, 'i'))
                 || context.match(new RegExp(cur + '\\s*([\\d,]+(?:\\.\\d+)?)', 'i'));
          if (m) {
            const val = parseFloat(m[1].replace(/,/g, ''));
            if (val > 0 && val > localAmount) {
              localAmount = val;
              localCurrency = cur;
            }
          }
        }

        // Extract exchange rate
        let exchangeRate = 0;
        const priceMatch = context.match(/price[:\s]*([\d,]+(?:\.\d+)?)/i);
        if (priceMatch) {
          exchangeRate = parseFloat(priceMatch[1].replace(/,/g, ''));
        } else if (localAmount > 0 && usdtAmount > 0) {
          exchangeRate = Math.round(localAmount / usdtAmount);
        }

        results.push({
          orderId,
          tradeType,
          usdtAmount,
          localAmount,
          localCurrency,
          exchangeRate,
          buyerName: null,
          customerName: null,
          orderStatusText: 'detected',
          rawText: context.substring(0, 800),
        });
      }

      return results;
    });
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
