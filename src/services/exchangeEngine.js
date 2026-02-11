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
   * Handles different Binance statuses:
   *   - buyer_paid → detected/pending (actionable - needs payout)
   *   - completed  → auto-mark as completed (already handled)
   *   - cancelled/disputed/unpaid → store but don't act
   */
  async processDetectedOrder(order) {
    // Check if already processed
    const existing = Transaction.findByOrderId(order.orderId);
    if (existing) {
      // Update binance_status if it changed
      const binanceStatus = order.binanceStatus || 'unknown';
      if (binanceStatus !== existing.binance_status) {
        return this.handleBinanceStatusChange(order);
      }
      console.log(`[ExchangeEngine] Order ${order.orderId} already exists, skipping`);
      return existing;
    }

    const usdtAmount = order.usdtAmount;

    // Use the local amount directly from Binance (no manual rate needed)
    const localAmount = order.localAmount || 0;
    const localCurrency = order.localCurrency || Settings.get('default_currency', 'UGX');
    const exchangeRate = order.exchangeRate || (localAmount > 0 && usdtAmount > 0 ? Math.round(localAmount / usdtAmount) : 0);

    if (!localAmount || localAmount <= 0) {
      console.warn(`[ExchangeEngine] Order ${order.orderId}: No local amount detected from Binance, storing with 0`);
    }

    // Determine our internal status based on Binance status
    const binanceStatus = order.binanceStatus || 'unknown';
    let status = 'detected';
    let payoutStatus = 'pending';

    if (binanceStatus === 'completed') {
      // Binance says already completed — auto-mark completed
      status = 'completed';
      payoutStatus = 'completed';
    } else if (binanceStatus === 'cancelled') {
      status = 'failed';
      payoutStatus = 'pending';
    }
    // buyer_paid, unpaid, disputed, unknown → detected/pending (default)

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
      status,
      payout_status: payoutStatus,
      binance_status: binanceStatus,
    });

    ActivityLog.log('order_detected', {
      orderId: order.orderId,
      usdtAmount,
      localAmount: Math.round(localAmount),
      localCurrency,
      exchangeRate,
      binanceStatus,
      customerPhone: order.customerPhone || null,
      customerName: order.customerName || null,
      source: 'binance_p2p',
    }, transaction.id);

    console.log(`[ExchangeEngine] New transaction: #${transaction.id} - ${usdtAmount} USDT = ${Math.round(localAmount)} ${localCurrency} | Binance: ${binanceStatus} | Phone: ${order.customerPhone || 'N/A'}`);

    // Send Telegram notification (only for actionable orders)
    if (this.telegram && binanceStatus === 'buyer_paid') {
      await this.telegram.notifyOrderDetected(transaction);
    }

    return transaction;
  }

  /**
   * Handle Binance status change for an existing order.
   * Called when the monitor detects a status change on a known order.
   * Key flow: buyer_paid → completed means Binance auto-completed after USDT release.
   */
  async handleBinanceStatusChange(order) {
    const existing = Transaction.findByOrderId(order.orderId);
    if (!existing) return null;

    const newBinanceStatus = order.binanceStatus || 'unknown';
    const oldBinanceStatus = existing.binance_status;

    // Update the binance_status field
    Transaction.updateBinanceStatus(existing.id, newBinanceStatus);

    ActivityLog.log('binance_status_changed', {
      from: oldBinanceStatus,
      to: newBinanceStatus,
      orderId: order.orderId,
    }, existing.id);

    console.log(`[ExchangeEngine] Binance status change: #${existing.id} ${oldBinanceStatus} → ${newBinanceStatus}`);

    // If Binance says completed and we haven't completed it yet, auto-complete
    if (newBinanceStatus === 'completed' && existing.status === 'detected' && existing.payout_status === 'pending') {
      console.log(`[ExchangeEngine] Auto-completing order #${existing.id} (Binance marked as completed)`);
      return this.markPayoutComplete(existing.id, 'binance_auto_completed');
    }

    // If Binance says cancelled and we haven't acted yet
    if (newBinanceStatus === 'cancelled' && existing.status === 'detected') {
      console.log(`[ExchangeEngine] Auto-failing order #${existing.id} (Binance cancelled)`);
      return this.markPayoutFailed(existing.id, 'Order cancelled on Binance');
    }

    return Transaction.findById(existing.id);
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
   * Set customer phone and name for a transaction (if not detected from Binance)
   */
  setCustomerPhone(transactionId, phone, customerName) {
    const extra = { customer_phone: phone };
    if (customerName) extra.customer_name = customerName;
    const transaction = Transaction.updateStatus(transactionId, 'detected', extra);
    ActivityLog.log('phone_set', { phone, customer_name: customerName || null }, transactionId);
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
