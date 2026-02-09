const { getDb } = require('./database');

class ActivityLog {
  static log(action, details = null, transactionId = null) {
    const db = getDb();
    db.prepare(`
      INSERT INTO activity_log (action, details, transaction_id)
      VALUES (?, ?, ?)
    `).run(action, details ? JSON.stringify(details) : null, transactionId);
  }

  static getRecent(limit = 50) {
    const db = getDb();
    return db.prepare(`
      SELECT al.*, t.binance_order_id, t.usdt_amount
      FROM activity_log al
      LEFT JOIN transactions t ON al.transaction_id = t.id
      ORDER BY al.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  static getByTransaction(transactionId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM activity_log WHERE transaction_id = ? ORDER BY created_at ASC
    `).all(transactionId);
  }
}

module.exports = ActivityLog;
