@echo off
REM ═══════════════════════════════════════════════════
REM  NgaboPay USSD Modem Engine — Windows Setup
REM  Run this once to set up the Python environment
REM ═══════════════════════════════════════════════════

echo.
echo ╔══════════════════════════════════════════╗
echo ║  NgaboPay USSD Engine - Windows Setup    ║
echo ╚══════════════════════════════════════════╝
echo.

REM Check Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo         Download from: https://www.python.org/downloads/
    echo         IMPORTANT: Check "Add Python to PATH" during installation!
    pause
    exit /b 1
)

echo [1/4] Python found:
python --version
echo.

REM Create virtual environment
echo [2/4] Creating Python virtual environment...
if exist "venv" (
    echo   venv already exists, skipping...
) else (
    python -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment
        pause
        exit /b 1
    )
)
echo.

REM Install dependencies
echo [3/4] Installing dependencies...
venv\Scripts\pip install --upgrade pip -q
venv\Scripts\pip install -r requirements.txt
echo.

REM Create .env if not exists
echo [4/4] Checking configuration...
if not exist ".env" (
    copy .env.example .env >nul
    echo   Created .env file from template.
    echo.
    echo ╔══════════════════════════════════════════════════════════╗
    echo ║  IMPORTANT: You must edit .env before running!          ║
    echo ║                                                          ║
    echo ║  Open .env in Notepad and set:                           ║
    echo ║    MODEM_PORT=COM3       (your modem's COM port)         ║
    echo ║    MM_PIN=xxxx           (your Mobile Money PIN)         ║
    echo ║    API_KEY=ngp-modem-... (from your VPS .env)            ║
    echo ║    NGABOPAY_URL=https://ngabopay.online                  ║
    echo ║    ENGINE_HOST=0.0.0.0                                   ║
    echo ║                                                          ║
    echo ║  To find your COM port:                                  ║
    echo ║    Device Manager → Ports (COM ^& LPT) → look for modem ║
    echo ╚══════════════════════════════════════════════════════════╝
) else (
    echo   .env already exists. Edit it if needed: notepad .env
)

echo.
echo Setup complete! Next steps:
echo   1. Edit .env with your settings:  notepad .env
echo   2. Start the engine:              start-engine.bat
echo.
pause
