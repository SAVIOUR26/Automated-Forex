package com.ngabopay.ussd;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import okhttp3.*;
import java.io.IOException;
import java.lang.reflect.Type;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Foreground Service that polls the NgaboPay server for pending payouts.
 *
 * Runs as a ForegroundService with a persistent notification so Android
 * won't kill it in the background. Includes:
 * - Explicit HTTP timeouts
 * - Exponential backoff on connection failures
 * - Retry logic for server notifications (complete/failed)
 * - USSD timeout tracking
 */
public class PayoutPollingService extends Service {

    private static final String TAG = "PayoutPolling";
    private static final String CHANNEL_ID = "ngabopay_polling";
    private static final int NOTIFICATION_ID = 1001;
    private static final long POLL_INTERVAL = 15000; // 15 seconds
    private static final long USSD_TIMEOUT_MS = 120000; // 2 minutes
    private static final int MAX_NOTIFY_RETRIES = 3;

    private Handler handler;
    private OkHttpClient httpClient;
    private Gson gson;
    private String serverUrl;
    private String apiKey;
    private String provider;
    private boolean isRunning = false;

    // USSD timeout tracking
    private long ussdStartTime = 0;
    private int currentPayoutId = -1;
    private Handler ussdTimeoutHandler;

    // Backoff tracking
    private int consecutiveFailures = 0;
    private static final long MAX_BACKOFF_MS = 60000;

    private int completedPayouts = 0;
    private static PayoutPollingService instance;

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        ussdTimeoutHandler = new Handler(Looper.getMainLooper());

        // OkHttpClient with explicit timeouts
        httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build();

        gson = new Gson();
        instance = this;

        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            serverUrl = intent.getStringExtra("server_url");
            apiKey = intent.getStringExtra("api_key");
            provider = intent.getStringExtra("provider");
        }

        // Start as foreground service so Android won't kill us
        startForeground(NOTIFICATION_ID, buildNotification("Waiting for payouts..."));

        if (!isRunning) {
            isRunning = true;
            consecutiveFailures = 0;
            pollForPayouts();
        }

        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "NgaboPay Payout Service",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Keeps the payout polling service running");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String text) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("NgaboPay Active")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(text));
        }
    }

    private void sendHeartbeat() {
        if (serverUrl == null || apiKey == null) return;

        String json = gson.toJson(new HeartbeatPayload(
            android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL,
            isRunning,
            completedPayouts
        ));

        RequestBody body = RequestBody.create(json, MediaType.parse("application/json"));
        Request request = new Request.Builder()
            .url(serverUrl + "/api/phone/heartbeat")
            .addHeader("X-API-Key", apiKey)
            .post(body)
            .build();

        httpClient.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {}
            @Override public void onResponse(Call call, Response response) { response.close(); }
        });
    }

    private void pollForPayouts() {
        if (!isRunning) return;

        // Don't poll if we're waiting for a USSD to complete
        if (currentPayoutId > 0) {
            log("Waiting for USSD to complete (payout #" + currentPayoutId + ")");
            scheduleNextPoll();
            return;
        }

        sendHeartbeat();
        log("Polling for pending payouts...");

        String url = serverUrl + "/api/payout/pending";
        Request request = new Request.Builder()
            .url(url)
            .addHeader("X-API-Key", apiKey)
            .build();

        httpClient.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                consecutiveFailures++;
                log("Poll failed (" + consecutiveFailures + "x): " + e.getMessage());
                scheduleNextPoll();
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                try {
                    if (!response.isSuccessful()) {
                        consecutiveFailures++;
                        log("Poll error: HTTP " + response.code());
                        scheduleNextPoll();
                        return;
                    }

                    // Reset backoff on success
                    consecutiveFailures = 0;

                    String responseBody = response.body().string();
                    Type listType = new TypeToken<List<PayoutTransaction>>(){}.getType();
                    List<PayoutTransaction> payouts = gson.fromJson(responseBody, listType);

                    if (payouts != null && !payouts.isEmpty()) {
                        log("Found " + payouts.size() + " pending payout(s)");
                        processNextPayout(payouts.get(0));
                    } else {
                        log("No pending payouts");
                    }
                } finally {
                    response.close();
                    scheduleNextPoll();
                }
            }
        });
    }

    private void processNextPayout(PayoutTransaction payout) {
        log("Processing payout #" + payout.id + ": " +
            (long) payout.local_amount + " " + payout.local_currency +
            " to " + payout.customer_phone);

        // Notify server we're starting (uses atomic claim on server side)
        notifyServerWithRetry("start", payout.id, null, null, 0);

        // Track this payout for USSD timeout
        currentPayoutId = payout.id;
        ussdStartTime = System.currentTimeMillis();

        // Determine USSD code based on provider
        String ussdCode = buildUssdCode(payout);
        if (ussdCode == null) {
            log("ERROR: Unknown provider, cannot build USSD code");
            notifyServerWithRetry("failed", payout.id, "Unknown provider", null, 0);
            clearCurrentPayout();
            return;
        }

        // Store current payout in accessibility service
        UssdAccessibilityService.setCurrentPayout(payout);

        // Dial USSD
        log("Dialing USSD: " + ussdCode);
        updateActivity("Sending " + (long) payout.local_amount + " " + payout.local_currency);
        updateNotification("Sending " + (long) payout.local_amount + " " + payout.local_currency);

        Intent callIntent = new Intent(Intent.ACTION_CALL);
        callIntent.setData(Uri.parse("tel:" + Uri.encode(ussdCode)));
        callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            startActivity(callIntent);
            // Start USSD timeout timer
            startUssdTimeout(payout.id);
        } catch (SecurityException e) {
            log("ERROR: Call permission denied");
            notifyServerWithRetry("failed", payout.id, "Call permission denied", null, 0);
            clearCurrentPayout();
        }
    }

    /**
     * Start a timeout timer for USSD. If the accessibility service doesn't
     * report success/failure within 2 minutes, we report a timeout.
     */
    private void startUssdTimeout(int payoutId) {
        ussdTimeoutHandler.removeCallbacksAndMessages(null);
        ussdTimeoutHandler.postDelayed(() -> {
            if (currentPayoutId == payoutId) {
                log("USSD TIMEOUT for payout #" + payoutId + " after " + (USSD_TIMEOUT_MS / 1000) + "s");
                notifyServerWithRetry("failed", payoutId, "USSD timeout - no response from phone", null, 0);
                clearCurrentPayout();
                updateNotification("USSD timeout - waiting for next payout");
            }
        }, USSD_TIMEOUT_MS);
    }

    /** Called by UssdAccessibilityService when USSD completes */
    public void onUssdComplete(int payoutId, boolean success, String reference, String reason) {
        ussdTimeoutHandler.removeCallbacksAndMessages(null);

        if (success) {
            completedPayouts++;
            notifyServerWithRetry("complete", payoutId, null, reference, 0);
            updateNotification("Completed " + completedPayouts + " payouts");
        } else {
            notifyServerWithRetry("failed", payoutId, reason, null, 0);
            updateNotification("Payout failed - waiting for next");
        }
        clearCurrentPayout();
    }

    private void clearCurrentPayout() {
        currentPayoutId = -1;
        ussdStartTime = 0;
        UssdAccessibilityService.setCurrentPayout(null);
    }

    /**
     * Build the USSD code to send money via Mobile Money.
     *
     * Airtel Money Uganda (*185#) uses interactive menu navigation:
     *   Step 0: Select "Customer Transaction"
     *   Step 1: Select "Cash Deposit"
     *   Step 2: Enter customer phone number
     *   Step 3: Enter amount
     *   Step 4: Enter PIN (handled by PIN detection in accessibility service)
     *
     * MTN uses shortcode format: *165*1*phone*amount#
     */
    private String buildUssdCode(PayoutTransaction payout) {
        if (provider == null) return null;

        String phone = payout.customer_phone;
        long amount = (long) payout.local_amount;

        if (provider.contains("MTN")) {
            return "*165*1*" + phone + "*" + amount + "#";
        } else if (provider.contains("Airtel")) {
            // Airtel requires interactive menu navigation via *185#
            // The UssdAccessibilityService handles the step-by-step flow
            return "*185#";
        } else if (provider.contains("M-Pesa")) {
            return "*150*00#";
        } else if (provider.contains("Tigo")) {
            return "*150*01*" + phone + "*" + amount + "#";
        }

        return null;
    }

    /**
     * Notify server with exponential backoff retry on failure.
     * Critical for payout/complete and payout/failed — we MUST deliver these.
     */
    public void notifyServerWithRetry(String action, int transactionId, String reason, String reference, int attempt) {
        String url = serverUrl + "/api/payout/" + action;
        String json;

        if ("failed".equals(action)) {
            json = gson.toJson(new PayoutUpdate(transactionId, reason, null));
        } else if ("complete".equals(action)) {
            json = gson.toJson(new PayoutUpdate(transactionId, null, reference));
        } else {
            json = gson.toJson(new PayoutUpdate(transactionId, null, null));
        }

        RequestBody body = RequestBody.create(json, MediaType.parse("application/json"));
        Request request = new Request.Builder()
            .url(url)
            .addHeader("X-API-Key", apiKey)
            .post(body)
            .build();

        httpClient.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                log("Server notify failed: " + action + " - " + e.getMessage());
                if (attempt < MAX_NOTIFY_RETRIES && ("complete".equals(action) || "failed".equals(action))) {
                    long delay = (long) Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
                    log("Retrying " + action + " in " + (delay / 1000) + "s (attempt " + (attempt + 1) + "/" + MAX_NOTIFY_RETRIES + ")");
                    handler.postDelayed(() ->
                        notifyServerWithRetry(action, transactionId, reason, reference, attempt + 1),
                        delay
                    );
                } else {
                    log("CRITICAL: Failed to notify server of " + action + " for payout #" + transactionId + " after " + MAX_NOTIFY_RETRIES + " attempts");
                }
            }

            @Override
            public void onResponse(Call call, Response response) {
                int code = response.code();
                response.close();

                if (code == 409 && "start".equals(action)) {
                    // Payout was already claimed — skip it
                    log("Payout #" + transactionId + " already claimed (409), skipping");
                    clearCurrentPayout();
                    return;
                }

                log("Server notified: " + action + " (HTTP " + code + ")");
            }
        });
    }

    // Keep old method for backward compatibility with UssdAccessibilityService
    public void notifyServer(String action, int transactionId, String reason, String reference) {
        notifyServerWithRetry(action, transactionId, reason, reference, 0);
    }

    private void scheduleNextPoll() {
        // Exponential backoff on consecutive failures
        long delay = POLL_INTERVAL;
        if (consecutiveFailures > 0) {
            delay = Math.min(POLL_INTERVAL * (long) Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_MS);
        }
        handler.postDelayed(this::pollForPayouts, delay);
    }

    private void log(String msg) {
        Log.d(TAG, msg);
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.addLog(msg);
        }
    }

    private void updateActivity(String action) {
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.updateLastAction(action);
        }
    }

    public static PayoutPollingService getInstance() {
        return instance;
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        handler.removeCallbacksAndMessages(null);
        ussdTimeoutHandler.removeCallbacksAndMessages(null);
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ─── Data Classes ────────────────────────────────────

    public static class PayoutTransaction {
        public int id;
        public String binance_order_id;
        public double usdt_amount;
        public double exchange_rate;
        public String local_currency;
        public double local_amount;
        public String customer_phone;
        public String customer_name;
        public String status;
        public String payout_status;
    }

    private static class PayoutUpdate {
        int transaction_id;
        String reason;
        String reference;

        PayoutUpdate(int id, String reason, String reference) {
            this.transaction_id = id;
            this.reason = reason;
            this.reference = reference;
        }
    }

    private static class HeartbeatPayload {
        String device;
        boolean is_polling;
        int payouts_completed;

        HeartbeatPayload(String device, boolean is_polling, int payouts_completed) {
            this.device = device;
            this.is_polling = is_polling;
            this.payouts_completed = payouts_completed;
        }
    }
}
