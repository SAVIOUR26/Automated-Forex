package com.ngabopay.ussd;

import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import okhttp3.*;
import java.io.IOException;
import java.lang.reflect.Type;
import java.util.List;

/**
 * Polls the NgaboPay server for pending payouts and initiates USSD calls.
 */
public class PayoutPollingService extends Service {

    private static final String TAG = "PayoutPolling";
    private static final long POLL_INTERVAL = 15000; // 15 seconds

    private Handler handler;
    private OkHttpClient httpClient;
    private Gson gson;
    private String serverUrl;
    private String apiKey;
    private String provider;
    private boolean isRunning = false;

    private static PayoutPollingService instance;

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        httpClient = new OkHttpClient();
        gson = new Gson();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            serverUrl = intent.getStringExtra("server_url");
            apiKey = intent.getStringExtra("api_key");
            provider = intent.getStringExtra("provider");
        }

        if (!isRunning) {
            isRunning = true;
            pollForPayouts();
        }

        return START_STICKY;
    }

    private void pollForPayouts() {
        if (!isRunning) return;

        log("Polling for pending payouts...");

        String url = serverUrl + "/api/payout/pending";
        Request request = new Request.Builder()
            .url(url)
            .addHeader("X-API-Key", apiKey)
            .build();

        httpClient.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                log("Poll failed: " + e.getMessage());
                scheduleNextPoll();
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                if (!response.isSuccessful()) {
                    log("Poll error: HTTP " + response.code());
                    scheduleNextPoll();
                    return;
                }

                String body = response.body().string();
                Type listType = new TypeToken<List<PayoutTransaction>>(){}.getType();
                List<PayoutTransaction> payouts = gson.fromJson(body, listType);

                if (payouts != null && !payouts.isEmpty()) {
                    log("Found " + payouts.size() + " pending payout(s)");
                    processNextPayout(payouts.get(0));
                } else {
                    log("No pending payouts");
                }

                scheduleNextPoll();
            }
        });
    }

    private void processNextPayout(PayoutTransaction payout) {
        log("Processing payout #" + payout.id + ": " +
            (long) payout.local_amount + " " + payout.local_currency +
            " to " + payout.customer_phone);

        // Notify server we're starting
        notifyServer("start", payout.id, null, null);

        // Determine USSD code based on provider
        String ussdCode = buildUssdCode(payout);
        if (ussdCode == null) {
            log("ERROR: Unknown provider, cannot build USSD code");
            notifyServer("failed", payout.id, "Unknown provider", null);
            return;
        }

        // Store current payout in accessibility service
        UssdAccessibilityService.setCurrentPayout(payout);

        // Dial USSD
        log("Dialing USSD: " + ussdCode);
        updateActivity("Sending " + (long) payout.local_amount + " " + payout.local_currency);

        Intent callIntent = new Intent(Intent.ACTION_CALL);
        callIntent.setData(Uri.parse("tel:" + Uri.encode(ussdCode)));
        callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            startActivity(callIntent);
        } catch (SecurityException e) {
            log("ERROR: Call permission denied");
            notifyServer("failed", payout.id, "Call permission denied", null);
        }
    }

    /**
     * Build the USSD code to send money via Mobile Money.
     * These codes vary by provider and country.
     */
    private String buildUssdCode(PayoutTransaction payout) {
        String phone = payout.customer_phone;
        long amount = (long) payout.local_amount;

        if (provider == null) return null;

        if (provider.contains("MTN")) {
            // MTN Mobile Money Uganda: *165*1*PHONE*AMOUNT#
            return "*165*1*" + phone + "*" + amount + "#";
        } else if (provider.contains("Airtel")) {
            // Airtel Money Uganda: *185*1*PHONE*AMOUNT#
            return "*185*1*" + phone + "*" + amount + "#";
        } else if (provider.contains("M-Pesa")) {
            // M-Pesa Kenya: *150*00#, then navigate menus
            // M-Pesa uses a menu-based system, start with the main code
            return "*150*00#";
        } else if (provider.contains("Tigo")) {
            // Tigo Pesa Tanzania: *150*01*PHONE*AMOUNT#
            return "*150*01*" + phone + "*" + amount + "#";
        }

        return null;
    }

    public void notifyServer(String action, int transactionId, String reason, String reference) {
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
                log("Server notify failed: " + e.getMessage());
            }

            @Override
            public void onResponse(Call call, Response response) {
                log("Server notified: " + action + " (HTTP " + response.code() + ")");
            }
        });
    }

    private void scheduleNextPoll() {
        handler.postDelayed(this::pollForPayouts, POLL_INTERVAL);
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
}
