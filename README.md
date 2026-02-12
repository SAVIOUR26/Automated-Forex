# NgaboPay - Automated Forex Exchange via Binance P2P

Automated forex exchange system where customers buy USDT on Binance P2P and receive local currency (UGX/KES/TZS) via Mobile Money.

## How It Works

```
Customer pays USD on Binance P2P
    → System detects "Buyer Paid"
    → Calculates local currency (rate × USDT - fees)
    → Android app sends Mobile Money via USSD
    → Customer receives local currency on phone
    → Dealer releases USDT on Binance
```

## Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Backend** | Node.js + Express + SQLite | API, business logic, dashboard |
| **Binance Monitor** | Playwright + Chromium | Detects "Buyer Paid" orders |
| **Dashboard** | HTML/CSS/JS | Manage transactions, rates, monitor |
| **Telegram Bot** | Telegram Bot API | Real-time notifications |
| **Android App** | Java + Accessibility | USSD-based Mobile Money payouts |
| **Remote Browser** | noVNC + x11vnc | View Binance browser remotely |

## Quick Start (Local Development)

```bash
# 1. Clone and install
git clone <repo-url>
cd ngabopay
npm install
npx playwright install chromium

# 2. Configure
cp .env.example .env
# Edit .env with your credentials

# 3. Run
npm run seed     # Initialize database
npm run dev      # Start with hot reload
```

Dashboard: `http://localhost:3000`

## VPS Deployment (Ubuntu 22.04)

```bash
# Upload to VPS
scp -r . root@your-vps:/opt/ngabopay/

# Run setup
cd /opt/ngabopay
chmod +x scripts/setup-vps.sh
sudo ./scripts/setup-vps.sh

# Configure
nano /opt/ngabopay/.env   # Set your values
sudo systemctl restart ngabopay

# SSL
sudo certbot --nginx -d ngabopay.online
```

## Configuration (.env)

| Variable | Description | Example |
|----------|-------------|---------|
| `DEALER_USERNAME` | Dashboard login | `admin` |
| `DEALER_PASSWORD` | Dashboard password | `secure-pass` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather | `123456:ABC-DEF` |
| `TELEGRAM_CHAT_ID` | Your Telegram chat | `123456789` |
| `RATE_UGX` | UGX per 1 USDT | `3750` |
| `RATE_KES` | KES per 1 USDT | `152` |
| `FEE_PERCENT` | Your fee percentage | `2` |
| `DEVICE_API_KEY` | Key for modem engine / external devices | `random-string` |

## API Endpoints

### Dashboard (session auth)
- `GET /api/stats` - Dashboard statistics
- `GET /api/transactions` - List transactions
- `POST /api/transactions` - Manual transaction entry
- `PUT /api/transactions/:id/phone` - Set customer phone
- `POST /api/monitor/start` - Start Binance monitor
- `POST /api/monitor/stop` - Stop monitor
- `GET /api/monitor/screenshot` - Latest browser screenshot
- `GET/PUT /api/settings` - View/update settings

### Android App (API key auth)
- `GET /api/payout/pending` - Get pending payouts
- `POST /api/payout/start` - Mark payout as processing
- `POST /api/payout/complete` - Mark payout complete
- `POST /api/payout/failed` - Mark payout failed

## Android App Setup

1. Build the APK from `android-app/` using Android Studio
2. Install on your Android phone
3. Enable the NgaboPay Accessibility Service in phone settings
4. Enter server URL and API key in the app
5. Tap "Start Polling"

The app will poll for pending payouts and automatically dial USSD to send Mobile Money.

**Supported providers:**
- MTN Mobile Money (Uganda)
- Airtel Money (Uganda)
- M-Pesa (Kenya)
- Tigo Pesa (Tanzania)

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Dashboard   │────▶│  Express API │────▶│   SQLite DB  │
│  (Browser)   │◀────│  + WebSocket │◀────│              │
└─────────────┘     └──────┬───────┘     └──────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ Binance  │  │ Telegram │  │ Android  │
      │ Monitor  │  │   Bot    │  │   App    │
      │(Playwright)│ │          │  │  (USSD)  │
      └──────────┘  └──────────┘  └──────────┘
```

## Services (systemd)

| Service | Port | Purpose |
|---------|------|---------|
| `ngabopay` | 3000 | Main application |
| `ngabopay-xvfb` | - | Virtual display |
| `ngabopay-vnc` | 5900 | VNC server |
| `ngabopay-novnc` | 6080 | noVNC web client |

```bash
# Manage services
sudo systemctl status ngabopay
sudo systemctl restart ngabopay
sudo journalctl -u ngabopay -f    # View logs
```

## License

Private - All rights reserved.
