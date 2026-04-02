#!/usr/bin/env bash
# ============================================================================
# Greenside Player — Raspberry Pi Kiosk Installer
#
# Downloads the player Docker image from the Greenside cloud and sets up
# a kiosk that boots directly into fullscreen Chromium pointing at the
# local container.
#
# Usage:
#   sudo bash install.sh [OPTIONS] [API_BASE]
#
# Options:
#   --token <token>    Registration token from the Greenside dashboard.
#                      Registers this player with the cloud and enables
#                      heartbeat reporting. If omitted, runs in local-only
#                      mode (no cloud registration).
#   --server <url>     Greenside cloud URL (default: https://www.greenside.live)
#
# Examples:
#   # Local-only mode (no cloud registration)
#   sudo bash install.sh http://YOUR_EDGE_IP:3000
#
#   # Register with cloud using a dashboard token
#   sudo bash install.sh --token abc123 http://YOUR_EDGE_IP:3000
#
#   # Register with a custom cloud server
#   sudo bash install.sh --token abc123 --server https://staging.greenside.live http://YOUR_EDGE_IP:3000
#
#   # Remote install (curl from cloud)
#   curl -fsSL https://www.greenside.live/player/install | sudo bash -s -- --token abc123 http://YOUR_EDGE_IP:3000
# ============================================================================
set -euo pipefail

PLAYER_IMAGE="ghcr.io/greenside-live/greenside-player:latest"
PLAYER_CONTAINER="greenside-player"
PLAYER_PORT=8080
SERVICE_NAME="greenside-kiosk"
XSERVICE_NAME="greenside-xserver"
DEFAULT_API=""
DEFAULT_SERVER="https://www.greenside.live"
CONFIG_DIR="/opt/greenside-player"

# --- Parse arguments ---
TOKEN=""
SERVER_URL="$DEFAULT_SERVER"
API_BASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --server)
      SERVER_URL="$2"
      shift 2
      ;;
    --help|-h)
      head -35 "$0" | tail -30
      exit 0
      ;;
    *)
      API_BASE="$1"
      shift
      ;;
  esac
done

# Strip trailing slashes
SERVER_URL="${SERVER_URL%/}"
API_BASE="${API_BASE%/}"

# --- Require root ---
if [[ $EUID -ne 0 ]]; then
  echo "Error: Run this script with sudo."
  exit 1
fi

# --- Get API_BASE ---
if [[ -z "$API_BASE" ]]; then
  read -rp "Enter edge device API URL (e.g., http://192.168.1.100:3000): " API_BASE
  if [[ -z "$API_BASE" ]]; then
    echo "Error: API base URL is required."
    exit 1
  fi
  API_BASE="${API_BASE%/}"
fi
echo "Using API_BASE=$API_BASE"

if [[ -n "$TOKEN" ]]; then
  echo "Registration token provided — will register with $SERVER_URL"
else
  echo "No --token provided — running in local-only mode (no cloud registration)"
fi

# --- Install dependencies ---
echo "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  xserver-xorg x11-xserver-utils xinit \
  chromium \
  unclutter \
  docker.io \
  curl \
  jq \
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

# --- Write base config ---
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.env" <<EOF
API_BASE=$API_BASE
MODE=kiosk
ROTATION=0
PLAYER_PORT=$PLAYER_PORT
EOF

# --- Cloud registration ---
PLAYER_ID=""
DEVICE_KEY=""
HEARTBEAT_URL=""

if [[ -n "$TOKEN" ]]; then
  echo "Registering player with Greenside cloud..."

  # Collect device info
  DEVICE_ID=$(cat /etc/machine-id 2>/dev/null || hostname)
  DEVICE_NAME=$(hostname)
  PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCHITECTURE=$(uname -m)
  DEVICE_HOSTNAME=$(hostname -f 2>/dev/null || hostname)

  REGISTER_RESPONSE=$(curl -sf -X POST \
    "${SERVER_URL}/api/players/register" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"deviceId\": \"${DEVICE_ID}\",
      \"deviceName\": \"${DEVICE_NAME}\",
      \"apiTarget\": \"${API_BASE}\",
      \"platform\": \"${PLATFORM}\",
      \"architecture\": \"${ARCHITECTURE}\",
      \"hostname\": \"${DEVICE_HOSTNAME}\"
    }" 2>&1) || {
    echo "Error: Failed to register with cloud."
    echo "Response: $REGISTER_RESPONSE"
    echo "Continuing without registration — player will work in local-only mode."
    TOKEN=""
  }

  if [[ -n "$TOKEN" ]]; then
    # Parse registration response
    PLAYER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.player.id // empty')
    DEVICE_KEY=$(echo "$REGISTER_RESPONSE" | jq -r '.player.deviceKey // empty')
    HEARTBEAT_URL=$(echo "$REGISTER_RESPONSE" | jq -r '.endpoints.heartbeat // empty')
    COURSE_NAME=$(echo "$REGISTER_RESPONSE" | jq -r '.course.name // empty')

    if [[ -z "$PLAYER_ID" || -z "$DEVICE_KEY" ]]; then
      echo "Error: Registration response missing player ID or device key."
      echo "Response: $REGISTER_RESPONSE"
      echo "Continuing without registration."
    else
      echo "Registered as player $PLAYER_ID (${COURSE_NAME:-unknown course})"

      # Build heartbeat URL if not provided explicitly
      if [[ -z "$HEARTBEAT_URL" ]]; then
        HEARTBEAT_URL="${SERVER_URL}/api/players/${PLAYER_ID}/heartbeat"
      fi

      # Append registration info to config
      cat >> "$CONFIG_DIR/config.env" <<EOF
PLAYER_ID=$PLAYER_ID
DEVICE_KEY=$DEVICE_KEY
HEARTBEAT_URL=$HEARTBEAT_URL
SERVER_URL=$SERVER_URL
EOF

      # --- Create heartbeat script ---
      cat > /usr/local/bin/greenside-player-heartbeat <<'HEARTBEAT_SCRIPT'
#!/usr/bin/env bash
# Greenside Player heartbeat — reports status to the cloud
set -euo pipefail

CONFIG="/opt/greenside-player/config.env"
if [[ ! -f "$CONFIG" ]]; then
  exit 0
fi

source "$CONFIG"

if [[ -z "${DEVICE_KEY:-}" || -z "${HEARTBEAT_URL:-}" ]]; then
  exit 0
fi

# Determine player status
if docker inspect greenside-player --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  STATUS="online"
else
  STATUS="offline"
fi

curl -sf -X POST "$HEARTBEAT_URL" \
  -H "Authorization: Bearer ${DEVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"status\": \"${STATUS}\", \"apiTarget\": \"${API_BASE:-}\"}" \
  > /dev/null 2>&1 || true
HEARTBEAT_SCRIPT
      chmod +x /usr/local/bin/greenside-player-heartbeat

      # --- Add cron job for heartbeat every 5 minutes ---
      CRON_LINE="*/5 * * * * /usr/local/bin/greenside-player-heartbeat"
      (crontab -l 2>/dev/null | grep -v "greenside-player-heartbeat"; echo "$CRON_LINE") | crontab -
      echo "Heartbeat cron installed (every 5 minutes)"

      # Send initial heartbeat
      /usr/local/bin/greenside-player-heartbeat || true
    fi
  fi
fi

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
ExecStart=/usr/bin/chromium \\
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
  "http://localhost:\${PLAYER_PORT}?api=\${API_BASE}&mode=\${MODE}&rotate=\${ROTATION}&server=\${SERVER_URL:-}&playerId=\${PLAYER_ID:-}&deviceKey=\${DEVICE_KEY:-}"
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
if [[ -n "$PLAYER_ID" ]]; then
echo "  Player ID: $PLAYER_ID"
echo "  Cloud:     $SERVER_URL"
echo "  Heartbeat: every 5 minutes"
else
echo "  Mode:      local-only (no cloud registration)"
fi
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
