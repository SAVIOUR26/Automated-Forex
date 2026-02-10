#!/bin/bash
# ═══════════════════════════════════════════
# NgaboPay Update Script
# Pull latest code and restart services
# ═══════════════════════════════════════════

set -e

APP_DIR="/opt/ngabopay"
BRANCH="${1:-main}"

echo "╔══════════════════════════════════════╗"
echo "║     NgaboPay System Update           ║"
echo "╚══════════════════════════════════════╝"
echo ""

cd "$APP_DIR"

# Backup .env before pull
echo "[1/5] Backing up .env..."
cp -f .env .env.backup 2>/dev/null || true

# Pull latest code
echo "[2/5] Pulling latest code from $BRANCH..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Restore .env from backup
cp -f .env.backup .env 2>/dev/null || true

# Install/update dependencies
echo "[3/5] Installing dependencies..."
npm install --production

# Run database migrations (safe - only adds missing tables/columns)
echo "[4/5] Running database migrations..."
node -e "require('./src/models/migrate').migrate(); require('./src/models/seed').seed(); console.log('DB ready.');"

# Set ownership
chown -R ngabopay:ngabopay "$APP_DIR"

# Restart services
echo "[5/5] Restarting services..."
systemctl restart ngabopay-xvfb
sleep 1
systemctl restart ngabopay-vnc
sleep 1
systemctl restart ngabopay-novnc
sleep 1
systemctl restart ngabopay

echo ""
echo "Update complete! Checking status..."
echo ""
echo "--- ngabopay ---"
systemctl status ngabopay --no-pager -l | head -10
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
