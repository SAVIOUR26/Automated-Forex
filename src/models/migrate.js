const { getDb } = require('./database');

function migrate() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      binance_order_id TEXT UNIQUE NOT NULL,
      usdt_amount REAL NOT NULL,
      exchange_rate REAL NOT NULL,
      local_currency TEXT NOT NULL DEFAULT 'UGX',
      local_amount REAL NOT NULL,
      fee_percent REAL NOT NULL DEFAULT 0,
      fee_amount REAL NOT NULL DEFAULT 0,
      customer_phone TEXT,
      customer_name TEXT,
      buyer_binance_name TEXT,
      status TEXT NOT NULL DEFAULT 'detected',
      payout_status TEXT DEFAULT 'pending',
      payout_reference TEXT,
      usdt_released INTEGER DEFAULT 0,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      failure_reason TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      transaction_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id)
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      rate REAL NOT NULL,
      is_active INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_payout_status ON transactions(payout_status);
    CREATE INDEX IF NOT EXISTS idx_transactions_binance_order ON transactions(binance_order_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
  `);

  console.log('Database migrated successfully');
}

if (require.main === module) {
  migrate();
  process.exit(0);
}

module.exports = { migrate };
