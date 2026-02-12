"""Configuration loaded from environment variables / .env file."""

import os
from pathlib import Path

# Load .env if present
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


class Config:
    # NgaboPay server (VPS)
    ngabopay_url: str = os.getenv("NGABOPAY_URL", "http://localhost:3000")
    api_key: str = os.getenv("API_KEY", "")

    # GSM Modem
    modem_port: str = os.getenv("MODEM_PORT", "/dev/ttyVMODEM")
    modem_baud: int = int(os.getenv("MODEM_BAUD", "115200"))

    # Mobile Money
    mm_pin: str = os.getenv("MM_PIN", "")
    ussd_provider: str = os.getenv("USSD_PROVIDER", "airtel_ug")

    # Engine server
    engine_host: str = os.getenv("ENGINE_HOST", "0.0.0.0")
    engine_port: int = int(os.getenv("ENGINE_PORT", "7001"))
