#!/usr/bin/env bash
# ============================================================================
# Retrofit an already-installed Greenside Player kiosk with:
#   1. Boot-time auto-update — pulls ghcr.io/.../greenside-player:latest on every
#      reboot and recreates the container if the image changed.
#   2. A permanent fix for "I pushed an update but the kiosk looks the same":
#      chromium's on-disk cache (which survives reboots + nginx no-cache headers)
#      is disabled, and any existing cache is wiped.
#   3. Boot ordering so the kiosk loads the freshly-pulled image in ONE reboot.
#
# Idempotent — safe to re-run. On the kiosk:
#   curl -fsSL https://raw.githubusercontent.com/9valleb9/greenside-player/main/enable-auto-update.sh | sudo bash
# then: sudo reboot
# ============================================================================
set -euo pipefail

IMAGE="ghcr.io/9valleb9/greenside-player:latest"
CONTAINER="greenside-player"
PORT="8080"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo."; exit 1; fi

# Detect the kiosk (autologin) user from the getty drop-in; fall back sensibly.
KIOSK_USER="$(sed -n 's/.*--autologin \([^ ]*\).*/\1/p' \
  /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null | head -1)"
KIOSK_USER="${KIOSK_USER:-${SUDO_USER:-pi}}"
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
echo "Kiosk user: $KIOSK_USER  (home: $KIOSK_HOME)"

# 1. Auto-update script ------------------------------------------------------
cat > /usr/local/bin/greenside-player-update <<EOF
#!/usr/bin/env bash
set -euo pipefail
IMAGE="$IMAGE"; CONTAINER="$CONTAINER"; PORT="$PORT"
CUR=\$(docker inspect --format='{{index .RepoDigests 0}}' "\$IMAGE" 2>/dev/null || echo "")
if timeout 60 docker pull "\$IMAGE"; then
  NEW=\$(docker inspect --format='{{index .RepoDigests 0}}' "\$IMAGE" 2>/dev/null || echo "")
  if [ -n "\$NEW" ] && [ "\$NEW" != "\$CUR" ]; then
    docker rm -f "\$CONTAINER" 2>/dev/null || true
    docker run -d --name "\$CONTAINER" --restart unless-stopped -p "\${PORT}:80" "\$IMAGE"
  else
    docker start "\$CONTAINER" >/dev/null 2>&1 || true
  fi
else
  docker start "\$CONTAINER" >/dev/null 2>&1 || true
fi
EOF
chmod +x /usr/local/bin/greenside-player-update

# 2. systemd service ---------------------------------------------------------
cat > /etc/systemd/system/greenside-player-update.service <<'EOF'
[Unit]
Description=Greenside Player — pull latest image on boot
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/greenside-player-update
TimeoutStartSec=90

[Install]
WantedBy=multi-user.target
EOF

# 3. Order the kiosk login after the refresh (one-reboot updates) ------------
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/after-update.conf <<'EOF'
[Unit]
After=greenside-player-update.service
EOF

systemctl daemon-reload
systemctl enable greenside-player-update.service

# 4. Disable chromium's disk cache in the kiosk .bash_profile ----------------
BP="$KIOSK_HOME/.bash_profile"
if [ -f "$BP" ] && grep -q 'disk-cache-size' "$BP"; then
  echo "$BP already has --disk-cache-size — leaving it."
elif [ -f "$BP" ] && grep -q '"http://localhost:' "$BP"; then
  sed -i 's#\(\s*\)\("http://localhost:\)#\1--disk-cache-size=1 \\\n\1\2#' "$BP"
  echo "Added --disk-cache-size=1 to chromium launch in $BP"
else
  echo "WARNING: couldn't patch $BP automatically — add '--disk-cache-size=1 \\' to the chromium flags by hand."
fi

# 5. Wipe any existing chromium cache now ------------------------------------
find "$KIOSK_HOME" -type d -path "*chromium*" -name "Cache" -exec rm -rf {} + 2>/dev/null || true

echo
echo "Done. Reboot to apply:  sudo reboot"
echo "After this, every reboot auto-pulls the latest image and always loads fresh —"
echo "no more manual docker pull / cache-clear dance."
