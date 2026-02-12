/**
 * ModemBridge — HTTP client that talks to the Python USSD Engine.
 *
 * The engine runs on the same VPS (localhost:7001) and manages the
 * GSM modem via a serial bridge to the Windows laptop over Tailscale.
 *
 * Flow:
 *   NgaboPay (this) → POST /api/payout → Python Engine → AT+CUSD → Modem
 *   Python Engine → POST /api/payout/complete → NgaboPay (callback)
 */

const Settings = require('../models/Settings');

class ModemBridge {
  constructor(engineUrl) {
    this.engineUrl = engineUrl || 'http://127.0.0.1:7001';
  }

  /**
   * Trigger a payout via the USSD engine.
   * Returns immediately — the engine processes in the background
   * and calls back to /api/payout/complete or /api/payout/failed.
   */
  async sendPayout(transaction) {
    const provider = Settings.get('ussd_provider', 'airtel_ug');

    const resp = await fetch(`${this.engineUrl}/api/payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction_id: transaction.id,
        phone: transaction.customer_phone,
        amount: Math.round(transaction.local_amount),
        provider,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: `HTTP ${resp.status}` }));
      throw new Error(err.detail || `Engine error: HTTP ${resp.status}`);
    }

    return resp.json();
  }

  /**
   * Get modem + engine status.
   */
  async getStatus() {
    const resp = await fetch(`${this.engineUrl}/api/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Engine status error: HTTP ${resp.status}`);
    return resp.json();
  }

  /**
   * Reconnect to the modem.
   */
  async reconnect() {
    const resp = await fetch(`${this.engineUrl}/api/reconnect`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: `HTTP ${resp.status}` }));
      throw new Error(err.detail || 'Reconnect failed');
    }
    return resp.json();
  }

  /**
   * Send a raw USSD code for testing (e.g. balance check).
   */
  async testUssd(code) {
    const resp = await fetch(`${this.engineUrl}/api/test-ussd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: `HTTP ${resp.status}` }));
      throw new Error(err.detail || 'Test USSD failed');
    }
    return resp.json();
  }

  /**
   * Quick health check — is the engine reachable?
   */
  async isAvailable() {
    try {
      const resp = await fetch(`${this.engineUrl}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      return data.modem_connected === true;
    } catch {
      return false;
    }
  }
}

module.exports = ModemBridge;
