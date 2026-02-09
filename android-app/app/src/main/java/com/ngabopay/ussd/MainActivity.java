package com.ngabopay.ussd;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

public class MainActivity extends AppCompatActivity {

    private TextInputEditText etServerUrl, etApiKey;
    private AutoCompleteTextView spProvider;
    private TextView tvStatus, tvLastAction, tvLog;
    private MaterialButton btnStart, btnStop, btnAccessibility;
    private SharedPreferences prefs;

    private static final String PREFS_NAME = "NgaboPayPrefs";
    private static MainActivity instance;
    private StringBuilder logBuffer = new StringBuilder();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        instance = this;

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        etServerUrl = findViewById(R.id.etServerUrl);
        etApiKey = findViewById(R.id.etApiKey);
        spProvider = findViewById(R.id.spProvider);
        tvStatus = findViewById(R.id.tvStatus);
        tvLastAction = findViewById(R.id.tvLastAction);
        tvLog = findViewById(R.id.tvLog);
        btnStart = findViewById(R.id.btnStart);
        btnStop = findViewById(R.id.btnStop);
        btnAccessibility = findViewById(R.id.btnAccessibility);

        // Provider dropdown
        String[] providers = {"MTN Mobile Money (Uganda)", "Airtel Money (Uganda)", "M-Pesa (Kenya)", "Tigo Pesa (Tanzania)"};
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, providers);
        spProvider.setAdapter(adapter);

        // Load saved settings
        etServerUrl.setText(prefs.getString("server_url", ""));
        etApiKey.setText(prefs.getString("api_key", ""));
        spProvider.setText(prefs.getString("provider", "MTN Mobile Money (Uganda)"), false);

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

    private void saveSettings() {
        prefs.edit()
            .putString("server_url", etServerUrl.getText().toString().trim())
            .putString("api_key", etApiKey.getText().toString().trim())
            .putString("provider", spProvider.getText().toString().trim())
            .apply();
    }

    private void startPolling() {
        String serverUrl = etServerUrl.getText().toString().trim();
        String apiKey = etApiKey.getText().toString().trim();

        if (serverUrl.isEmpty() || apiKey.isEmpty()) {
            addLog("ERROR: Server URL and API Key are required");
            return;
        }

        Intent intent = new Intent(this, PayoutPollingService.class);
        intent.putExtra("server_url", serverUrl);
        intent.putExtra("api_key", apiKey);
        intent.putExtra("provider", spProvider.getText().toString().trim());
        startService(intent);

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
