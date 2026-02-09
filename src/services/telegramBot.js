const TelegramBot = require('node-telegram-bot-api');

class TelegramNotifier {
  constructor(token, chatId) {
    this.chatId = chatId;
    this.bot = null;
    this.enabled = false;

    if (token && chatId) {
      try {
        this.bot = new TelegramBot(token, { polling: false });
        this.enabled = true;
        console.log('[Telegram] Bot initialized');
      } catch (err) {
        console.error('[Telegram] Failed to initialize:', err.message);
      }
    } else {
      console.log('[Telegram] Bot disabled (no token or chat ID)');
    }
  }

  async send(message) {
    if (!this.enabled || !this.bot) return;
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[Telegram] Send error:', err.message);
    }
  }

  async notifyOrderDetected(order) {
    const msg = `🔔 <b>New Order Detected!</b>

📋 Order ID: <code>${order.binance_order_id}</code>
💰 Amount: <b>${order.usdt_amount} USDT</b>
💱 Rate: ${order.exchange_rate} ${order.local_currency}/USDT
💵 Payout: <b>${Number(order.local_amount).toLocaleString()} ${order.local_currency}</b>
👤 Buyer: ${order.buyer_binance_name || 'Unknown'}
📱 Phone: ${order.customer_phone || 'Not set'}
⏰ Time: ${new Date().toLocaleString()}`;

    await this.send(msg);
  }

  async notifyPayoutProcessing(transaction) {
    const msg = `⏳ <b>Payout Processing</b>

📋 Order: <code>${transaction.binance_order_id}</code>
💵 Sending: <b>${Number(transaction.local_amount).toLocaleString()} ${transaction.local_currency}</b>
📱 To: ${transaction.customer_phone}`;

    await this.send(msg);
  }

  async notifyPayoutSuccess(transaction) {
    const msg = `✅ <b>Payout Successful!</b>

📋 Order: <code>${transaction.binance_order_id}</code>
💵 Sent: <b>${Number(transaction.local_amount).toLocaleString()} ${transaction.local_currency}</b>
📱 To: ${transaction.customer_phone}
🔖 Ref: ${transaction.payout_reference || 'N/A'}`;

    await this.send(msg);
  }

  async notifyPayoutFailed(transaction, reason) {
    const msg = `❌ <b>Payout Failed!</b>

📋 Order: <code>${transaction.binance_order_id}</code>
💵 Amount: <b>${Number(transaction.local_amount).toLocaleString()} ${transaction.local_currency}</b>
📱 To: ${transaction.customer_phone}
❗ Reason: ${reason}

⚠️ Manual intervention required!`;

    await this.send(msg);
  }

  async notifyDailySummary(stats) {
    const msg = `📊 <b>Daily Summary</b>

📈 Today's Transactions: ${stats.today.count}
💰 USDT Volume: ${stats.today.usdt}
💵 Local Payout: ${Number(stats.today.local_total).toLocaleString()}
💎 Fees Earned: ${Number(stats.today.fees).toLocaleString()}

📊 All Time:
  Transactions: ${stats.all.count}
  USDT: ${stats.all.usdt}
  Fees: ${Number(stats.all.fees).toLocaleString()}

⏳ Pending: ${stats.pending}
✅ Completed: ${stats.completed}
❌ Failed: ${stats.failed}`;

    await this.send(msg);
  }

  async notifyMonitorStatus(status) {
    const emoji = status === 'started' ? '🟢' : '🔴';
    await this.send(`${emoji} <b>Monitor ${status}</b>\n⏰ ${new Date().toLocaleString()}`);
  }
}

module.exports = TelegramNotifier;
