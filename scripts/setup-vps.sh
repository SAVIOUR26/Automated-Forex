#!/bin/bash
# ═══════════════════════════════════════════════════════════
# NgaboPay VPS Setup Script
# Ubuntu 22.04 - Full deployment setup
# ═══════════════════════════════════════════════════════════

set -e

DOMAIN="${DOMAIN:-ngabopay.online}"
APP_DIR="/opt/ngabopay"
APP_USER="ngabopay"

echo "╔══════════════════════════════════════╗"
echo "║     NgaboPay VPS Setup Script        ║"
echo "║     Domain: $DOMAIN                  ║"
echo "╚══════════════════════════════════════╝"

# ─── System Updates ───────────────────────────────────────
echo "[1/8] Updating system packages..."
apt-get update -y
apt-get upgrade -y
apt-get install -y curl wget git build-essential nginx certbot python3-certbot-nginx \
  ufw supervisor xvfb x11vnc novnc websockify \
  fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
  libgbm1 libnss3 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
  libcairo2 libasound2

# ─── Node.js 20 LTS ──────────────────────────────────────
echo "[2/8] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

# ─── Create App User ─────────────────────────────────────
echo "[3/8] Setting up application user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
fi

# ─── Deploy Application ──────────────────────────────────
echo "[4/8] Deploying application..."
mkdir -p "$APP_DIR"
cp -r . "$APP_DIR/"
cd "$APP_DIR"
npm install --production

# Install Playwright browsers
npx playwright install chromium
npx playwright install-deps chromium

# Create data directory
mkdir -p "$APP_DIR/data/screenshots"

# Create .env from example if not exists
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Generate random session secret
  SESSION_SECRET=$(openssl rand -hex 32)
  sed -i "s/change-me-to-random-string/$SESSION_SECRET/" "$APP_DIR/.env"
  ANDROID_KEY=$(openssl rand -hex 16)
  sed -i "s/change-me-android-key/$ANDROID_KEY/" "$APP_DIR/.env"
  echo ""
  echo ">>> IMPORTANT: Edit $APP_DIR/.env with your actual values!"
  echo ">>> Generated Android API Key: $ANDROID_KEY"
  echo ""
fi

# Run database migration
node "$APP_DIR/src/models/seed.js"

# Set ownership
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ─── Systemd Service ─────────────────────────────────────
echo "[5/8] Creating systemd services..."

cat > /etc/systemd/system/ngabopay.service << 'SERVICEEOF'
[Unit]
Description=NgaboPay Forex Exchange
After=network.target

[Service]
Type=simple
User=ngabopay
WorkingDirectory=/opt/ngabopay
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/ngabopay/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ngabopay

# Security
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/ngabopay/data /opt/ngabopay/browser-data

[Install]
WantedBy=multi-user.target
SERVICEEOF

# ─── Xvfb + VNC for browser viewing ──────────────────────
cat > /etc/systemd/system/ngabopay-xvfb.service << 'XVFBEOF'
[Unit]
Description=NgaboPay Xvfb Display
Before=ngabopay.service

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -ac
Restart=always

[Install]
WantedBy=multi-user.target
XVFBEOF

cat > /etc/systemd/system/ngabopay-vnc.service << 'VNCEOF'
[Unit]
Description=NgaboPay VNC Server
After=ngabopay-xvfb.service

[Service]
Type=simple
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -forever -nopw -listen localhost -rfbport 5900
Restart=always

[Install]
WantedBy=multi-user.target
VNCEOF

cat > /etc/systemd/system/ngabopay-novnc.service << 'NOVNCEOF'
[Unit]
Description=NgaboPay noVNC WebSocket Proxy
After=ngabopay-vnc.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web /usr/share/novnc 6080 localhost:5900
Restart=always

[Install]
WantedBy=multi-user.target
NOVNCEOF

systemctl daemon-reload
systemctl enable ngabopay ngabopay-xvfb ngabopay-vnc ngabopay-novnc

# ─── Nginx Configuration ─────────────────────────────────
echo "[6/8] Configuring Nginx..."

cat > /etc/nginx/sites-available/ngabopay << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    # Redirect to HTTPS (after cert is obtained)
    # return 301 https://\$host\$request_uri;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }

    # noVNC (protected by app auth)
    location /novnc/ {
        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/ngabopay /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl restart nginx

# ─── Firewall ────────────────────────────────────────────
echo "[7/8] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ─── SSL Certificate ─────────────────────────────────────
echo "[8/8] SSL Certificate..."
echo "Run the following to obtain SSL:"
echo "  certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo ""

# ─── Start Services ──────────────────────────────────────
echo "Starting services..."
systemctl start ngabopay-xvfb
systemctl start ngabopay-vnc
systemctl start ngabopay-novnc
systemctl start ngabopay

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║            NgaboPay Setup Complete!                  ║"
echo "║────────────────────────────────────────────────────  ║"
echo "║  Dashboard: http://$DOMAIN                          ║"
echo "║  noVNC:     http://$DOMAIN:6080/vnc.html            ║"
echo "║                                                      ║"
echo "║  NEXT STEPS:                                         ║"
echo "║  1. Edit /opt/ngabopay/.env with your credentials    ║"
echo "║  2. Run: certbot --nginx -d $DOMAIN                  ║"
echo "║  3. Restart: systemctl restart ngabopay              ║"
echo "║  4. Open dashboard and login                         ║"
echo "║  5. Start monitor from dashboard                     ║"
echo "║  6. Log into Binance in the browser                  ║"
echo "╚══════════════════════════════════════════════════════╝"
