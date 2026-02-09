const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const ActivityLog = require('../models/ActivityLog');

class ExchangeEngine {
  constructor(telegramNotifier) {
    this.telegram = telegramNotifier;
  }

  /**
   * Process a newly detected Binance P2P order.
   * Calculates local currency amount, fees, and creates a transaction.
   */
  async processDetectedOrder(order) {
    // Check if already processed
    const existing = Transaction.findByOrderId(order.orderId);
    if (existing) {
      console.log(`[ExchangeEngine] Order ${order.orderId} already exists, skipping`);
      return existing;
    }

    const currency = Settings.get('default_currency', 'UGX');
    const rate = Settings.getExchangeRate(currency);
    const feePercent = Settings.getFeePercent();

    if (!rate || rate <= 0) {
      console.error(`[ExchangeEngine] No exchange rate configured for ${currency}`);
      return null;
    }

    const usdtAmount = order.usdtAmount;
    const grossLocal = usdtAmount * rate;
    const feeAmount = grossLocal * (feePercent / 100);
    const localAmount = grossLocal - feeAmount;

    const transaction = Transaction.create({
      binance_order_id: order.orderId,
      usdt_amount: usdtAmount,
      exchange_rate: rate,
      local_currency: currency,
      local_amount: Math.round(localAmount),
      fee_percent: feePercent,
      fee_amount: Math.round(feeAmount),
      customer_phone: order.customerPhone || null,
      customer_name: order.customerName || null,
      buyer_binance_name: order.buyerName || null,
      status: 'detected',
      payout_status: 'pending',
    });

    ActivityLog.log('order_detected', {
      orderId: order.orderId,
      usdtAmount,
      localAmount: Math.round(localAmount),
      currency,
      rate,
    }, transaction.id);

    console.log(`[ExchangeEngine] New transaction created: #${transaction.id} - ${usdtAmount} USDT → ${Math.round(localAmount)} ${currency}`);

    // Send Telegram notification
    if (this.telegram) {
      await this.telegram.notifyOrderDetected(transaction);
    }

    return transaction;
  }

  /**
   * Mark a transaction as processing (payout being sent)
   */
  async markProcessing(transactionId) {
    const transaction = Transaction.updateStatus(transactionId, 'processing', {
      payout_status: 'processing',
    });

    ActivityLog.log('payout_processing', null, transactionId);

    if (this.telegram) {
      await this.telegram.notifyPayoutProcessing(transaction);
    }

    return transaction;
  }

  /**
   * Mark a payout as completed
   */
  async markPayoutComplete(transactionId, reference) {
    const transaction = Transaction.updateStatus(transactionId, 'completed', {
      payout_status: 'completed',
      payout_reference: reference,
    });

    ActivityLog.log('payout_completed', { reference }, transactionId);

    if (this.telegram) {
      await this.telegram.notifyPayoutSuccess(transaction);
    }

    return transaction;
  }

  /**
   * Mark a payout as failed
   */
  async markPayoutFailed(transactionId, reason) {
    const transaction = Transaction.updateStatus(transactionId, 'failed', {
      payout_status: 'failed',
      failure_reason: reason,
    });

    ActivityLog.log('payout_failed', { reason }, transactionId);

    if (this.telegram) {
      await this.telegram.notifyPayoutFailed(transaction, reason);
    }

    return transaction;
  }

  /**
   * Set customer phone for a transaction (if not detected from Binance)
   */
  setCustomerPhone(transactionId, phone) {
    const transaction = Transaction.updateStatus(transactionId, 'detected', {
      customer_phone: phone,
    });
    ActivityLog.log('phone_set', { phone }, transactionId);
    return transaction;
  }

  /**
   * Mark USDT as released on Binance
   */
  markUsdtReleased(transactionId) {
    const transaction = Transaction.updateStatus(transactionId, transaction?.status || 'completed', {
      usdt_released: true,
    });
    ActivityLog.log('usdt_released', null, transactionId);
    return transaction;
  }
}

module.exports = ExchangeEngine;
