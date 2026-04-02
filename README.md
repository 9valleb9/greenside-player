# Greenside Player

Universal viewer for golf course live streams. Displays HLS video with tournament overlays, leaderboard ticker, and sponsor rotation. Part of the [Greenside](https://greenside.live) platform.

## Platform Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  Mobile App  │     │   Cloud (API)    │     │  Edge Device (Pi) │
│  greenside-  │────▶│  greenside-live  │◀────│  streaming node   │
│  mobile      │     │                  │     │                   │
└──────────────┘     └───────┬──────────┘     └───────────────────┘
                             │
                     ┌───────▼──────────┐
                     │ Greenside Player │  ◀── this repo
                     │  kiosk / web /   │
                     │  embed viewer    │
                     └──────────────────┘
```

## Features

- **HLS.js video playback** — low-latency live stream with auto-reconnect
- **Tournament overlay** — name and current hole (top left)
- **Leaderboard ticker** — scrolling horizontal ticker at bottom (broadcast-style)
- **Sponsor rotation** — rotating sponsor bar with text and optional logo
- **Active team overlay** — team name, hole, and members (top right)
- **Offline standby screen** — branded holding card with Greenside logo and pulse animation
- **Auto-reconnect** — polls API every 10 seconds, recovers when stream returns
- **Deployment modes** — kiosk (no controls, no cursor) and web (mute + fullscreen controls)
- **Screen rotation** — 0, 90, 180, 270 degree support for portrait TVs
- **Responsive** — works on 1080p TV, desktop browser, and mobile

## Tech Stack

| Layer       | Technology                        |
|-------------|-----------------------------------|
| Video       | HLS.js                            |
| UI          | Vanilla HTML / CSS / JS           |
| Animations  | CSS keyframes (ticker, sponsors)  |
| Container   | Docker (nginx:alpine)             |
| Kiosk       | Chromium --kiosk on Raspberry Pi  |

No build step, no framework, no server runtime.

## Project Structure

```
greenside-player/
├── index.html          # Player UI — video, overlays, offline screen
├── player.js           # HLS playback, API polling, overlay updates
├── player.css          # Dark broadcast theme, ticker animations
├── Dockerfile          # nginx:alpine container
├── docker-compose.yml  # One-command local run
├── nginx.conf          # Caching, gzip, iframe-friendly headers
├── install.sh          # Raspberry Pi kiosk installer
├── package.json        # Project metadata
├── .env.example        # Configuration template
└── .gitignore
```

## Configuration

The player is configured via URL query parameters:

| Parameter    | Default                    | Description                                            |
|--------------|----------------------------|--------------------------------------------------------|
| `api`        | `http://localhost:3000`     | API base URL (edge device or cloud)                    |
| `mode`       | `kiosk`                    | `kiosk` (no controls) or `web`                         |
| `rotate`     | `0`                        | Screen rotation: 0, 90, 180, 270                      |
| `server`     | _(none)_                   | Greenside cloud URL (enables cloud config polling)     |
| `playerId`   | _(none)_                   | Player ID from cloud registration                      |
| `deviceKey`  | _(none)_                   | Device key from cloud registration                     |

When `server`, `playerId`, and `deviceKey` are all provided, the player polls the cloud every 60 seconds for config updates. The cloud can remotely change which origin the player connects to, its display mode, and rotation — no reboot required.

Example URLs:

```
# Kiosk pointing at local edge device (local-only mode)
http://localhost:8080?api=http://YOUR_EDGE_IP:3000&mode=kiosk

# Web embed pointing at cloud
http://localhost:8080?api=https://greenside.live&mode=web

# Portrait TV
http://localhost:8080?api=http://YOUR_EDGE_IP:3000&mode=kiosk&rotate=90

# Cloud-managed player (origin assigned remotely)
http://localhost:8080?api=http://YOUR_EDGE_IP:3000&mode=kiosk&server=https://www.greenside.live&playerId=abc123&deviceKey=xyz789
```

## API Endpoints

The player fetches data from these endpoints:

### `GET <SERVER_URL>/api/players/<playerId>/config` (cloud, every 60s)

Only called when the player is registered with the cloud. Authenticated with `Bearer <deviceKey>`.

```json
{
  "success": true,
  "data": {
    "apiTarget": "http://YOUR_EDGE_IP:3000",
    "mode": "kiosk",
    "rotation": 0
  }
}
```

If `apiTarget` changes, the player switches to the new origin live — no reboot. `mode` and `rotation` are also applied dynamically.

### Origin API (every 10s)

### `GET <API_BASE>/api/stream/status`

```json
{
  "success": true,
  "data": {
    "live": true,
    "hlsUrl": "https://greenside-live.b-cdn.net/live/stream_xxx.m3u8",
    "viewers": 12,
    "cameras": {
      "green": { "status": "running", "uptime": 3600 },
      "tee": { "status": "stopped" }
    }
  }
}
```

### `GET <API_BASE>/api/system/display-settings`

```json
{
  "success": true,
  "data": {
    "tournamentName": "Cameron Park Championship",
    "currentHole": "3",
    "leaderboard": "McIlroy (-11), Rose (-11), Reed (-9), Scheffler (-8)",
    "leaderboardVisible": true,
    "sponsorsVisible": true,
    "sponsors": [
      { "text": "MLAB", "logo": null }
    ],
    "activeTeam": {
      "name": "Team Alpha",
      "hole": "5",
      "members": ["J. Smith", "A. Jones", "M. Brown", "K. Lee"]
    }
  }
}
```

## Development

Serve locally with any static file server:

```bash
npx serve -p 8080 -s .
# Open http://localhost:8080?api=http://your-api:3000&mode=web
```

Or use Docker:

```bash
docker compose up
# Open http://localhost:8080?api=http://your-api:3000&mode=web
```

## Deployment

### Docker (recommended)

Build and run the container:

```bash
docker build -t greenside-player .
docker run -d -p 8080:80 --restart unless-stopped --name greenside-player greenside-player
```

The container serves the player on port 80 (mapped to 8080). Point any browser at it with the appropriate query parameters.

### Web Embed / iframe

Embed on any page:

```html
<iframe
  src="https://your-host:8080?api=https://greenside.live&mode=web"
  width="100%"
  height="100%"
  frameborder="0"
  allow="autoplay; fullscreen"
  allowfullscreen>
</iframe>
```

### CDN / Static Hosting

Upload `index.html`, `player.js`, and `player.css` to any static host (S3, Cloudflare Pages, Netlify, etc.). No build step required.

---

## Raspberry Pi Kiosk Setup

Full instructions for setting up a Raspberry Pi as a dedicated Greenside display.

### Prerequisites

- **Raspberry Pi 5** (recommended), Pi 4, or Pi 3B+ with at least 1GB RAM
- microSD card (16GB+ recommended, 8GB minimum)
- **Raspberry Pi OS Lite (64-bit)** — Bookworm or later
- HDMI TV or monitor
- Ethernet or configured Wi-Fi
- Network access to the Greenside edge device or cloud API
- A registration token from the Greenside dashboard (for cloud mode)

> **Networking note:** The player must be able to reach the edge device's API. If the player and edge device are not on the same local network, you must use a VPN such as [Tailscale](https://tailscale.com/) to connect them. With Tailscale, use the edge device's Tailscale IP (e.g., `http://100.x.x.x:3000`) as the API base URL.

### Step 1: Flash Raspberry Pi OS Lite

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your computer
2. Insert the microSD card
3. In Raspberry Pi Imager:
   - **Device:** select your Pi model (Raspberry Pi 5, 4, etc.)
   - **OS:** choose **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite (64-bit)**
   - **Storage:** select your microSD card
4. Click the **gear icon** (or "Edit Settings") to pre-configure:
   - **Hostname:** `greenside-player` (or a name like `clubhouse-tv`)
   - **Enable SSH:** yes, use password authentication
   - **Username:** `pi`
   - **Password:** set a strong password
   - **Wi-Fi:** configure SSID and password if not using Ethernet
   - **Locale:** set your timezone and keyboard layout
5. Click **Write** and wait for it to finish
6. Insert the microSD card into the Pi and power it on

### Step 2: Connect and Update

Wait about 60 seconds for first boot, then SSH in:

```bash
ssh pi@greenside-player.local
```

> If `.local` doesn't resolve, find the Pi's IP on your router and use `ssh pi@<IP>`.

Update the system:

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

### Step 3: Run the Installer

**With cloud registration (recommended):**

Create a registration token in the Greenside dashboard (Device Management > Add Player), then run:

```bash
curl -fsSL https://raw.githubusercontent.com/9valleb9/greenside-player/main/install.sh \
  | sudo bash -s -- --token YOUR_TOKEN http://YOUR_EDGE_IP:3000
```

This registers the player with the cloud, enables heartbeat monitoring, and connects it to your course.

**Local-only mode (no cloud registration):**

```bash
curl -fsSL https://raw.githubusercontent.com/9valleb9/greenside-player/main/install.sh \
  | sudo bash -s -- http://YOUR_EDGE_IP:3000
```

If you omit the API URL, the script will prompt you.

**Installer flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--token <token>` | _(none)_ | Registration token from the dashboard. Enables cloud registration and heartbeat. |
| `--server <url>` | `https://www.greenside.live` | Greenside cloud URL (override for staging/self-hosted). |
| First positional arg | _(prompted)_ | Edge device API URL (e.g., `http://YOUR_EDGE_IP:3000`). Required. |

### What the Installer Does

1. Installs minimal X server, Chromium, Docker, unclutter, curl, and jq
2. Pulls the `greenside-player` Docker image and starts it on port 8080
3. **If `--token` provided:**
   - Registers with the cloud (`POST /api/players/register`) using machine ID and hostname
   - Stores player ID and device key in config
   - Installs a heartbeat cron job (every 5 minutes)
   - Passes cloud credentials to the player URL so it can poll for config updates
4. Creates two systemd services:
   - `greenside-xserver` — X11 display server (no desktop)
   - `greenside-kiosk` — Chromium in fullscreen kiosk mode
5. Disables screen blanking, screensaver, DPMS power management
6. Hides the mouse cursor
7. Writes config to `/opt/greenside-player/config.env`

**After install, cloud-registered players:**
- Report heartbeat every 5 minutes (online/offline status)
- Poll for config every 60 seconds (which origin to connect to, mode, rotation)
- Can be reassigned to a different origin from the cloud dashboard — no SSH or reboot needed

### Step 4: Reboot

```bash
sudo reboot
```

The Pi will boot directly into the fullscreen player. No login, no desktop, no cursor.

### Post-Install Management

**Change the API target or rotation:**

```bash
sudo nano /opt/greenside-player/config.env
```

```
API_BASE=http://YOUR_EDGE_IP:3000
MODE=kiosk
ROTATION=0
PLAYER_PORT=8080
PLAYER_ID=abc123          # present if registered with cloud
DEVICE_KEY=xyz789          # present if registered with cloud
HEARTBEAT_URL=https://...  # present if registered with cloud
SERVER_URL=https://...     # present if registered with cloud
```

Then restart the kiosk:

```bash
sudo systemctl restart greenside-kiosk
```

**Update the player to the latest version:**

```bash
sudo docker pull ghcr.io/greenside-live/greenside-player:latest
sudo docker rm -f greenside-player
sudo docker run -d --name greenside-player --restart unless-stopped -p 8080:80 ghcr.io/greenside-live/greenside-player:latest
```

**View service status:**

```bash
sudo systemctl status greenside-kiosk
sudo systemctl status greenside-xserver
sudo docker logs greenside-player
```

**Rotate the display for a portrait TV:**

Edit `/opt/greenside-player/config.env` and set `ROTATION=90` (or 180, 270), then restart the kiosk service.

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Black screen after boot | Check `systemctl status greenside-xserver` — X server may have failed to start. Verify HDMI is connected before boot. |
| Player shows "Stream starting soon" | The stream is offline or the API is unreachable. Verify API_BASE is correct and the edge device is running. |
| No audio | The player starts muted by default (browser autoplay policy). In web mode, use the unmute button. In kiosk mode, audio is intentionally muted. |
| Docker pull fails | Check internet connectivity. The Pi needs access to `ghcr.io`. If behind a firewall, build locally: clone the repo and run `docker build -t ghcr.io/greenside-live/greenside-player:latest .` |
| Cursor visible | Run `sudo systemctl restart greenside-xserver`. Verify unclutter is installed: `which unclutter`. |
| Screen goes to sleep | Verify `/etc/X11/xorg.conf.d/10-blanking.conf` exists with DPMS disabled. Re-run the installer if missing. |
| Registration failed | Verify the token is valid and hasn't expired. Check cloud URL with `--server`. The player still works in local-only mode if registration fails. |
| Player not showing in dashboard | Check heartbeat: `sudo /usr/local/bin/greenside-player-heartbeat` and verify `DEVICE_KEY` and `HEARTBEAT_URL` are in config.env. Check cron: `crontab -l`. |
| Can't reach edge device | The player and edge device must be on the same network. If they're on different networks, use a VPN like [Tailscale](https://tailscale.com/) and use the Tailscale IP as the API URL. |

## Related Repositories

- [greenside-live](https://github.com/9valleb9/greenside-live) — Cloud backend and dashboard
- [greenside-mobile](https://github.com/9valleb9/greenside-mobile) — iOS/Android app
