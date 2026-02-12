"""
Provider-specific USSD flows for mobile money payouts.

Each provider class implements the full send_money flow:
dial code → navigate menus → enter phone → enter amount → PIN → confirm.
"""

import re
import logging
from modem import GSMModem, UssdTimeout, ModemError

logger = logging.getLogger("providers")


class UssdFlowError(Exception):
    pass


# ─── Result Helpers ───────────────────────────────────────

SUCCESS_KEYWORDS = [
    "successful", "confirmed", "has been sent", "sent to",
    "completed", "approved", "processed",
]
FAILURE_KEYWORDS = [
    "failed", "error", "insufficient", "invalid", "denied",
    "not allowed", "exceeded", "wrong", "blocked", "rejected",
]


def _is_success(text: str) -> bool:
    lower = text.lower()
    return any(k in lower for k in SUCCESS_KEYWORDS)


def _is_failure(text: str) -> bool:
    lower = text.lower()
    return any(k in lower for k in FAILURE_KEYWORDS)


def _is_pin_prompt(text: str) -> bool:
    lower = text.lower()
    return "pin" in lower or "password" in lower or "enter your" in lower


def _is_confirm_prompt(text: str) -> bool:
    lower = text.lower()
    return any(k in lower for k in [
        "confirm", "are you sure", "you are sending", "you are about",
    ])


def _extract_reference(text: str) -> str:
    """Try to extract a transaction reference from USSD response text."""
    m = re.search(
        r"(?:ref|txn|transaction|id|reference)[:\s]*([A-Z0-9]{6,20})",
        text,
        re.IGNORECASE,
    )
    return m.group(1) if m else "USSD-OK"


def _ok(text: str, responses: list) -> dict:
    return {
        "success": True,
        "reference": _extract_reference(text),
        "message": text,
        "steps": responses,
    }


def _fail(reason: str, responses: list) -> dict:
    return {
        "success": False,
        "reason": reason,
        "steps": responses,
    }


# ─── Dynamic PIN / Confirm Handler ───────────────────────

def _handle_dynamic_steps(modem: GSMModem, resp: dict, pin: str, responses: list, max_steps: int = 4) -> dict:
    """
    After the menu-specific steps, handle dynamic prompts:
    PIN entry, confirmation, and final success/failure detection.
    """
    for _ in range(max_steps):
        text = resp["text"]

        if _is_success(text):
            return _ok(text, responses)

        if _is_failure(text):
            return _fail(text, responses)

        if _is_pin_prompt(text):
            if not pin:
                modem.cancel_ussd()
                return _fail("Mobile Money PIN not configured", responses)
            logger.info("Entering PIN")
            resp = modem.reply_ussd(pin)
            responses.append(resp)
            continue

        if _is_confirm_prompt(text):
            logger.info("Confirming transaction")
            resp = modem.reply_ussd("1")
            responses.append(resp)
            continue

        # Session ended (status 0) without clear keyword
        if resp["status"] == 0:
            # If we got far enough, treat as success
            return _ok(text, responses) if len(responses) >= 5 else _fail(f"Session ended: {text}", responses)

        # Unexpected interactive prompt — try '1'
        logger.warning(f"Unexpected USSD prompt, sending '1': {text[:80]}")
        resp = modem.reply_ussd("1")
        responses.append(resp)

    modem.cancel_ussd()
    return _fail("Too many USSD steps without resolution", responses)


# ─── Airtel Money Uganda (*185#) ──────────────────────────

class AirtelUgandaFlow:
    """
    Airtel Money Uganda — *185# interactive menu:
      Step 0: Dial *185# → main menu
      Step 1: Select "Customer Transaction" → enter "1"
      Step 2: Select "Cash Deposit" → enter "1"
      Step 3: Enter customer phone number
      Step 4: Enter amount
      Step 5+: PIN → Confirm (handled dynamically)
    """

    def send_money(self, modem: GSMModem, phone: str, amount: int, pin: str) -> dict:
        responses = []

        try:
            # Step 0: Dial *185#
            logger.info("Airtel: Dialing *185#")
            resp = modem.send_ussd("*185#")
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            # Step 1: Select "Customer Transaction" (option 1)
            logger.info("Airtel: Selecting Customer Transaction (1)")
            resp = modem.reply_ussd("1")
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            # Step 2: Select "Cash Deposit" (option 1)
            logger.info("Airtel: Selecting Cash Deposit (1)")
            resp = modem.reply_ussd("1")
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            # Step 3: Enter phone number
            logger.info(f"Airtel: Entering phone {phone}")
            resp = modem.reply_ussd(phone)
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            # Step 4: Enter amount
            logger.info(f"Airtel: Entering amount {amount}")
            resp = modem.reply_ussd(str(amount))
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            # Steps 5+: PIN, confirm, result (dynamic)
            return _handle_dynamic_steps(modem, resp, pin, responses)

        except UssdTimeout as e:
            modem.cancel_ussd()
            return _fail(f"USSD timeout: {e}", responses)
        except ModemError as e:
            modem.cancel_ussd()
            return _fail(f"Modem error: {e}", responses)


# ─── MTN Uganda (*165*1*phone*amount#) ────────────────────

class MTNUgandaFlow:
    """
    MTN Mobile Money Uganda — shortcode format.
    All info is in the dial code, interactive steps are just PIN + confirm.
    """

    def send_money(self, modem: GSMModem, phone: str, amount: int, pin: str) -> dict:
        responses = []

        try:
            code = f"*165*1*{phone}*{amount}#"
            logger.info(f"MTN: Dialing {code}")
            resp = modem.send_ussd(code)
            responses.append(resp)

            return _handle_dynamic_steps(modem, resp, pin, responses)

        except UssdTimeout as e:
            modem.cancel_ussd()
            return _fail(f"USSD timeout: {e}", responses)
        except ModemError as e:
            modem.cancel_ussd()
            return _fail(f"Modem error: {e}", responses)


# ─── M-Pesa Kenya (*150*00#) ──────────────────────────────

class MPesaKenyaFlow:
    """
    M-Pesa Kenya — *150*00# interactive:
      Step 0: Dial *150*00# → prompt for phone
      Step 1: Enter phone number
      Step 2: Enter amount
      Step 3+: PIN → Confirm (dynamic)
    """

    def send_money(self, modem: GSMModem, phone: str, amount: int, pin: str) -> dict:
        responses = []

        try:
            logger.info("M-Pesa: Dialing *150*00#")
            resp = modem.send_ussd("*150*00#")
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            logger.info(f"M-Pesa: Entering phone {phone}")
            resp = modem.reply_ussd(phone)
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            logger.info(f"M-Pesa: Entering amount {amount}")
            resp = modem.reply_ussd(str(amount))
            responses.append(resp)
            if _is_failure(resp["text"]):
                return _fail(resp["text"], responses)

            return _handle_dynamic_steps(modem, resp, pin, responses)

        except UssdTimeout as e:
            modem.cancel_ussd()
            return _fail(f"USSD timeout: {e}", responses)
        except ModemError as e:
            modem.cancel_ussd()
            return _fail(f"Modem error: {e}", responses)


# ─── Tigo Tanzania (*150*01*phone*amount#) ────────────────

class TigoTanzaniaFlow:
    """Tigo Pesa Tanzania — shortcode format like MTN."""

    def send_money(self, modem: GSMModem, phone: str, amount: int, pin: str) -> dict:
        responses = []

        try:
            code = f"*150*01*{phone}*{amount}#"
            logger.info(f"Tigo: Dialing {code}")
            resp = modem.send_ussd(code)
            responses.append(resp)

            return _handle_dynamic_steps(modem, resp, pin, responses)

        except UssdTimeout as e:
            modem.cancel_ussd()
            return _fail(f"USSD timeout: {e}", responses)
        except ModemError as e:
            modem.cancel_ussd()
            return _fail(f"Modem error: {e}", responses)


# ─── Factory ──────────────────────────────────────────────

PROVIDERS = {
    "airtel_ug": AirtelUgandaFlow,
    "mtn_ug": MTNUgandaFlow,
    "mpesa_ke": MPesaKenyaFlow,
    "tigo_tz": TigoTanzaniaFlow,
}


def get_provider_flow(provider: str):
    """Return the flow class instance for the given provider key."""
    cls = PROVIDERS.get(provider)
    if not cls:
        raise ValueError(f"Unknown provider: {provider}. Available: {list(PROVIDERS.keys())}")
    return cls()
