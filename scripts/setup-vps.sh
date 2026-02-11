#!/bin/bash
# ═══════════════════════════════════════════════════════════
# NgaboPay VPS Setup Script
# Fresh server deployment — clones repo, installs everything
# Tested on: Ubuntu 22.04 / Debian 12
# ═══════════════════════════════════════════════════════════

set -e

DOMAIN="${DOMAIN:-ngabopay.online}"
APP_DIR="/opt/ngabopay"
APP_USER="ngabopay"
REPO_URL="https://github.com/SAVIOUR26/Automated-Forex.git"
BRANCH="${BRANCH:-master}"

echo "╔══════════════════════════════════════════════╗"
echo "║       NgaboPay VPS Setup Script              ║"
echo "║  Domain: $DOMAIN                             ║"
echo "║  Branch: $BRANCH                             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── 1. System Updates & Dependencies ─────────────────────
echo "[1/9] Updating system and installing dependencies..."
apt-get update -y
apt-get upgrade -y
apt-get install -y curl wget git build-essential nginx certbot python3-certbot-nginx \
  ufw supervisor xvfb x11vnc novnc websockify \
  fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
  libgbm1 libnss3 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
  libcairo2 libasound2

# ─── 2. Set Timezone to Singapore ──────────────────────────
echo "[2/9] Setting timezone to Asia/Singapore..."
timedatectl set-timezone Asia/Singapore
echo "Timezone: $(timedatectl show --property=Timezone --value)"

# ─── 3. Install Node.js 20 LTS ────────────────────────────
echo "[3/9] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js: $(node -v) | npm: $(npm -v)"

# ─── 4. Create App User ───────────────────────────────────
echo "[4/9] Setting up application user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
fi

# ─── 5. Clone Repo & Install App ──────────────────────────
echo "[5/9] Cloning repository and installing app..."

if [ -d "$APP_DIR/.git" ]; then
  echo "  Repo already exists, pulling latest..."
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "  Cloning fresh from GitHub..."
  rm -rf "$APP_DIR"
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# Install Node dependencies
npm install --production

# Install Playwright Chromium + system deps
npx playwright install chromium
npx playwright install-deps chromium

# Create data directories
mkdir -p "$APP_DIR/data/screenshots"
mkdir -p "$APP_DIR/browser-data"

# Create .env from example if not exists
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"

  # Generate secure random secrets
  SESSION_SECRET=$(openssl rand -hex 32)
  sed -i "s/change-me-to-random-string/$SESSION_SECRET/" "$APP_DIR/.env"

  ANDROID_KEY=$(openssl rand -hex 16)
  sed -i "s/change-me-android-key/$ANDROID_KEY/" "$APP_DIR/.env"

  DEALER_PASS=$(openssl rand -base64 16)
  sed -i "s/change-me-secure-password/$DEALER_PASS/" "$APP_DIR/.env"

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  AUTO-GENERATED CREDENTIALS (save these!)               ║"
  echo "║                                                          ║"
  echo "║  Dashboard Login:                                        ║"
  echo "║    Username: admin                                       ║"
  echo "║    Password: $DEALER_PASS"
  echo "║                                                          ║"
  echo "║  Android API Key: $ANDROID_KEY"
  echo "║                                                          ║"
  echo "║  Config file: $APP_DIR/.env                              ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
fi

# Run database migration & seed
node -e "require('./src/models/migrate').migrate(); require('./src/models/seed').seed(); console.log('Database ready.');"

# Set ownership
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ─── 6. Create Systemd Services ───────────────────────────
echo "[6/9] Creating systemd services..."

cat > /etc/systemd/system/ngabopay.service << 'SERVICEEOF'
[Unit]
Description=NgaboPay Forex Exchange
After=network.target ngabopay-xvfb.service
Requires=ngabopay-xvfb.service

[Service]
Type=simple
User=ngabopay
WorkingDirectory=/opt/ngabopay
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=DISPLAY=:99
EnvironmentFile=/opt/ngabopay/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ngabopay

# Security
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/ngabopay/data /opt/ngabopay/browser-data /tmp /home/ngabopay

[Install]
WantedBy=multi-user.target
SERVICEEOF

# Xvfb virtual display (required for Playwright/Chromium)
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

# VNC server (local only — accessed via noVNC)
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

# noVNC web proxy (local only — proxied through Nginx)
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

# ─── 7. Configure Nginx ───────────────────────────────────
echo "[7/9] Configuring Nginx reverse proxy..."

cat > /etc/nginx/sites-available/ngabopay << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    # After SSL cert is obtained, uncomment to force HTTPS:
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

    # noVNC — protected by dashboard cookie auth
    location /novnc/ {
        auth_request /auth-check;
        auth_request_set \$auth_status \$upstream_status;

        proxy_pass http://127.0.0.1:6080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Internal auth check — returns 200 if logged in
    location = /auth-check {
        internal;
        proxy_pass http://127.0.0.1:3000/api/monitor/status;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Cookie \$http_cookie;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/ngabopay /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# ─── 8. Configure Firewall ────────────────────────────────
echo "[8/9] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ─── 9. Start All Services ────────────────────────────────
echo "[9/9] Starting services..."
systemctl start ngabopay-xvfb
sleep 1
systemctl start ngabopay-vnc
sleep 1
systemctl start ngabopay-novnc
sleep 1
systemctl start ngabopay

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                NgaboPay Setup Complete!                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║  Dashboard: http://$DOMAIN                                   ║"
echo "║  Timezone:  Asia/Singapore (for Binance access)              ║"
echo "║                                                              ║"
echo "║  NEXT STEPS:                                                 ║"
echo "║                                                              ║"
echo "║  1. Point your domain DNS A record to this server IP         ║"
echo "║     $DOMAIN → $(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_IP')  ║"
echo "║                                                              ║"
echo "║  2. Wait for DNS propagation (5-30 min), then get SSL:       ║"
echo "║     certbot --nginx -d $DOMAIN -d www.$DOMAIN               ║"
echo "║                                                              ║"
echo "║  3. Edit credentials if needed:                              ║"
echo "║     nano $APP_DIR/.env                                       ║"
echo "║     systemctl restart ngabopay                               ║"
echo "║                                                              ║"
echo "║  4. Open dashboard, login, launch browser, log into Binance  ║"
echo "║                                                              ║"
echo "║  5. Scan QR code from Android app to pair the phone          ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Service status:"
systemctl status ngabopay --no-pager -l | head -5
