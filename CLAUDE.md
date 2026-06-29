# greenside-player — clubhouse kiosk display

Part of the Greenside platform — umbrella: `../CLAUDE.md`.

Browser-based player kiosk. Runs in fullscreen Chromium on a Raspberry Pi (or any browser) inside the clubhouse. Plays HLS from the local greenside-origin Pi (or the Bunny CDN), shows leaderboards/sponsors, and reports a thin heartbeat to the cloud.

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

The kiosk also polls `GET /api/players/[playerId]/config` every 60 s for runtime config (api target, mode, rotation, sponsors, **displayMode + parimutuelPoolId**).

### Display modes (live stream vs parimutuel board)

`player.js` switches what the kiosk shows based on `displayMode` from cloud config:

- `live_stream` (default) — HLS feed + leaderboard/sponsor overlays.
- `parimutuel_monitor` — the tote board for `parimutuelPoolId` (mirrors the cloud TV view `/parimutuel/tv/[poolId]`).

Both fields live on the cloud `Player` row and are **set from the admin**: Site Infrastructure → the kiosk's **"Display"** button → `KioskDisplayConfig` modal (Live stream | Parimutuel board + pool). The kiosk applies the change on its next config poll (≤60 s) — no SSH, no restart. The whole pipeline (schema → config endpoint → `player.js` apply → tote DOM) already existed; only the admin selector was added (2026-06). Test page: `test-tote.html`.

## Where things live

| Concern | Path |
|---------|------|
| Player UI | `index.html` + `player.js` + `player.css` |
| Cloud config polling | `player.js` (`CONFIG_POLL_INTERVAL`) |
| HLS playback | `player.js` (`startPlayback`/stall watchdog) + **`hls-config.js`** (the `buildHlsConfig()` factory) |
| HLS buffering config | **`hls-config.js`** — kiosk is a PASSIVE display: `lowLatencyMode:false`, sits ~18s back (`liveSyncDuration`), deep buffer, smooth catch-up (`maxLiveSyncPlaybackRate`), patient `fragLoadPolicy` retries (no ABR fallback). Tested by `tests/hls-config.test.js` (CI-gated). Was jumpy when it ran low-latency at the edge. |
| Tests (zero-dep, Node's runner) | `tests/*.test.js`, `npm test`; gated in `.github/workflows/docker-publish.yml` |
| Boot auto-update + cache fix | `install.sh` (`greenside-player-update.service`) + `enable-auto-update.sh` (retrofit for an already-installed kiosk) |
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
  http://192.168.1.40:3000
sudo reboot
```

Full instructions in `README.md`. Step-by-step is intentionally inline so course operators can run it without reading code.

## Gotchas

- **`Always` location permission isn't relevant.** This is a fixed-location kiosk; geofence work is mobile-app-only.
- **Chromium serves a STALE cached page after a new image — clear its disk cache.** The #1 "I pushed but the kiosk looks the same" trap (cost us hours on 2026-06-10). The Docker pull + recreate can be correct (verify with `docker exec greenside-player grep -c <a-distinctive-string> /usr/share/nginx/html/player.js` — a *plain* string, not a regex; `\s`-style patterns get mangled through the shell and false-negative) yet chromium still renders the old `player.js`/`player.css` from its on-disk cache even after a reboot. Fix: `sudo find / -type d -path "*chromium*" -name "Cache" -exec rm -rf {} + 2>/dev/null` then `sudo reboot`. nginx already sends no-cache headers; the disk cache survives them. (Backlog: a `greenside-player-update` boot unit that pulls `:latest` + clears the cache so this is automatic.)
- **Tote board rendering** (`parimutuel_monitor`): two-column layout, **last names only** in the team cell (full names bleed into the W/P/S columns), no "TEAM #" label, **"—"** for any team/type with no bets (`odds.betCount` — the as-if-$1 fallback odds read as bizarre long shots), client-side trend arrows, and the recent-activity **marquee runs at `marquee-scroll 120s`** (halved from 60s — 60s was too fast to read).
- **Console blanking** is disabled via `consoleblank=0` kernel cmdline. If the screen sleeps, that's the first thing to check.
- **HLS playback errors** are usually upstream (the greenside-origin Pi offline) — verify the origin's heartbeat is healthy before debugging the kiosk. But "jumpy"/stalling playback on an otherwise-healthy stream is a PLAYER-side buffering issue → see `hls-config.js` (deep buffer, no low-latency). A no-ABR single rendition has no lower variant to drop to, so the buffer must absorb all jitter.
- **The `Dockerfile` COPYs specific files, NOT `COPY . .`.** Any new file `index.html` references with a `<script>`/`<link>` (e.g. `hls-config.js`) MUST get its own `COPY` line, or it 404s in the image → broken JS / black screen with overlays. `tests/hls-config.test.js` asserts every local asset in `index.html` is copied; the test gates the image build.
- **Updating the kiosk is now hands-free:** push to `main` → CI builds → `sudo reboot`. The boot service pulls `:latest`; chromium runs with `--disk-cache-size=1` + a boot cache-wipe so it always loads fresh (the old manual `docker pull` + cache-clear dance is gone, once `enable-auto-update.sh` has run once).
- **Sponsor rotation** is currently embedded in player.js; future work moves it to cloud config.

## Documentation

- `README.md` — overview, install, troubleshooting, Docker deployment

## Related

- `greenside-live` — heartbeat target, config source
- `greensidelive-streamer` — sister edge component on the same site (different heartbeat). The kiosk plays HLS from the local greenside-origin Pi (or the Bunny CDN).
