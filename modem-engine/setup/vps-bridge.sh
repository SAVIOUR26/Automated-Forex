#!/bin/bash
# ─── VPS Side: Virtual Serial Port via Tailscale ─────────
#
# Creates /dev/ttyVMODEM on the VPS that tunnels to the
# Windows laptop's COM port over Tailscale.
#
# Prerequisites:
#   1. Tailscale installed and connected on both VPS and laptop
#   2. The Windows laptop is running com2tcp (see windows-bridge.bat)
#
# Usage:
#   sudo bash vps-bridge.sh              # interactive
#   sudo bash vps-bridge.sh 100.64.0.2   # provide laptop IP directly

set -e

LAPTOP_IP="${1:-}"
LAPTOP_PORT=7000
VMODEM="/dev/ttyVMODEM"

if [ -z "$LAPTOP_IP" ]; then
    echo "─── VPS Serial Bridge Setup ───"
    echo ""
    echo "Enter the Tailscale IP of the Windows laptop:"
    read -rp "> " LAPTOP_IP
fi

if [ -z "$LAPTOP_IP" ]; then
    echo "Error: Tailscale IP required"
    exit 1
fi

# Install socat if missing
if ! command -v socat &>/dev/null; then
    echo "Installing socat..."
    apt-get update -qq && apt-get install -y -qq socat
fi

# Test connectivity
echo "Testing connection to ${LAPTOP_IP}:${LAPTOP_PORT}..."
if ! timeout 5 bash -c "echo > /dev/tcp/${LAPTOP_IP}/${LAPTOP_PORT}" 2>/dev/null; then
    echo "ERROR: Cannot reach ${LAPTOP_IP}:${LAPTOP_PORT}"
    echo "Make sure:"
    echo "  1. Tailscale is connected on both machines"
    echo "  2. com2tcp is running on the Windows laptop"
    exit 1
fi
echo "Connection OK!"

# Remove stale symlink
rm -f "$VMODEM"

echo ""
echo "Starting serial bridge: ${VMODEM} <-> ${LAPTOP_IP}:${LAPTOP_PORT}"
echo "Press Ctrl+C to stop"
echo ""

socat pty,link=${VMODEM},raw,echo=0,waitslave tcp:${LAPTOP_IP}:${LAPTOP_PORT}
