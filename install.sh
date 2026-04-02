#!/usr/bin/env bash
# ============================================================================
# Greenside Player — Raspberry Pi Kiosk Installer
#
# Downloads the player Docker image from the Greenside cloud and sets up
# a kiosk that boots directly into fullscreen Chromium pointing at the
# local container.
#
# Usage:  curl -fsSL https://greenside.live/player/install.sh | sudo bash -s -- [API_BASE]
#   or:   sudo bash install.sh [API_BASE]
#
# Example: sudo bash install.sh http://10.1.10.205:3000
# ============================================================================
set -euo pipefail

PLAYER_IMAGE="ghcr.io/greenside-live/greenside-player:latest"
PLAYER_CONTAINER="greenside-player"
PLAYER_PORT=8080
SERVICE_NAME="greenside-kiosk"
XSERVICE_NAME="greenside-xserver"
DEFAULT_API="http://10.1.10.205:3000"
CONFIG_DIR="/opt/greenside-player"

# --- Require root ---
if [[ $EUID -ne 0 ]]; then
  echo "Error: Run this script with sudo."
  exit 1
fi

# --- Get API_BASE ---
API_BASE="${1:-}"
if [[ -z "$API_BASE" ]]; then
  read -rp "Enter API base URL [$DEFAULT_API]: " API_BASE
  API_BASE="${API_BASE:-$DEFAULT_API}"
fi
API_BASE="${API_BASE%/}"
echo "Using API_BASE=$API_BASE"

# --- Install dependencies ---
echo "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  xserver-xorg x11-xserver-utils xinit \
  chromium-browser \
  unclutter \
  docker.io \
  > /dev/null

# Enable and start Docker
systemctl enable docker
systemctl start docker

# Add pi user to docker group
usermod -aG docker pi 2>/dev/null || true

# --- Pull and run player container ---
echo "Pulling Greenside Player image..."
docker pull "$PLAYER_IMAGE" || {
  echo "Warning: Could not pull image from registry."
  echo "Attempting local build..."
  if [[ -f "$(dirname "${BASH_SOURCE[0]}")/Dockerfile" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    docker build -t "$PLAYER_IMAGE" "$SCRIPT_DIR"
  else
    echo "Error: No Dockerfile found and cannot pull image. Exiting."
    exit 1
  fi
}

# Stop existing container if running
docker rm -f "$PLAYER_CONTAINER" 2>/dev/null || true

echo "Starting player container on port $PLAYER_PORT..."
docker run -d \
  --name "$PLAYER_CONTAINER" \
  --restart unless-stopped \
  -p "$PLAYER_PORT:80" \
  "$PLAYER_IMAGE"

# --- Write config ---
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.env" <<EOF
API_BASE=$API_BASE
MODE=kiosk
ROTATION=0
PLAYER_PORT=$PLAYER_PORT
EOF

# --- Create X server systemd service ---
cat > /etc/systemd/system/${XSERVICE_NAME}.service <<EOF
[Unit]
Description=Greenside X Server
After=systemd-user-sessions.service

[Service]
Type=simple
ExecStart=/usr/bin/startx -- -nocursor
Environment=DISPLAY=:0
User=pi
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# --- Create kiosk systemd service ---
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Greenside Player Kiosk
After=${XSERVICE_NAME}.service docker.service
Wants=${XSERVICE_NAME}.service
Requires=docker.service

[Service]
Type=simple
Environment=DISPLAY=:0
EnvironmentFile=${CONFIG_DIR}/config.env
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/chromium-browser \\
  --kiosk \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-translate \\
  --disable-features=TranslateUI \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-session-crashed-bubble \\
  --disable-component-update \\
  --autoplay-policy=no-user-gesture-required \\
  --check-for-update-interval=31536000 \\
  "http://localhost:\${PLAYER_PORT}?api=\${API_BASE}&mode=kiosk&rotate=\${ROTATION}"
User=pi
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# --- Disable screen blanking ---
echo "Disabling screen blanking and power management..."
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-blanking.conf <<EOF
Section "ServerFlags"
  Option "BlankTime"  "0"
  Option "StandbyTime" "0"
  Option "SuspendTime" "0"
  Option "OffTime"     "0"
  Option "DPMS"        "false"
EndSection
EOF

# --- Hide cursor ---
mkdir -p /home/pi/.config/autostart
cat > /home/pi/.config/autostart/unclutter.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Unclutter
Exec=unclutter -idle 0
Hidden=false
EOF
chown -R pi:pi /home/pi/.config

# --- Enable services ---
echo "Enabling services..."
systemctl daemon-reload
systemctl enable ${XSERVICE_NAME}.service
systemctl enable ${SERVICE_NAME}.service

echo ""
echo "========================================="
echo "  Greenside Player installed!"
echo ""
echo "  API:       $API_BASE"
echo "  Player:    http://localhost:$PLAYER_PORT"
echo "  Container: $PLAYER_CONTAINER"
echo ""
echo "  Reboot to start the kiosk:"
echo "    sudo reboot"
echo ""
echo "  To update the player:"
echo "    docker pull $PLAYER_IMAGE"
echo "    docker restart $PLAYER_CONTAINER"
echo ""
echo "  To change config:"
echo "    sudo nano $CONFIG_DIR/config.env"
echo "    sudo systemctl restart $SERVICE_NAME"
echo "========================================="
