const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const ActivityLog = require('../models/ActivityLog');

class ExchangeEngine {
  constructor(telegramNotifier) {
    this.telegram = telegramNotifier;
  }

  /**
   * Process a newly detected Binance P2P order.
   * Uses the local currency amount directly from the Binance order page.
   * No manual rate calculation — Binance already shows the exact fiat amount.
   */
  async processDetectedOrder(order) {
    // Check if already processed
    const existing = Transaction.findByOrderId(order.orderId);
    if (existing) {
      console.log(`[ExchangeEngine] Order ${order.orderId} already exists, skipping`);
      return existing;
    }

    const usdtAmount = order.usdtAmount;

    // Use the local amount directly from Binance (no manual rate needed)
    // Binance P2P order shows exactly how much fiat the buyer is paying
    const localAmount = order.localAmount || 0;
    const localCurrency = order.localCurrency || Settings.get('default_currency', 'UGX');
    const exchangeRate = order.exchangeRate || (localAmount > 0 && usdtAmount > 0 ? Math.round(localAmount / usdtAmount) : 0);

    if (!localAmount || localAmount <= 0) {
      console.warn(`[ExchangeEngine] Order ${order.orderId}: No local amount detected from Binance, storing with 0`);
    }

    const transaction = Transaction.create({
      binance_order_id: order.orderId,
      usdt_amount: usdtAmount,
      exchange_rate: exchangeRate,
      local_currency: localCurrency,
      local_amount: Math.round(localAmount),
      fee_percent: 0,
      fee_amount: 0,
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
      localCurrency,
      exchangeRate,
      source: 'binance_p2p',
    }, transaction.id);

    console.log(`[ExchangeEngine] New transaction: #${transaction.id} - ${usdtAmount} USDT = ${Math.round(localAmount)} ${localCurrency}`);

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
    const existing = Transaction.findById(transactionId);
    const transaction = Transaction.updateStatus(transactionId, existing?.status || 'completed', {
      usdt_released: true,
    });
    ActivityLog.log('usdt_released', null, transactionId);
    return transaction;
  }
}

module.exports = ExchangeEngine;
