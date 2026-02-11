const { getDb } = require('./database');

class Transaction {
  static create(data) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO transactions (
        binance_order_id, usdt_amount, exchange_rate, local_currency,
        local_amount, fee_percent, fee_amount, customer_phone,
        customer_name, buyer_binance_name, status, payout_status
      ) VALUES (
        @binance_order_id, @usdt_amount, @exchange_rate, @local_currency,
        @local_amount, @fee_percent, @fee_amount, @customer_phone,
        @customer_name, @buyer_binance_name, @status, @payout_status
      )
    `);

    const result = stmt.run({
      binance_order_id: data.binance_order_id,
      usdt_amount: data.usdt_amount,
      exchange_rate: data.exchange_rate,
      local_currency: data.local_currency || 'UGX',
      local_amount: data.local_amount,
      fee_percent: data.fee_percent || 0,
      fee_amount: data.fee_amount || 0,
      customer_phone: data.customer_phone || null,
      customer_name: data.customer_name || null,
      buyer_binance_name: data.buyer_binance_name || null,
      status: data.status || 'detected',
      payout_status: data.payout_status || 'pending',
    });

    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  }

  static findByOrderId(orderId) {
    const db = getDb();
    return db.prepare('SELECT * FROM transactions WHERE binance_order_id = ?').get(orderId);
  }

  static findAll({ limit = 50, offset = 0, status, payout_status } = {}) {
    const db = getDb();
    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (payout_status) {
      query += ' AND payout_status = ?';
      params.push(payout_status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params);
  }

  static getPendingPayouts() {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM transactions
      WHERE payout_status = 'pending' AND status = 'detected'
      AND customer_phone IS NOT NULL
      ORDER BY created_at ASC
    `).all();
  }

  /**
   * Atomically claim a pending payout so no other caller can grab it.
   * Returns the transaction if successfully claimed, null if already taken.
   * This prevents double-payouts when the app polls twice before the server updates.
   */
  static claimPayout(id) {
    const db = getDb();
    const result = db.prepare(`
      UPDATE transactions
      SET payout_status = 'processing', status = 'processing',
          processed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND payout_status = 'pending' AND status = 'detected'
    `).run(id);

    if (result.changes === 0) return null;
    return this.findById(id);
  }

  /**
   * Reset stuck "processing" payouts that have been processing for too long.
   * Called periodically to recover from app crashes / USSD timeouts.
   */
  static resetStuckPayouts(timeoutMinutes = 10) {
    const db = getDb();
    const result = db.prepare(`
      UPDATE transactions
      SET payout_status = 'pending', status = 'detected',
          updated_at = datetime('now'), failure_reason = 'Processing timeout - auto-reset'
      WHERE payout_status = 'processing' AND status = 'processing'
      AND processed_at < datetime('now', '-' || ? || ' minutes')
    `).run(timeoutMinutes);

    return result.changes;
  }

  static updateStatus(id, status, extra = {}) {
    const db = getDb();
    const sets = ['status = ?', 'updated_at = datetime(\'now\')'];
    const params = [status];

    if (status === 'processing') {
      sets.push('processed_at = datetime(\'now\')');
    } else if (status === 'completed') {
      sets.push('completed_at = datetime(\'now\')');
    } else if (status === 'failed') {
      sets.push('failed_at = datetime(\'now\')');
      if (extra.failure_reason) {
        sets.push('failure_reason = ?');
        params.push(extra.failure_reason);
      }
    }

    if (extra.payout_status) {
      sets.push('payout_status = ?');
      params.push(extra.payout_status);
    }
    if (extra.payout_reference) {
      sets.push('payout_reference = ?');
      params.push(extra.payout_reference);
    }
    if (extra.customer_phone) {
      sets.push('customer_phone = ?');
      params.push(extra.customer_phone);
    }
    if (extra.usdt_released !== undefined) {
      sets.push('usdt_released = ?');
      params.push(extra.usdt_released ? 1 : 0);
    }

    params.push(id);
    db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.findById(id);
  }

  static updatePayoutStatus(id, payout_status, extra = {}) {
    const db = getDb();
    const sets = ['payout_status = ?', 'updated_at = datetime(\'now\')'];
    const params = [payout_status];

    if (extra.payout_reference) {
      sets.push('payout_reference = ?');
      params.push(extra.payout_reference);
    }

    params.push(id);
    db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.findById(id);
  }

  static getStats() {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const totalToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(usdt_amount), 0) as usdt,
             COALESCE(SUM(local_amount), 0) as local_total,
             COALESCE(SUM(fee_amount), 0) as fees
      FROM transactions WHERE date(created_at) = ?
    `).get(today);

    const totalAll = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(usdt_amount), 0) as usdt,
             COALESCE(SUM(local_amount), 0) as local_total,
             COALESCE(SUM(fee_amount), 0) as fees
      FROM transactions
    `).get();

    const pending = db.prepare(`
      SELECT COUNT(*) as count FROM transactions WHERE payout_status = 'pending'
    `).get();

    const completed = db.prepare(`
      SELECT COUNT(*) as count FROM transactions WHERE status = 'completed'
    `).get();

    const failed = db.prepare(`
      SELECT COUNT(*) as count FROM transactions WHERE status = 'failed'
    `).get();

    return { today: totalToday, all: totalAll, pending: pending.count, completed: completed.count, failed: failed.count };
  }

  static getRecentActivity(limit = 20) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }
}

module.exports = Transaction;
