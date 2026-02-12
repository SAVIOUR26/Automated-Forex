// ─── NgaboPay Dashboard JavaScript ────────────────────────

const API = '/api';

// ─── WebSocket Connection ─────────────────────────────────

let ws;
let wsReconnectTimer;

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(wsReconnectTimer);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected, reconnecting...');
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'new_transaction':
      showToast(`New order detected: ${msg.data.usdt_amount} USDT (${msg.data.binance_status || 'detected'})`, 'success');
      loadDashboardStats();
      loadRecentTransactions();
      break;
    case 'transaction_updated':
      showToast(`Order updated: ${msg.data.binance_order_id?.substring(0, 10)}... → ${msg.data.status}`, 'success');
      loadDashboardStats();
      loadRecentTransactions();
      break;
    case 'monitor_status':
      updateMonitorUI(msg.data);
      break;
    case 'monitor_error':
      showToast(`Monitor error: ${msg.data.message}`, 'error');
      break;
    case 'monitor_warning':
      showToast(msg.data.message, 'warning');
      break;
  }
}

// ─── API Helpers ──────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(API + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (res.status === 401) {
    window.location.href = '/login';
    return null;
  }
  return res.json();
}

// ─── Navigation ───────────────────────────────────────────

const sections = {
  dashboard: 'Dashboard',
  transactions: 'Transactions',
  browser: 'Binance Browser',
  settings: 'Settings',
  activity: 'Activity Log',
};

document.querySelectorAll('.nav-item[data-section]').forEach(item => {
  item.addEventListener('click', () => {
    const section = item.dataset.section;
    showSection(section);
  });
});

function showSection(name) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-section="${name}"]`)?.classList.add('active');

  // Show section
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(`sec-${name}`)?.classList.add('active');

  // Update title
  document.getElementById('pageTitle').textContent = sections[name] || name;

  // Load data for section
  switch (name) {
    case 'dashboard': loadDashboardStats(); loadRecentTransactions(); break;
    case 'transactions': loadTransactions(); break;
    case 'browser': refreshScreenshot(); break;
    case 'settings': loadSettings(); break;
    case 'activity': loadActivity(); break;
  }

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
}

// ─── Dashboard Stats ──────────────────────────────────────

async function loadDashboardStats() {
  const stats = await apiFetch('/stats');
  if (!stats) return;

  document.getElementById('statTodayCount').textContent = stats.today.count;
  document.getElementById('statTodayUsdt').textContent = `${stats.today.usdt} USDT`;
  document.getElementById('statTodayLocal').textContent = Number(stats.today.local_total).toLocaleString();
  document.getElementById('statPending').textContent = stats.pending;
  document.getElementById('statCompletedToday').textContent = stats.today.completed || 0;

  updateMonitorUI(stats.monitor);
}

// ─── Transactions ─────────────────────────────────────────

async function loadRecentTransactions() {
  const data = await apiFetch('/transactions?limit=10');
  if (!data) return;
  renderTransactions(data, 'recentTransactionsBody');
}

async function loadTransactions() {
  const status = document.getElementById('filterStatus').value;
  let url = '/transactions?limit=100';
  if (status) url += `&status=${status}`;

  const data = await apiFetch(url);
  if (!data) return;
  renderTransactions(data, 'transactionsBody', true);
}

function binanceStatusLabel(status) {
  const labels = {
    buyer_paid: 'Buyer Paid',
    completed: 'Completed',
    cancelled: 'Cancelled',
    disputed: 'Disputed',
    unpaid: 'Unpaid',
    unknown: 'Unknown',
  };
  return labels[status] || status || 'Unknown';
}

function renderTransactions(transactions, bodyId, showAll = false) {
  const body = document.getElementById(bodyId);

  if (!transactions.length) {
    body.innerHTML = `<tr><td colspan="${showAll ? 14 : 11}" style="text-align:center;color:#999;">No transactions found</td></tr>`;
    return;
  }

  body.innerHTML = transactions.map(tx => `
    <tr>
      ${showAll ? `<td>${tx.id}</td>` : ''}
      <td><code style="font-size:11px;">${tx.binance_order_id.substring(0, 12)}...</code></td>
      <td><strong>${tx.usdt_amount}</strong></td>
      <td>${Number(tx.exchange_rate).toLocaleString()}</td>
      <td><strong>${Number(tx.local_amount).toLocaleString()}</strong></td>
      ${showAll ? `<td>${tx.local_currency}</td>` : ''}
      <td style="font-size:12px;">${tx.customer_name || tx.buyer_binance_name || '-'}</td>
      <td>${tx.customer_phone
        ? `<span style="font-size:12px;">${tx.customer_phone}</span>`
        : `<button class="btn btn-sm btn-outline" onclick="openPhoneModal(${tx.id}, '${(tx.customer_name || '').replace(/'/g, "\\'")}')">Set</button>`}</td>
      ${showAll ? `<td>${tx.buyer_binance_name || '-'}</td>` : ''}
      <td><span class="badge badge-binance-${tx.binance_status || 'unknown'}">${binanceStatusLabel(tx.binance_status)}</span></td>
      <td><span class="badge badge-${tx.status}">${tx.status}</span></td>
      <td><span class="badge badge-${tx.payout_status}">${tx.payout_status}</span></td>
      <td style="font-size:11px;">${formatTime(tx.created_at)}</td>
      <td>
        <div style="display:flex;gap:4px;">
          ${tx.status === 'detected' && tx.payout_status === 'pending' && tx.customer_phone
            ? `<button class="btn btn-sm btn-primary" onclick="sendViaModem(${tx.id})" title="Send via USSD engine"><i class="bi bi-modem"></i></button>
               <button class="btn btn-sm btn-success" onclick="markProcessing(${tx.id})" title="Send to phone app"><i class="bi bi-phone"></i></button>`
            : ''}
          ${tx.status === 'detected' && tx.payout_status === 'pending'
            ? `<button class="btn btn-sm btn-warning" onclick="confirmManualPaid(${tx.id})" title="Confirm paid manually"><i class="bi bi-check2-circle"></i></button>`
            : ''}
          ${tx.status === 'processing' ? `<button class="btn btn-sm btn-success" onclick="markComplete(${tx.id})" title="Complete"><i class="bi bi-check"></i></button>` : ''}
          ${!tx.usdt_released && tx.status === 'completed' ? `<button class="btn btn-sm btn-warning" onclick="releaseUsdt(${tx.id})" title="Release USDT"><i class="bi bi-unlock"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

// ─── Transaction Actions ──────────────────────────────────

async function createTransaction() {
  const data = {
    binance_order_id: document.getElementById('txOrderId').value,
    usdt_amount: document.getElementById('txUsdtAmount').value,
    customer_phone: document.getElementById('txPhone').value || undefined,
    customer_name: document.getElementById('txName').value || undefined,
    local_currency: document.getElementById('txCurrency').value,
  };

  if (!data.binance_order_id || !data.usdt_amount) {
    showToast('Order ID and USDT amount are required', 'error');
    return;
  }

  const result = await apiFetch('/transactions', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (result && result.id) {
    showToast('Transaction created', 'success');
    closeModal('newTxModal');
    loadTransactions();
    loadDashboardStats();
  } else {
    showToast(result?.error || 'Failed to create transaction', 'error');
  }
}

async function markProcessing(id) {
  await apiFetch('/payout/start', { method: 'POST', body: JSON.stringify({ transaction_id: id }) });
  showToast('Marked as processing', 'success');
  loadRecentTransactions();
  loadTransactions();
}

async function markComplete(id) {
  const ref = prompt('Enter payout reference (optional):') || 'manual';
  await apiFetch('/payout/complete', { method: 'POST', body: JSON.stringify({ transaction_id: id, reference: ref }) });
  showToast('Payout completed', 'success');
  loadRecentTransactions();
  loadTransactions();
  loadDashboardStats();
}

async function releaseUsdt(id) {
  if (!confirm('Mark USDT as released on Binance?')) return;
  await apiFetch(`/transactions/${id}/release`, { method: 'POST' });
  showToast('USDT marked as released', 'success');
  loadRecentTransactions();
  loadTransactions();
}

function openPhoneModal(txId, existingName) {
  document.getElementById('phoneTxId').value = txId;
  document.getElementById('phoneInput').value = '';
  document.getElementById('phoneNameInput').value = existingName || '';
  document.getElementById('phoneModal').style.display = 'flex';
}

async function savePhone() {
  const id = document.getElementById('phoneTxId').value;
  const phone = document.getElementById('phoneInput').value;
  const name = document.getElementById('phoneNameInput').value;
  if (!phone) { showToast('Phone number is required', 'error'); return; }

  await apiFetch(`/transactions/${id}/phone`, {
    method: 'PUT',
    body: JSON.stringify({ phone, customer_name: name || undefined }),
  });
  showToast('Customer details saved', 'success');
  closeModal('phoneModal');
  loadRecentTransactions();
  loadTransactions();
}

async function confirmManualPaid(id) {
  if (!confirm('Confirm this order was paid manually? It will be marked as completed.')) return;
  const ref = prompt('Enter payout reference (e.g., MoMo TxID):') || 'manual';
  const result = await apiFetch(`/transactions/${id}/confirm-paid`, {
    method: 'POST',
    body: JSON.stringify({ reference: ref }),
  });
  if (result && !result.error) {
    showToast('Order confirmed as manually paid', 'success');
    loadRecentTransactions();
    loadTransactions();
    loadDashboardStats();
  } else {
    showToast(result?.error || 'Failed to confirm', 'error');
  }
}

// ─── Monitor Control (3-step flow) ────────────────────────
//
// Step 1: Launch Browser → user logs into Binance via noVNC
// Step 2: Start Monitoring → polls P2P orders for "Buyer Paid"
// Step 3: Stop / Close browser
//

// Step 1: Launch Browser
document.getElementById('btnLaunchBrowser').addEventListener('click', async () => {
  showToast('Launching browser... please wait', 'warning');
  const result = await apiFetch('/monitor/launch', { method: 'POST' });
  if (result?.success) {
    showToast(result.message || 'Browser launched! Log into Binance now.', 'success');
    updateMonitorUI({ browserLaunched: true, isRunning: false });
    // Switch to browser tab so user can see it
    showSection('browser');
  } else {
    showToast(result?.error || 'Failed to launch browser', 'error');
  }
});

// Step 2: Start Monitoring (after Binance login)
document.getElementById('btnStartMonitor').addEventListener('click', async () => {
  showToast('Starting monitoring...', 'warning');
  const result = await apiFetch('/monitor/start', { method: 'POST' });
  if (result?.success) {
    updateMonitorUI({ browserLaunched: true, isRunning: true });
    showToast('Monitoring started! Watching for paid orders.', 'success');
  } else {
    showToast(result?.error || 'Failed to start monitor', 'error');
  }
});

// Stop monitoring (keeps browser open)
document.getElementById('btnStopMonitor').addEventListener('click', async () => {
  const result = await apiFetch('/monitor/stop', { method: 'POST' });
  if (result?.success) {
    updateMonitorUI({ browserLaunched: true, isRunning: false });
    showToast('Monitoring stopped. Browser still open.');
  }
});

// Close browser entirely
document.getElementById('btnCloseBrowser').addEventListener('click', async () => {
  if (!confirm('Close the browser? You will need to re-launch and log into Binance again.')) return;
  const result = await apiFetch('/monitor/close', { method: 'POST' });
  if (result?.success) {
    updateMonitorUI({ browserLaunched: false, isRunning: false });
    showToast('Browser closed.');
  }
});

function updateMonitorUI(status) {
  const browserLaunched = status.browserLaunched || false;
  const isRunning = status.isRunning || false;

  const dots = [document.getElementById('monitorDot'), document.getElementById('topMonitorDot')];
  const labels = [document.getElementById('monitorLabel'), document.getElementById('topMonitorLabel')];
  const launchBtn = document.getElementById('btnLaunchBrowser');
  const startBtn = document.getElementById('btnStartMonitor');
  const stopBtn = document.getElementById('btnStopMonitor');
  const closeBtn = document.getElementById('btnCloseBrowser');

  if (isRunning) {
    // Monitoring active
    dots.forEach(d => d?.classList.add('active'));
    labels.forEach(l => { if (l) l.textContent = 'Monitoring Active'; });
    launchBtn.style.display = 'none';
    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    closeBtn.style.display = '';
  } else if (browserLaunched) {
    // Browser open but not monitoring — user should log in then start
    dots.forEach(d => d?.classList.remove('active'));
    labels.forEach(l => { if (l) l.textContent = 'Browser Open — Log into Binance'; });
    launchBtn.style.display = 'none';
    startBtn.style.display = '';
    stopBtn.style.display = 'none';
    closeBtn.style.display = '';
  } else {
    // Nothing running
    dots.forEach(d => d?.classList.remove('active'));
    labels.forEach(l => { if (l) l.textContent = 'Browser Off'; });
    launchBtn.style.display = '';
    startBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    closeBtn.style.display = 'none';
  }
}

// ─── Browser View Toggle ──────────────────────────────────

function showBrowserView(mode) {
  const interactive = document.getElementById('browserInteractive');
  const screenshot = document.getElementById('browserScreenshotCard');
  const btnInteractive = document.getElementById('btnViewInteractive');
  const btnScreenshot = document.getElementById('btnViewScreenshot');

  if (mode === 'interactive') {
    interactive.style.display = '';
    screenshot.style.display = 'none';
    btnInteractive.className = 'btn btn-sm btn-primary';
    btnScreenshot.className = 'btn btn-sm btn-outline';
  } else {
    interactive.style.display = 'none';
    screenshot.style.display = '';
    btnInteractive.className = 'btn btn-sm btn-outline';
    btnScreenshot.className = 'btn btn-sm btn-primary';
    refreshScreenshot();
  }
}

// ─── Browser Screenshot ───────────────────────────────────

function refreshScreenshot() {
  const img = document.getElementById('browserScreenshot');
  const placeholder = document.getElementById('browserPlaceholder');
  const ts = Date.now();
  img.src = `/api/monitor/screenshot?t=${ts}`;
  img.style.display = '';
  placeholder.style.display = 'none';

  img.onerror = () => {
    img.style.display = 'none';
    placeholder.style.display = 'flex';
  };
}

// Auto-refresh screenshot every 15 seconds when on browser section
setInterval(() => {
  if (document.getElementById('sec-browser').classList.contains('active')) {
    refreshScreenshot();
  }
}, 15000);

// ─── Settings ─────────────────────────────────────────────

const USSD_PATTERNS = {
  mtn_ug: '*165*1*{phone}*{amount}#',
  airtel_ug: '*185# (interactive: Customer Transaction → Cash Deposit → Phone → Amount → PIN)',
  mpesa_ke: '*150*00#',
  tigo_tz: '*150*01*{phone}*{amount}#',
  custom: '',
};

async function loadSettings() {
  const settings = await apiFetch('/settings');
  if (!settings) return;

  document.getElementById('setTelegramToken').value = settings.telegram_bot_token || '';
  document.getElementById('setTelegramChatId').value = settings.telegram_chat_id || '';
  document.getElementById('setTelegramEnabled').value = settings.telegram_enabled || 'true';
  document.getElementById('setUssdProvider').value = settings.ussd_provider || 'mtn_ug';
  document.getElementById('setUssdPattern').value = settings.ussd_pattern || USSD_PATTERNS['mtn_ug'];
  document.getElementById('setUssdPin').value = settings.ussd_pin ? '****' : '';
  document.getElementById('setMonitorInterval').value = settings.monitor_interval_ms || '10000';
  document.getElementById('setDefaultCurrency').value = settings.default_currency || 'UGX';
  document.getElementById('setAutoPayout').value = settings.auto_payout_enabled || 'false';

  // Load modem status, phone status, and QR code
  refreshModemStatus();
  loadPhoneStatus();
  loadQRCode();
}

function updateUssdPattern() {
  const provider = document.getElementById('setUssdProvider').value;
  const pattern = USSD_PATTERNS[provider] || '';
  document.getElementById('setUssdPattern').value = pattern;
}

async function saveSettings() {
  const pin = document.getElementById('setUssdPin').value;
  const updates = {
    telegram_bot_token: document.getElementById('setTelegramToken').value,
    telegram_chat_id: document.getElementById('setTelegramChatId').value,
    telegram_enabled: document.getElementById('setTelegramEnabled').value,
    ussd_provider: document.getElementById('setUssdProvider').value,
    ussd_pattern: document.getElementById('setUssdPattern').value,
    monitor_interval_ms: document.getElementById('setMonitorInterval').value,
    default_currency: document.getElementById('setDefaultCurrency').value,
    auto_payout_enabled: document.getElementById('setAutoPayout').value,
  };
  // Only save PIN if changed (not the masked ****)
  if (pin && pin !== '****') {
    updates.ussd_pin = pin;
  }

  await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(updates) });
  showToast('Settings saved', 'success');
}

async function sendDailySummary() {
  await apiFetch('/summary', { method: 'POST' });
  showToast('Summary sent to Telegram', 'success');
}

// ─── QR Code Pairing ──────────────────────────────────────

let qrCodeInstance = null;

async function loadQRCode() {
  const container = document.getElementById('qrCodeContainer');
  if (!container) return;

  const data = await apiFetch('/pair/qrdata');
  if (!data || !data.url || !data.key) {
    container.innerHTML = '<span style="color:#ea4335;font-size:12px;">Failed to load QR</span>';
    return;
  }

  // Clear previous QR
  container.innerHTML = '';

  const qrPayload = JSON.stringify({ url: data.url, key: data.key });

  if (typeof QRCode !== 'undefined') {
    qrCodeInstance = new QRCode(container, {
      text: qrPayload,
      width: 176,
      height: 176,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } else {
    container.innerHTML = '<span style="color:#ea4335;font-size:12px;">QR library not loaded</span>';
  }
}

// ─── GSM Modem / USSD Engine ──────────────────────────────

async function refreshModemStatus() {
  const data = await apiFetch('/modem/status');
  if (!data) return;

  const badge = document.getElementById('modemStatusBadge');
  const connected = document.getElementById('modemConnected');
  const operator = document.getElementById('modemOperator');
  const signal = document.getElementById('modemSignal');
  const payouts = document.getElementById('modemPayouts');
  const busy = document.getElementById('modemBusy');
  const lastError = document.getElementById('modemLastError');

  if (data.connected) {
    badge.textContent = 'Online';
    badge.style.background = '#e6f4ea';
    badge.style.color = 'var(--success)';
    connected.textContent = 'Connected';
    connected.style.color = 'var(--success)';
  } else {
    badge.textContent = data.error ? 'Engine Offline' : 'Modem Disconnected';
    badge.style.background = '#fce8e6';
    badge.style.color = 'var(--danger)';
    connected.textContent = data.error ? 'Engine unreachable' : 'Disconnected';
    connected.style.color = 'var(--danger)';
  }

  operator.textContent = data.operator || '--';
  signal.textContent = data.signal_percent ? `${data.signal_percent}% (${data.signal}/31)` : '--';
  payouts.textContent = data.completed_count || '0';
  busy.textContent = data.busy ? `Processing #${data.current_payout}` : 'Idle';
  lastError.textContent = data.last_error || 'None';
  lastError.style.color = data.last_error ? 'var(--danger)' : 'var(--text-secondary)';
}

async function modemReconnect() {
  showToast('Reconnecting modem...', 'warning');
  const result = await apiFetch('/modem/reconnect', { method: 'POST' });
  if (result && !result.error) {
    showToast('Modem reconnected', 'success');
    refreshModemStatus();
  } else {
    showToast(result?.error || 'Reconnect failed', 'error');
  }
}

async function modemTestUssd() {
  const code = prompt('Enter USSD code to test (e.g., *185*5# for balance):');
  if (!code) return;
  showToast(`Sending ${code}...`, 'warning');
  const result = await apiFetch('/modem/test-ussd', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (result && !result.error) {
    alert(`USSD Response:\n\n${result.response}`);
  } else {
    showToast(result?.error || 'Test USSD failed', 'error');
  }
}

async function sendViaModem(txId) {
  if (!confirm('Send this payout via the USSD engine now?')) return;
  showToast('Sending to USSD engine...', 'warning');
  const result = await apiFetch(`/modem/send-payout/${txId}`, { method: 'POST' });
  if (result && result.success) {
    showToast('Payout sent to USSD engine', 'success');
    loadRecentTransactions();
    loadTransactions();
    loadDashboardStats();
  } else {
    showToast(result?.error || 'Failed to send payout', 'error');
  }
}

// ─── Phone App Status ─────────────────────────────────────

async function loadPhoneStatus() {
  const data = await apiFetch('/phone/status');
  if (!data) return;

  const badge = document.getElementById('phoneStatusBadge');
  const lastSeen = document.getElementById('phoneLastSeen');
  const device = document.getElementById('phoneDevice');
  const payouts = document.getElementById('phonePayouts');
  const polling = document.getElementById('phonePolling');

  if (data.connected) {
    badge.textContent = 'Connected';
    badge.style.background = '#e6f4ea';
    badge.style.color = 'var(--success)';
  } else {
    badge.textContent = 'Disconnected';
    badge.style.background = '#f1f3f4';
    badge.style.color = 'var(--text-secondary)';
  }

  lastSeen.textContent = data.last_seen ? formatTime(data.last_seen) : 'Never';
  device.textContent = data.device || '--';
  payouts.textContent = data.payouts_completed || '0';
  polling.textContent = data.is_polling ? 'Polling Active' : 'Idle';
}

// ─── Activity Log ─────────────────────────────────────────

async function loadActivity() {
  const data = await apiFetch('/activity?limit=100');
  if (!data) return;

  const body = document.getElementById('activityBody');
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;">No activity yet</td></tr>';
    return;
  }

  body.innerHTML = data.map(log => {
    let details = '';
    try { details = log.details ? JSON.stringify(JSON.parse(log.details)) : ''; }
    catch { details = log.details || ''; }

    return `
      <tr>
        <td style="font-size:11px;">${formatTime(log.created_at)}</td>
        <td><span class="badge badge-detected">${log.action}</span></td>
        <td>${log.binance_order_id ? `<code style="font-size:11px;">${log.binance_order_id.substring(0, 12)}...</code>` : '-'}</td>
        <td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;">${details}</td>
      </tr>
    `;
  }).join('');
}

// ─── Modals ───────────────────────────────────────────────

document.getElementById('btnNewTransaction').addEventListener('click', () => {
  document.getElementById('newTxModal').style.display = 'flex';
});

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// ─── Logout ───────────────────────────────────────────────

document.getElementById('btnLogout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ─── Mobile Menu ──────────────────────────────────────────

const menuToggle = document.getElementById('menuToggle');
if (window.innerWidth <= 768) menuToggle.style.display = '';
menuToggle.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

window.addEventListener('resize', () => {
  menuToggle.style.display = window.innerWidth <= 768 ? '' : 'none';
});

// ─── Utilities ────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'Z');
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function showToast(message, type = '') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ─── Init ─────────────────────────────────────────────────

connectWebSocket();
loadDashboardStats();
loadRecentTransactions();

// Auto-refresh stats every 30 seconds
setInterval(() => {
  if (document.getElementById('sec-dashboard').classList.contains('active')) {
    loadDashboardStats();
    loadRecentTransactions();
  }
}, 30000);
