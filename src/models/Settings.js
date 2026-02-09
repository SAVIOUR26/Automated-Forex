const { getDb } = require('./database');

class Settings {
  static get(key, defaultValue = null) {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  }

  static getNumber(key, defaultValue = 0) {
    const val = this.get(key);
    return val !== null ? parseFloat(val) : defaultValue;
  }

  static getBoolean(key, defaultValue = false) {
    const val = this.get(key);
    return val !== null ? val === 'true' : defaultValue;
  }

  static set(key, value) {
    const db = getDb();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  }

  static getAll() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM settings ORDER BY key').all();
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  static getExchangeRate(currency = 'UGX') {
    return this.getNumber(`rate_${currency}`, 0);
  }

  static setExchangeRate(currency, rate) {
    this.set(`rate_${currency}`, rate);

    const db = getDb();
    db.prepare(`
      UPDATE exchange_rates SET rate = ?, updated_at = datetime('now')
      WHERE currency = ? AND is_active = 1
    `).run(rate, currency);
  }

  static getFeePercent() {
    return this.getNumber('fee_percent', 2);
  }
}

module.exports = Settings;
