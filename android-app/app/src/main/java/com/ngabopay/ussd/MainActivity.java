package com.ngabopay.ussd;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AppCompatActivity;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import org.json.JSONObject;

public class MainActivity extends AppCompatActivity {

    private TextInputEditText etServerUrl, etApiKey, etMmPin;
    private AutoCompleteTextView spProvider;
    private TextView tvStatus, tvLastAction, tvLog, tvConnectionStatus;
    private MaterialButton btnStart, btnStop, btnAccessibility, btnScanQR, btnToggleManual;
    private LinearLayout manualSetupSection;
    private SharedPreferences prefs;

    private static final String PREFS_NAME = "NgaboPayPrefs";
    private static MainActivity instance;
    private StringBuilder logBuffer = new StringBuilder();
    private boolean manualSectionVisible = false;

    // QR Code scanner launcher
    private final ActivityResultLauncher<ScanOptions> qrScanLauncher =
        registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() != null) {
                handleQRResult(result.getContents());
            } else {
                addLog("QR scan cancelled");
            }
        });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        instance = this;

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        etServerUrl = findViewById(R.id.etServerUrl);
        etApiKey = findViewById(R.id.etApiKey);
        etMmPin = findViewById(R.id.etMmPin);
        spProvider = findViewById(R.id.spProvider);
        tvStatus = findViewById(R.id.tvStatus);
        tvLastAction = findViewById(R.id.tvLastAction);
        tvLog = findViewById(R.id.tvLog);
        tvConnectionStatus = findViewById(R.id.tvConnectionStatus);
        btnStart = findViewById(R.id.btnStart);
        btnStop = findViewById(R.id.btnStop);
        btnAccessibility = findViewById(R.id.btnAccessibility);
        btnScanQR = findViewById(R.id.btnScanQR);
        btnToggleManual = findViewById(R.id.btnToggleManual);
        manualSetupSection = findViewById(R.id.manualSetupSection);

        // Provider dropdown
        String[] providers = {"MTN Mobile Money (Uganda)", "Airtel Money (Uganda)", "M-Pesa (Kenya)", "Tigo Pesa (Tanzania)"};
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, providers);
        spProvider.setAdapter(adapter);

        // Load saved settings
        etServerUrl.setText(prefs.getString("server_url", ""));
        etApiKey.setText(prefs.getString("api_key", ""));
        etMmPin.setText(prefs.getString("mm_pin", ""));
        spProvider.setText(prefs.getString("provider", "Airtel Money (Uganda)"), false);

        // Update connection status display
        updateConnectionStatus();

        // QR Scan button
        btnScanQR.setOnClickListener(v -> launchQRScanner());

        // Toggle manual setup section
        btnToggleManual.setOnClickListener(v -> {
            manualSectionVisible = !manualSectionVisible;
            manualSetupSection.setVisibility(manualSectionVisible ? View.VISIBLE : View.GONE);
            btnToggleManual.setText(manualSectionVisible ? "Hide Manual Setup" : "Manual Setup (Advanced)");
        });

        // Start polling
        btnStart.setOnClickListener(v -> {
            saveSettings();
            startPolling();
        });

        // Stop polling
        btnStop.setOnClickListener(v -> stopPolling());

        // Open accessibility settings
        btnAccessibility.setOnClickListener(v -> {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            startActivity(intent);
        });
    }

    private void launchQRScanner() {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt("Scan the QR code from the NgaboPay dashboard");
        options.setCameraId(0);
        options.setBeepEnabled(true);
        options.setBarcodeImageEnabled(false);
        options.setOrientationLocked(true);
        qrScanLauncher.launch(options);
    }

    private void handleQRResult(String qrContent) {
        try {
            JSONObject json = new JSONObject(qrContent);
            String url = json.getString("url");
            String key = json.getString("key");

            // Save to preferences
            prefs.edit()
                .putString("server_url", url)
                .putString("api_key", key)
                .apply();

            // Update UI fields
            etServerUrl.setText(url);
            etApiKey.setText(key);

            // Update connection status
            updateConnectionStatus();

            addLog("Connected via QR scan: " + url);
            Toast.makeText(this, "Connected to server!", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            addLog("Invalid QR code: " + e.getMessage());
            Toast.makeText(this, "Invalid QR code. Use the QR from the NgaboPay dashboard.", Toast.LENGTH_LONG).show();
        }
    }

    private void updateConnectionStatus() {
        String serverUrl = prefs.getString("server_url", "");
        String apiKey = prefs.getString("api_key", "");

        if (!serverUrl.isEmpty() && !apiKey.isEmpty()) {
            tvConnectionStatus.setText("Connected to: " + serverUrl);
            tvConnectionStatus.setTextColor(0xFF34A853);
            btnScanQR.setText("Re-scan QR Code");
        } else {
            tvConnectionStatus.setText("Not Connected");
            tvConnectionStatus.setTextColor(0xFFEA4335);
            btnScanQR.setText("Scan QR Code to Connect");
        }
    }

    private void saveSettings() {
        prefs.edit()
            .putString("server_url", etServerUrl.getText().toString().trim())
            .putString("api_key", etApiKey.getText().toString().trim())
            .putString("mm_pin", etMmPin.getText().toString().trim())
            .putString("provider", spProvider.getText().toString().trim())
            .apply();
    }

    private void startPolling() {
        String serverUrl = etServerUrl.getText().toString().trim();
        String apiKey = etApiKey.getText().toString().trim();

        if (serverUrl.isEmpty() || apiKey.isEmpty()) {
            addLog("ERROR: Server URL and API Key are required. Scan the QR code first!");
            Toast.makeText(this, "Scan the QR code from the dashboard first", Toast.LENGTH_LONG).show();
            return;
        }

        // Set the Mobile Money PIN for USSD automation
        String mmPin = etMmPin.getText().toString().trim();
        if (mmPin.isEmpty()) {
            addLog("WARNING: Mobile Money PIN not set. USSD will fail at PIN prompt.");
        }
        UssdAccessibilityService.setPin(mmPin);

        // Set the provider for USSD step navigation
        String provider = spProvider.getText().toString().trim();
        UssdAccessibilityService.setProvider(provider);

        Intent intent = new Intent(this, PayoutPollingService.class);
        intent.putExtra("server_url", serverUrl);
        intent.putExtra("api_key", apiKey);
        intent.putExtra("provider", provider);

        // Start as foreground service so Android won't kill it
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }

        tvStatus.setText("Running");
        tvStatus.setTextColor(0xFF34A853);
        btnStart.setEnabled(false);
        btnStop.setEnabled(true);
        addLog("Polling started");
    }

    private void stopPolling() {
        Intent intent = new Intent(this, PayoutPollingService.class);
        stopService(intent);

        tvStatus.setText("Stopped");
        tvStatus.setTextColor(0xFFEA4335);
        btnStart.setEnabled(true);
        btnStop.setEnabled(false);
        addLog("Polling stopped");
    }

    public void addLog(String message) {
        runOnUiThread(() -> {
            String time = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
                .format(new java.util.Date());
            logBuffer.insert(0, time + " | " + message + "\n");
            if (logBuffer.length() > 5000) {
                logBuffer.setLength(5000);
            }
            tvLog.setText(logBuffer.toString());
        });
    }

    public void updateLastAction(String action) {
        runOnUiThread(() -> tvLastAction.setText(action));
    }

    public static MainActivity getInstance() {
        return instance;
    }
}
