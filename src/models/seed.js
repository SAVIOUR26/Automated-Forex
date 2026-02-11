const { getDb } = require('./database');
const { migrate } = require('./migrate');

function seed() {
  migrate();
  const db = getDb();

  // Default settings
  const defaultSettings = [
    ['rate_UGX', '3750'],
    ['rate_KES', '152'],
    ['rate_TZS', '2530'],
    ['fee_percent', '2'],
    ['monitor_active', 'false'],
    ['monitor_interval_ms', '10000'],
    ['auto_release_usdt', 'false'],
    ['telegram_enabled', 'true'],
    ['default_currency', 'UGX'],
  ];

  // Only insert if key doesn't exist — never overwrite dealer's custom values
  const insertIfMissing = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO NOTHING
  `);

  const insertRate = db.prepare(`
    INSERT INTO exchange_rates (currency, rate, is_active, updated_at)
    VALUES (?, ?, 1, datetime('now'))
  `);

  const transaction = db.transaction(() => {
    for (const [key, value] of defaultSettings) {
      insertIfMissing.run(key, value);
    }

    // Seed exchange rates if empty
    const count = db.prepare('SELECT COUNT(*) as c FROM exchange_rates').get();
    if (count.c === 0) {
      insertRate.run('UGX', 3750);
      insertRate.run('KES', 152);
      insertRate.run('TZS', 2530);
    }
  });

  transaction();
  console.log('Database seeded successfully');
}

if (require.main === module) {
  seed();
  process.exit(0);
}

module.exports = { seed };
