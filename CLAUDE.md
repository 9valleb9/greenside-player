# greenside-player — clubhouse kiosk display

Browser-based player kiosk. Runs in fullscreen Chromium on a Raspberry Pi (or any browser) inside the clubhouse. Plays the local edge streamer's HLS feed, shows leaderboards/sponsors, and reports a thin heartbeat to the cloud.

For the cross-repo big picture, see `greenside-live/docs/ARCHITECTURE.md`.

## Tech stack

- **Runtime**: Vanilla JS, no build step
- **Player**: HLS.js
- **Container**: Docker (production), bare HTML for dev
- **Kiosk OS**: Raspberry Pi OS Lite + Cage (Wayland) + Chromium kiosk mode
- **Auth (cloud heartbeat)**: device key issued at registration

## Heartbeat to cloud

Distinct from the streamer's. The kiosk is **a different component** with its own heartbeat:

- **Endpoint**: `POST /api/players/[playerId]/heartbeat` on `greenside-live`
- **Cadence**: every 5 minutes via cron job at `/usr/local/bin/greenside-player-heartbeat`
- **Cloud "online" window**: 15 minutes
- **Cloud table**: `Player` (separate from `Device` — see `greenside-live` ARCHITECTURE.md)

The streamer is on `Device.lastSeen` with a 5-min window. The kiosk is on `Player.lastSeen` with a 15-min window. Course admins see both as independent components on `/dashboard/courses/[courseId]/devices` (Site Infrastructure).

The kiosk also polls `GET /api/players/[playerId]/config` every 60 s for runtime config (api target, mode, rotation, sponsors).

## Where things live

| Concern | Path |
|---------|------|
| Player UI | `index.html` + `player.js` + `player.css` |
| Cloud config polling | `player.js` (`CONFIG_POLL_INTERVAL`) |
| HLS playback | `player.js` (HLS.js setup) |
| Kiosk installer | `install.sh` (Raspberry Pi OS) |
| Heartbeat cron script (installed by `install.sh`) | `/usr/local/bin/greenside-player-heartbeat` (post-install) |
| Config (installed) | `/opt/greenside-player/config.env` |
| Docker setup | `docker-compose.yml`, `Dockerfile` |
| nginx (containerized server) | `nginx.conf` |

## Conventions

- **No build step.** Vanilla JS is intentional — easy to deploy, easy to debug from the device.
- **The kiosk reaches the local origin over LAN.** `apiTarget` defaults to the same Pi IP unless cloud overrides. Cross-LAN access (e.g. dev) needs Tailscale.
- **No command channel today.** Cloud can change `apiTarget` / mode / rotation via config polling, but can't `restart` the kiosk remotely. Backlog: `greenside-live` issue #86 (Player kiosk command channel + detail page).
- **Heartbeat is fire-and-forget.** If cloud is unreachable, log and continue — don't crash the kiosk.

## Install flow (the abbreviated version)

```bash
# Flash Raspberry Pi OS Lite (64-bit), enable SSH
ssh pi@kiosk-1
curl -fsSL https://raw.githubusercontent.com/9valleb9/greenside-player/main/install.sh | sudo bash -s -- \
  --token <REGISTRATION_TOKEN_FROM_CLOUD> \
  --server https://www.greenside.live \
  --api http://192.168.1.40:8080
sudo reboot
```

Full instructions in `README.md`. Step-by-step is intentionally inline so course operators can run it without reading code.

## Gotchas

- **`Always` location permission isn't relevant.** This is a fixed-location kiosk; geofence work is mobile-app-only.
- **Console blanking** is disabled via `consoleblank=0` kernel cmdline. If the screen sleeps, that's the first thing to check.
- **HLS playback errors** are usually upstream (origin streamer offline) — verify the streamer's heartbeat is healthy before debugging the kiosk.
- **Sponsor rotation** is currently embedded in player.js; future work moves it to cloud config.

## Documentation

- `README.md` — overview, install, troubleshooting, Docker deployment

## Related

- `greenside-live` — heartbeat target, config source
- `greensidelive-streamer` — sister edge component on the same site (different heartbeat). The kiosk plays HLS from the streamer's local origin.
