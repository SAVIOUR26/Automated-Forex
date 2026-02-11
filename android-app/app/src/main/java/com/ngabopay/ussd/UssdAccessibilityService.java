package com.ngabopay.ussd;

import android.accessibilityservice.AccessibilityService;
import android.os.Bundle;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.List;

/**
 * Accessibility Service that automates USSD menu navigation.
 *
 * When a USSD dialog appears, this service:
 * 1. Reads the dialog text
 * 2. Determines the appropriate response (PIN, confirmation, etc.)
 * 3. Enters the response and clicks send/OK
 * 4. Reports success/failure back via PayoutPollingService.onUssdComplete()
 */
public class UssdAccessibilityService extends AccessibilityService {

    private static final String TAG = "UssdAccessibility";
    private static PayoutPollingService.PayoutTransaction currentPayout;
    private static String mobileMoneyPin = "";
    private int ussdStep = 0;

    public static void setCurrentPayout(PayoutPollingService.PayoutTransaction payout) {
        currentPayout = payout;
    }

    public static void setPin(String pin) {
        mobileMoneyPin = pin;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.getEventType() != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            return;
        }

        // Only process USSD dialogs from the phone/dialer app
        String packageName = event.getPackageName() != null ? event.getPackageName().toString() : "";
        if (!packageName.contains("phone") && !packageName.contains("dialer") &&
            !packageName.contains("telecom") && !packageName.contains("incallui")) {
            return;
        }

        AccessibilityNodeInfo rootNode = getRootInActiveWindow();
        if (rootNode == null) return;

        // Find the USSD dialog text
        String dialogText = findDialogText(rootNode);
        if (dialogText == null || dialogText.isEmpty()) return;

        Log.d(TAG, "USSD Dialog [Step " + ussdStep + "]: " + dialogText);
        logToActivity("USSD: " + dialogText.substring(0, Math.min(100, dialogText.length())));

        // Process based on dialog content
        processUssdDialog(rootNode, dialogText);
    }

    private void processUssdDialog(AccessibilityNodeInfo rootNode, String text) {
        String lowerText = text.toLowerCase();

        // Check for success indicators
        if (lowerText.contains("successful") || lowerText.contains("confirmed") ||
            lowerText.contains("completed") || lowerText.contains("sent")) {
            logToActivity("USSD: Transaction successful!");
            handleSuccess(text);
            clickButton(rootNode, "ok", "cancel", "dismiss");
            ussdStep = 0;
            return;
        }

        // Check for failure indicators
        if (lowerText.contains("failed") || lowerText.contains("error") ||
            lowerText.contains("insufficient") || lowerText.contains("invalid") ||
            lowerText.contains("denied")) {
            logToActivity("USSD: Transaction failed - " + text);
            handleFailure(text);
            clickButton(rootNode, "ok", "cancel", "dismiss");
            ussdStep = 0;
            return;
        }

        // Check for PIN prompt
        if (lowerText.contains("pin") || lowerText.contains("password") ||
            lowerText.contains("enter your")) {
            if (!mobileMoneyPin.isEmpty()) {
                logToActivity("USSD: Entering PIN");
                enterTextAndSend(rootNode, mobileMoneyPin);
                ussdStep++;
                return;
            } else {
                logToActivity("USSD: PIN required but not set!");
                handleFailure("Mobile Money PIN not configured");
                return;
            }
        }

        // Check for confirmation prompt
        if (lowerText.contains("confirm") || lowerText.contains("are you sure") ||
            lowerText.contains("you are sending")) {
            logToActivity("USSD: Confirming transaction");
            enterTextAndSend(rootNode, "1");
            ussdStep++;
            return;
        }

        // For menu-based systems (like M-Pesa), navigate by step
        if (currentPayout != null && ussdStep == 0) {
            enterTextAndSend(rootNode, "1");
            ussdStep++;
        } else if (currentPayout != null && ussdStep == 1) {
            enterTextAndSend(rootNode, currentPayout.customer_phone);
            ussdStep++;
        } else if (currentPayout != null && ussdStep == 2) {
            enterTextAndSend(rootNode, String.valueOf((long) currentPayout.local_amount));
            ussdStep++;
        }
    }

    private void handleSuccess(String responseText) {
        if (currentPayout != null) {
            PayoutPollingService service = PayoutPollingService.getInstance();
            if (service != null) {
                String ref = extractReference(responseText);
                service.onUssdComplete(currentPayout.id, true, ref != null ? ref : "USSD-OK", null);
            }
            currentPayout = null;
        }
        ussdStep = 0;
    }

    private void handleFailure(String reason) {
        if (currentPayout != null) {
            PayoutPollingService service = PayoutPollingService.getInstance();
            if (service != null) {
                service.onUssdComplete(currentPayout.id, false, null, reason);
            }
            currentPayout = null;
        }
        ussdStep = 0;
    }

    private String extractReference(String text) {
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile(
            "(?:ref|txn|transaction|id)[:\\s]*([A-Z0-9]{6,20})",
            java.util.regex.Pattern.CASE_INSENSITIVE
        );
        java.util.regex.Matcher matcher = pattern.matcher(text);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return null;
    }

    private String findDialogText(AccessibilityNodeInfo node) {
        if (node == null) return null;

        StringBuilder sb = new StringBuilder();
        if (node.getText() != null) {
            sb.append(node.getText().toString());
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                String childText = findDialogText(child);
                if (childText != null && !childText.isEmpty()) {
                    if (sb.length() > 0) sb.append(" ");
                    sb.append(childText);
                }
            }
        }

        return sb.toString();
    }

    private void enterTextAndSend(AccessibilityNodeInfo rootNode, String text) {
        AccessibilityNodeInfo inputNode = findInputField(rootNode);
        if (inputNode != null) {
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            inputNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        }

        clickButton(rootNode, "send", "ok", "reply");
    }

    private AccessibilityNodeInfo findInputField(AccessibilityNodeInfo node) {
        if (node == null) return null;

        if (node.isEditable()) return node;

        if ("android.widget.EditText".equals(node.getClassName())) return node;

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo result = findInputField(node.getChild(i));
            if (result != null) return result;
        }

        return null;
    }

    private void clickButton(AccessibilityNodeInfo rootNode, String... buttonTexts) {
        for (String buttonText : buttonTexts) {
            List<AccessibilityNodeInfo> buttons = rootNode.findAccessibilityNodeInfosByText(buttonText);
            if (buttons != null && !buttons.isEmpty()) {
                for (AccessibilityNodeInfo btn : buttons) {
                    if (btn.isClickable()) {
                        btn.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        return;
                    }
                    AccessibilityNodeInfo parent = btn.getParent();
                    if (parent != null && parent.isClickable()) {
                        parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        return;
                    }
                }
            }
        }
    }

    private void logToActivity(String msg) {
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.addLog(msg);
        }
    }

    @Override
    public void onInterrupt() {
        Log.d(TAG, "Accessibility service interrupted");
    }
}
