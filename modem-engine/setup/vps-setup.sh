#!/bin/bash
# ═══════════════════════════════════════════════════════════
# NgaboPay Modem Engine — One-Command VPS Setup
# ═══════════════════════════════════════════════════════════
#
# Usage:
#   bash /root/Automated-Forex/modem-engine/setup/vps-setup.sh
#
# What this does:
#   1. Installs system deps (socat, python3-venv)
#   2. Sets up Python virtual env + pip packages
#   3. Creates .env from template (you only edit MM_PIN after)
#   4. Installs systemd services
#   5. Starts the USSD engine
#
# Prerequisites:
#   - Tailscale already installed and connected
#   - Repo cloned at /root/Automated-Forex
# ═══════════════════════════════════════════════════════════

set -e

REPO_DIR="/root/Automated-Forex"
ENGINE_DIR="${REPO_DIR}/modem-engine"

echo ""
echo "═══════════════════════════════════════════════"
echo "  NgaboPay Modem Engine Setup"
echo "═══════════════════════════════════════════════"
echo ""

# ─── Check repo exists ────────────────────────────────────
if [ ! -d "$ENGINE_DIR" ]; then
    echo "ERROR: $ENGINE_DIR not found."
    echo "Clone the repo first:"
    echo "  cd /root && git clone <repo-url> Automated-Forex"
    exit 1
fi

cd "$ENGINE_DIR"

# ─── Step 1: System dependencies ─────────────────────────
echo "[1/5] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq socat python3.12-venv python3-pip 2>/dev/null || \
apt-get install -y -qq socat python3-venv python3-pip

# ─── Step 2: Python virtual environment ──────────────────
echo "[2/5] Setting up Python environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt
echo "  Installed: $(pip list --format=freeze | wc -l) packages"

# ─── Step 3: Create .env config ──────────────────────────
echo "[3/5] Configuring environment..."
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "  Created .env from template"
    echo ""
    echo "  ┌─────────────────────────────────────────┐"
    echo "  │  IMPORTANT: Edit your Airtel Money PIN   │"
    echo "  │                                          │"
    echo "  │  nano ${ENGINE_DIR}/.env                 │"
    echo "  │  Change MM_PIN=1234 to your real PIN     │"
    echo "  └─────────────────────────────────────────┘"
    echo ""
else
    echo "  .env already exists, skipping"
fi

# Also ensure NgaboPay .env has DEVICE_API_KEY
NGABO_ENV="${REPO_DIR}/.env"
if [ -f "$NGABO_ENV" ]; then
    if ! grep -q "DEVICE_API_KEY" "$NGABO_ENV"; then
        echo "DEVICE_API_KEY=ngp-modem-8f3a1c9d7e2b4a6f0d5c" >> "$NGABO_ENV"
        echo "  Added DEVICE_API_KEY to NgaboPay .env"
    else
        echo "  NgaboPay .env already has DEVICE_API_KEY"
    fi
else
    echo "  WARNING: ${NGABO_ENV} not found. Create it from .env.example"
fi

# ─── Step 4: Install systemd services ───────────────────
echo "[4/5] Installing systemd services..."
cp "${ENGINE_DIR}/setup/vps-bridge.service" /etc/systemd/system/modem-bridge.service
cp "${ENGINE_DIR}/setup/ussd-engine.service" /etc/systemd/system/ussd-engine.service
systemctl daemon-reload
systemctl enable modem-bridge ussd-engine
echo "  Services installed and enabled"

# ─── Step 5: Start services ─────────────────────────────
echo "[5/5] Starting services..."

# Start modem bridge (will wait for laptop connection)
systemctl restart modem-bridge 2>/dev/null || true
echo "  modem-bridge: $(systemctl is-active modem-bridge 2>/dev/null || echo 'waiting for laptop connection')"

# Start USSD engine
systemctl restart ussd-engine 2>/dev/null || true
sleep 2
echo "  ussd-engine:  $(systemctl is-active ussd-engine 2>/dev/null || echo 'starting...')"

# ─── Health check ────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
if curl -s http://localhost:7001/health > /dev/null 2>&1; then
    echo "  USSD Engine is RUNNING on port 7001"
    curl -s http://localhost:7001/health | python3 -m json.tool 2>/dev/null || true
else
    echo "  Engine not responding yet (may need modem connection)"
    echo "  Check logs: journalctl -u ussd-engine -f"
fi
echo ""
echo "═══════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Edit MM_PIN:  nano ${ENGINE_DIR}/.env"
echo "  2. On Windows laptop: run com2tcp and Tailscale"
echo "  3. Check status:  systemctl status ussd-engine"
echo "  4. View logs:     journalctl -u ussd-engine -f"
echo ""
