#!/bin/bash
# ═══════════════════════════════════════════
# NgaboPay Update Script
# Pull latest code and restart services
# ═══════════════════════════════════════════

set -e

APP_DIR="/opt/ngabopay"

cd "$APP_DIR"

# Auto-detect current branch, or use argument, or default to main
if [ -n "$1" ]; then
  BRANCH="$1"
else
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
fi

echo "╔══════════════════════════════════════╗"
echo "║     NgaboPay System Update           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Backup .env files before pull
echo "[1/7] Backing up .env files..."
cp -f .env .env.backup 2>/dev/null || true
cp -f modem-engine/.env modem-engine/.env.backup 2>/dev/null || true

# Pull latest code
echo "[2/7] Pulling latest code from $BRANCH..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Restore .env files from backup
cp -f .env.backup .env 2>/dev/null || true
cp -f modem-engine/.env.backup modem-engine/.env 2>/dev/null || true

# Install/update Node.js dependencies
echo "[3/7] Installing Node.js dependencies..."
npm install --production

# Update USSD modem engine Python dependencies
echo "[4/7] Updating USSD modem engine dependencies..."
if [ -d "$APP_DIR/modem-engine/venv" ]; then
  cd "$APP_DIR/modem-engine"
  ./venv/bin/pip install -r requirements.txt -q
  cd "$APP_DIR"
else
  echo "  Modem engine venv not found — run setup-vps.sh first or create it:"
  echo "  cd $APP_DIR/modem-engine && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
fi

# Run database migrations (safe - only adds missing tables/columns)
echo "[5/7] Running database migrations..."
node -e "require('./src/models/migrate').migrate(); require('./src/models/seed').seed(); console.log('DB ready.');"

# Set ownership (only if ngabopay user exists)
if id ngabopay &>/dev/null; then
  chown -R ngabopay:ngabopay "$APP_DIR"
fi

# Restart services
echo "[6/7] Restarting services..."
systemctl restart ngabopay-xvfb
sleep 1
systemctl restart ngabopay-vnc
sleep 1
systemctl restart ngabopay-novnc
sleep 1
systemctl restart ngabopay
sleep 1

# Restart USSD engine (only if service exists)
if systemctl list-unit-files | grep -q ngabopay-ussd-engine; then
  echo "[7/7] Restarting USSD modem engine..."
  systemctl restart ngabopay-ussd-engine
else
  echo "[7/7] USSD engine service not installed — skipping"
fi

echo ""
echo "Update complete! Checking status..."
echo ""
echo "--- ngabopay ---"
systemctl status ngabopay --no-pager -l | head -10
echo ""
echo "--- ussd-engine ---"
systemctl status ngabopay-ussd-engine --no-pager -l 2>/dev/null | head -10 || echo "  (not installed)"
echo ""
echo "--- xvfb ---"
systemctl status ngabopay-xvfb --no-pager -l | head -5
echo ""
echo "--- vnc ---"
systemctl status ngabopay-vnc --no-pager -l | head -5
echo ""
echo "--- novnc ---"
systemctl status ngabopay-novnc --no-pager -l | head -5
echo ""
echo "All services restarted. Dashboard: https://ngabopay.online"
