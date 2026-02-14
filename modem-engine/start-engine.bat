@echo off
REM ═══════════════════════════════════════════════════
REM  NgaboPay USSD Modem Engine — Start
REM  Launches the USSD engine (keep this window open!)
REM ═══════════════════════════════════════════════════

echo.
echo ╔══════════════════════════════════════════╗
echo ║  NgaboPay USSD Modem Engine              ║
echo ║  Press Ctrl+C to stop                    ║
echo ╚══════════════════════════════════════════╝
echo.

REM Check venv exists
if not exist "venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found.
    echo         Run setup-windows.bat first!
    pause
    exit /b 1
)

REM Check .env exists
if not exist ".env" (
    echo [ERROR] .env file not found.
    echo         Run setup-windows.bat first, then edit .env
    pause
    exit /b 1
)

REM Start the engine
echo Starting USSD engine...
echo.
venv\Scripts\python main.py

REM If we get here, engine stopped
echo.
echo Engine stopped.
pause
