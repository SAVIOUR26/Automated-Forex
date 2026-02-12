"""
GSM Modem handler — serial communication via AT commands.

Connects to a modem (physical USB or virtual serial via socat),
sends AT commands, and manages interactive USSD sessions.
"""

import serial
import threading
import re
import time
import logging

logger = logging.getLogger("modem")


class ModemError(Exception):
    pass


class UssdTimeout(ModemError):
    pass


class GSMModem:
    def __init__(self, port: str, baud: int = 115200):
        self.port_path = port
        self.baud_rate = baud
        self.serial: serial.Serial | None = None
        self.lock = threading.Lock()
        self.connected = False
        self.signal: int | None = None
        self.operator: str | None = None

    # ─── Connection ───────────────────────────────────────

    def connect(self):
        """Open serial port and initialize modem with AT commands."""
        logger.info(f"Connecting to {self.port_path} @ {self.baud_rate}...")

        self.serial = serial.Serial(
            port=self.port_path,
            baudrate=self.baud_rate,
            timeout=0.5,
            write_timeout=5,
        )
        # Flush any stale data
        self.serial.reset_input_buffer()
        self.serial.reset_output_buffer()

        # Initialize
        self._send_at("AT")                         # Test modem alive
        self._send_at("ATE0")                       # Disable echo
        self._send_at("AT+CMGF=1")                  # SMS text mode (diagnostic)
        self._send_at("AT+CUSD=1")                  # Enable USSD notifications
        self._send_at("AT+CNMI=0,0,0,0,0")          # Suppress incoming SMS during USSD

        # Query modem info
        self.signal = self._query_signal()
        self.operator = self._query_operator()

        self.connected = True
        logger.info(
            f"Modem ready | Operator: {self.operator or 'Unknown'} | "
            f"Signal: {self.signal}/31 ({self._signal_percent()}%)"
        )

    def disconnect(self):
        """Close serial connection."""
        self.connected = False
        if self.serial and self.serial.is_open:
            try:
                self.serial.close()
            except Exception:
                pass
        logger.info("Modem disconnected")

    def is_connected(self) -> bool:
        return self.connected and self.serial is not None and self.serial.is_open

    def get_status(self) -> dict:
        """Return current modem status dict."""
        if self.is_connected():
            self.signal = self._query_signal()

        return {
            "connected": self.is_connected(),
            "signal": self.signal,
            "signal_percent": self._signal_percent(),
            "operator": self.operator,
            "port": self.port_path,
        }

    # ─── AT Commands ──────────────────────────────────────

    def _send_at(self, command: str, timeout: float = 10) -> str:
        """Send an AT command, wait for OK or ERROR. Returns buffered text."""
        with self.lock:
            self.serial.reset_input_buffer()
            self.serial.write((command + "\r").encode())

            ok_re = re.compile(r"OK\r?\n?")
            err_re = re.compile(r"(ERROR|\+CM[ES] ERROR[^\r\n]*)\r?\n?")

            buf = ""
            start = time.time()
            while time.time() - start < timeout:
                if self.serial.in_waiting:
                    chunk = self.serial.read(self.serial.in_waiting)
                    buf += chunk.decode("ascii", errors="replace")

                if ok_re.search(buf):
                    return buf
                if err_re.search(buf):
                    raise ModemError(f"AT command '{command}' error: {buf.strip()}")

                time.sleep(0.05)

            raise ModemError(f"AT command '{command}' timeout ({timeout}s). Buffer: {buf[:200]}")

    def _read_until_cusd(self, timeout: float = 30) -> dict:
        """Read serial data until a +CUSD response arrives."""
        cusd_re = re.compile(r"\+CUSD:\s*(\d+),\"(.*?)\"(?:,(\d+))?", re.DOTALL)

        buf = ""
        start = time.time()
        while time.time() - start < timeout:
            if self.serial.in_waiting:
                chunk = self.serial.read(self.serial.in_waiting)
                buf += chunk.decode("ascii", errors="replace")

            m = cusd_re.search(buf)
            if m:
                status = int(m.group(1))
                text = m.group(2)
                dcs = int(m.group(3)) if m.group(3) else 15

                if dcs in (72, 68):
                    text = _decode_ucs2(text)

                return {"status": status, "text": text, "dcs": dcs}

            time.sleep(0.05)

        raise UssdTimeout(f"No +CUSD response within {timeout}s. Buffer: {buf[:200]}")

    # ─── USSD ─────────────────────────────────────────────

    def send_ussd(self, code: str, timeout: float = 30) -> dict:
        """
        Send a USSD code (e.g. *185#) and wait for the network response.

        Returns dict: {"status": int, "text": str, "dcs": int}
          status 0 = session ended (no further input accepted)
          status 1 = session open (waiting for user input)
          status 2 = operation not supported
        """
        with self.lock:
            self.serial.reset_input_buffer()
            cmd = f'AT+CUSD=1,"{code}",15\r'
            self.serial.write(cmd.encode())

            # Wait for OK (command accepted by modem)
            buf = ""
            ok_re = re.compile(r"OK\r?\n?")
            err_re = re.compile(r"(ERROR|\+CM[ES] ERROR[^\r\n]*)\r?\n?")
            start = time.time()
            while time.time() - start < 10:
                if self.serial.in_waiting:
                    chunk = self.serial.read(self.serial.in_waiting)
                    buf += chunk.decode("ascii", errors="replace")
                if ok_re.search(buf):
                    break
                if err_re.search(buf):
                    raise ModemError(f"USSD command rejected: {buf.strip()}")
                time.sleep(0.05)

            # Now wait for the async +CUSD network response
            return self._read_until_cusd(timeout)

    def reply_ussd(self, text: str, timeout: float = 30) -> dict:
        """Reply to an active USSD session. Same AT mechanism as send_ussd."""
        return self.send_ussd(text, timeout)

    def cancel_ussd(self):
        """Cancel any active USSD session."""
        try:
            with self.lock:
                self.serial.write(b"AT+CUSD=2\r")
                time.sleep(0.5)
                self.serial.reset_input_buffer()
        except Exception as e:
            logger.warning(f"Cancel USSD failed: {e}")

    # ─── Queries ──────────────────────────────────────────

    def _query_signal(self) -> int | None:
        try:
            resp = self._send_at("AT+CSQ", timeout=5)
            m = re.search(r"\+CSQ:\s*(\d+)", resp)
            return int(m.group(1)) if m else None
        except Exception:
            return self.signal

    def _query_operator(self) -> str | None:
        try:
            resp = self._send_at("AT+COPS?", timeout=5)
            m = re.search(r'\+COPS:.*?"(.+?)"', resp)
            return m.group(1) if m else None
        except Exception:
            return self.operator

    def _signal_percent(self) -> int:
        if self.signal is None or self.signal == 99:
            return 0
        return min(100, round(self.signal / 31 * 100))


def _decode_ucs2(hex_str: str) -> str:
    """Decode a UCS2 hex-encoded string (DCS 72/68) to UTF-8."""
    try:
        result = ""
        for i in range(0, len(hex_str), 4):
            result += chr(int(hex_str[i : i + 4], 16))
        return result
    except Exception:
        return hex_str
