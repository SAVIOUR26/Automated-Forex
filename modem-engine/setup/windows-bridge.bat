@echo off
REM ─── Windows Laptop: Expose COM Port over Tailscale ────
REM
REM Exposes the GSM modem's COM port over TCP so the VPS
REM can access it via Tailscale.
REM
REM Prerequisites:
REM   1. Tailscale installed and connected
REM   2. GSM modem plugged in and assigned a COM port
REM   3. com2tcp.exe in PATH (from com0com project)
REM      Download: https://sourceforge.net/projects/com0com/files/com2tcp/
REM
REM Usage:
REM   windows-bridge.bat          (defaults to COM3)
REM   windows-bridge.bat COM5     (specify port)

set COM_PORT=%1
if "%COM_PORT%"=="" set COM_PORT=COM3
set TCP_PORT=7000

echo ─── Windows Serial Bridge ───
echo.
echo COM Port: %COM_PORT%
echo TCP Port: %TCP_PORT% (accessible via Tailscale)
echo.
echo Make sure:
echo   1. GSM modem is plugged in and recognized as %COM_PORT%
echo   2. Tailscale is connected
echo   3. No other program is using %COM_PORT%
echo.
echo Starting bridge... Press Ctrl+C to stop.
echo.

com2tcp --baud 115200 \\.\%COM_PORT% %TCP_PORT%

REM If com2tcp is not found, try alternative tools:
REM   - ser2net (Windows port)
REM   - HW Virtual Serial Port (commercial)
REM   - Or use Python: python -m serial.tools.miniterm COM3 115200
