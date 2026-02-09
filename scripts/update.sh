#!/bin/bash
# ═══════════════════════════════════════════
# NgaboPay Update Script
# Pull latest code and restart services
# ═══════════════════════════════════════════

set -e

APP_DIR="/opt/ngabopay"

echo "Updating NgaboPay..."

cd "$APP_DIR"

# Pull latest code
git pull origin main

# Install deps
npm install --production

# Run migrations
node src/models/seed.js

# Set ownership
chown -R ngabopay:ngabopay "$APP_DIR"

# Restart service
systemctl restart ngabopay

echo "Update complete! Service restarted."
systemctl status ngabopay --no-pager
