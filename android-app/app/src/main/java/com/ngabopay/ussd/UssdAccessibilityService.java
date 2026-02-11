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
 * Provider-aware step navigation:
 *
 * AIRTEL MONEY (Uganda) - *185# interactive menu:
 *   Step 0: Select "Customer Transaction" → enter "1"
 *   Step 1: Select "Cash Deposit" → enter "1"
 *   Step 2: Enter customer phone number
 *   Step 3: Enter amount
 *   Step 4: Enter PIN (detected by keyword matching)
 *   Step 5: Confirm (detected by keyword matching)
 *
 * MTN (Uganda) - *165*1*phone*amount# shortcode:
 *   Step 0: Enter PIN (all info is in the shortcode already)
 *   Step 1: Confirm
 *
 * M-Pesa (Kenya) - *150*00# interactive:
 *   Step 0: Enter phone number
 *   Step 1: Enter amount
 *   Step 2: Enter PIN
 *
 * Tigo (Tanzania) - *150*01*phone*amount# shortcode:
 *   Step 0: Enter PIN
 *   Step 1: Confirm
 */
public class UssdAccessibilityService extends AccessibilityService {

    private static final String TAG = "UssdAccessibility";
    private static PayoutPollingService.PayoutTransaction currentPayout;
    private static String mobileMoneyPin = "";
    private static String currentProvider = "";
    private int ussdStep = 0;

    public static void setCurrentPayout(PayoutPollingService.PayoutTransaction payout) {
        currentPayout = payout;
    }

    public static void setPin(String pin) {
        mobileMoneyPin = pin;
    }

    public static void setProvider(String provider) {
        currentProvider = provider != null ? provider : "";
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

        Log.d(TAG, "USSD Dialog [Step " + ussdStep + "] [" + currentProvider + "]: " + dialogText);
        logToActivity("USSD [Step " + ussdStep + "]: " + dialogText.substring(0, Math.min(80, dialogText.length())));

        // Process based on dialog content
        processUssdDialog(rootNode, dialogText);
    }

    private void processUssdDialog(AccessibilityNodeInfo rootNode, String text) {
        String lowerText = text.toLowerCase();

        // Check for success indicators (universal — any provider)
        if (lowerText.contains("successful") || lowerText.contains("confirmed") ||
            lowerText.contains("completed") || lowerText.contains("has been sent") ||
            lowerText.contains("sent to")) {
            logToActivity("USSD: Transaction successful!");
            handleSuccess(text);
            clickButton(rootNode, "ok", "cancel", "dismiss");
            ussdStep = 0;
            return;
        }

        // Check for failure indicators (universal — any provider)
        if (lowerText.contains("failed") || lowerText.contains("error") ||
            lowerText.contains("insufficient") || lowerText.contains("invalid") ||
            lowerText.contains("denied") || lowerText.contains("not allowed") ||
            lowerText.contains("exceeded")) {
            logToActivity("USSD: Transaction failed - " + text);
            handleFailure(text);
            clickButton(rootNode, "ok", "cancel", "dismiss");
            ussdStep = 0;
            return;
        }

        // Check for PIN prompt (universal — any provider)
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

        // Check for confirmation prompt (universal — any provider)
        if (lowerText.contains("confirm") || lowerText.contains("are you sure") ||
            lowerText.contains("you are sending") || lowerText.contains("you are about")) {
            logToActivity("USSD: Confirming transaction");
            enterTextAndSend(rootNode, "1");
            ussdStep++;
            return;
        }

        // Provider-specific menu navigation
        if (currentPayout == null) return;

        if (currentProvider.contains("Airtel")) {
            processAirtelStep(rootNode, lowerText);
        } else if (currentProvider.contains("M-Pesa")) {
            processMpesaStep(rootNode, lowerText);
        } else {
            // MTN and Tigo use shortcodes — the USSD code already contains phone+amount
            // So the only interactive steps are PIN (above) and confirmation (above)
            processShortcodeStep(rootNode, lowerText);
        }
    }

    /**
     * Airtel Money Uganda — *185# interactive menu navigation:
     *   Step 0: Main menu → select "1" (Customer Transaction)
     *   Step 1: Customer Transaction menu → select "1" (Cash Deposit)
     *   Step 2: Enter customer phone number
     *   Step 3: Enter amount
     *   (PIN and confirmation handled by universal detection above)
     */
    private void processAirtelStep(AccessibilityNodeInfo rootNode, String lowerText) {
        switch (ussdStep) {
            case 0:
                // Main menu: Select "Customer Transaction" (option 1)
                logToActivity("USSD Airtel: Selecting Customer Transaction (1)");
                enterTextAndSend(rootNode, "1");
                ussdStep++;
                break;
            case 1:
                // Customer Transaction submenu: Select "Cash Deposit" (option 1)
                logToActivity("USSD Airtel: Selecting Cash Deposit (1)");
                enterTextAndSend(rootNode, "1");
                ussdStep++;
                break;
            case 2:
                // Enter customer phone number
                logToActivity("USSD Airtel: Entering phone " + currentPayout.customer_phone);
                enterTextAndSend(rootNode, currentPayout.customer_phone);
                ussdStep++;
                break;
            case 3:
                // Enter amount
                String amount = String.valueOf((long) currentPayout.local_amount);
                logToActivity("USSD Airtel: Entering amount " + amount);
                enterTextAndSend(rootNode, amount);
                ussdStep++;
                break;
            default:
                // Steps 4+ are PIN and confirmation — handled by universal detection above
                logToActivity("USSD Airtel: Unexpected step " + ussdStep + ", entering 1");
                enterTextAndSend(rootNode, "1");
                ussdStep++;
                break;
        }
    }

    /**
     * M-Pesa Kenya — *150*00# interactive menu:
     *   Step 0: Enter phone number
     *   Step 1: Enter amount
     *   (PIN and confirmation handled by universal detection above)
     */
    private void processMpesaStep(AccessibilityNodeInfo rootNode, String lowerText) {
        switch (ussdStep) {
            case 0:
                logToActivity("USSD M-Pesa: Entering phone " + currentPayout.customer_phone);
                enterTextAndSend(rootNode, currentPayout.customer_phone);
                ussdStep++;
                break;
            case 1:
                String amount = String.valueOf((long) currentPayout.local_amount);
                logToActivity("USSD M-Pesa: Entering amount " + amount);
                enterTextAndSend(rootNode, amount);
                ussdStep++;
                break;
            default:
                logToActivity("USSD M-Pesa: Unexpected step " + ussdStep);
                enterTextAndSend(rootNode, "1");
                ussdStep++;
                break;
        }
    }

    /**
     * MTN / Tigo — shortcode format (*165*1*phone*amount#).
     * The shortcode already includes phone and amount, so the only
     * interactive steps are PIN entry and confirmation (handled above).
     * This fallback handles any unexpected intermediate screens.
     */
    private void processShortcodeStep(AccessibilityNodeInfo rootNode, String lowerText) {
        // For shortcode providers, if we reach here it's an unexpected menu
        logToActivity("USSD shortcode: Unexpected prompt at step " + ussdStep + ", entering 1");
        enterTextAndSend(rootNode, "1");
        ussdStep++;
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
