/**
 * Greenside Player — Universal Viewer for Golf Course Live Streams
 * Static client: fetches stream + display data from configurable API.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const CONFIG_POLL_INTERVAL = 60_000;  // check cloud config every 60s
  const STREAM_POLL_INTERVAL = 10_000;  // check stream/display every 10s

  // Cloud config (for registered players)
  const SERVER_URL  = (params.get('server') || '').replace(/\/+$/, '');
  const PLAYER_ID   = params.get('playerId') || '';
  const DEVICE_KEY  = params.get('deviceKey') || '';

  // Runtime state — API target can be updated by cloud config
  let apiBase  = (params.get('api') || 'http://localhost:3000').replace(/\/+$/, '');
  let mode     = params.get('mode') || 'kiosk';
  let rotation = parseInt(params.get('rotate') || '0', 10);
  let displayMode = params.get('displayMode') || 'live_stream';
  let parimutuelPoolId = params.get('poolId') || null;

  const isRegistered = !!(SERVER_URL && PLAYER_ID && DEVICE_KEY);

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------
  const $video          = document.getElementById('player');
  const $overlays       = document.getElementById('overlays');
  const $offline        = document.getElementById('offline-screen');
  const $tournamentName = document.getElementById('tournament-name');
  const $currentHole    = document.getElementById('current-hole');
  const $activeTeam     = document.getElementById('active-team');
  const $teamName       = document.getElementById('active-team-name');
  const $teamHole       = document.getElementById('active-team-hole');
  const $teamMembers    = document.getElementById('active-team-members');
  const $leaderboard    = document.getElementById('leaderboard-ticker');
  const $lbContent      = document.getElementById('leaderboard-content');
  const $sponsorBar     = document.getElementById('sponsor-bar');
  const $sponsorText    = document.getElementById('sponsor-text');
  const $sponsorLogo    = document.getElementById('sponsor-logo');
  const $webControls    = document.getElementById('web-controls');
  const $btnMute        = document.getElementById('btn-mute');
  const $btnFullscreen  = document.getElementById('btn-fullscreen');

  // Tote board (parimutuel monitor mode)
  const $tote           = document.getElementById('tote-board');
  const $toteEventName  = document.getElementById('tote-event-name');
  const $toteStatus     = document.getElementById('tote-status');
  const $toteCountdownBox = document.getElementById('tote-countdown');
  const $toteCountdown  = document.getElementById('tote-countdown-value');
  const $toteGridBodyLeft  = document.getElementById('tote-grid-body-left');
  const $toteGridBodyRight = document.getElementById('tote-grid-body-right');
  const $toteMarquee    = document.getElementById('tote-marquee-content');
  const $videoContainer = document.getElementById('video-container');

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let hls = null;
  let currentHlsUrl = null;
  let isLive = false;
  let sponsorIndex = 0;
  let sponsors = [];
  let sponsorTimer = null;
  let streamTimer = null;

  // Tote-board state
  let toteTimer = null;
  let totePrevOdds = { win: {}, place: {}, show: {} };
  let toteSeenBetIds = new Set();
  let toteRefreshIn = 5;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    applyMode(mode);
    applyRotation(rotation);
    // applyDisplayMode owns starting the right polling loop.
    applyDisplayMode(displayMode);

    // If registered with cloud, poll for config
    if (isRegistered) {
      pollConfig();
      setInterval(pollConfig, CONFIG_POLL_INTERVAL);
    }
  }

  function startStreamTimer() {
    stopStreamTimer();
    pollStream();
    streamTimer = setInterval(pollStream, STREAM_POLL_INTERVAL);
  }

  function stopStreamTimer() {
    if (streamTimer) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud config polling
  // ---------------------------------------------------------------------------
  async function pollConfig() {
    try {
      const res = await fetch(SERVER_URL + '/api/players/' + PLAYER_ID + '/config', {
        headers: { 'Authorization': 'Bearer ' + DEVICE_KEY },
      });
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data || {};
      applyCloudConfig(data);
    } catch (_err) {
      // Cloud unreachable — keep using current config
    }
  }

  function applyCloudConfig(data) {
    // Update API target if cloud assigned one
    if (data.apiTarget && data.apiTarget !== apiBase) {
      const newBase = data.apiTarget.replace(/\/+$/, '');
      console.log('[greenside] API target changed:', apiBase, '→', newBase);
      apiBase = newBase;
      // Force an immediate stream poll with the new target
      pollStream();
    }

    // Update mode if changed
    if (data.mode && data.mode !== mode) {
      mode = data.mode;
      applyMode(mode);
    }

    // Update rotation if changed
    if (data.rotation != null && data.rotation !== rotation) {
      rotation = parseInt(data.rotation, 10);
      applyRotation(rotation);
    }

    // Display mode (live_stream / parimutuel_monitor) — switches the
    // whole kiosk view + which polling loop is running.
    if (data.displayMode && data.displayMode !== displayMode) {
      displayMode = data.displayMode;
      applyDisplayMode(displayMode);
    }

    // Pool ID — if the same kiosk gets reassigned to a different pool
    // (e.g. start of a new event), reset the diff state and force a
    // fresh tote fetch.
    if (data.parimutuelPoolId != null && data.parimutuelPoolId !== parimutuelPoolId) {
      parimutuelPoolId = data.parimutuelPoolId;
      totePrevOdds = { win: {}, place: {}, show: {} };
      toteSeenBetIds.clear();
      if (displayMode === 'parimutuel_monitor') {
        pollTote();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Display mode switching
  // ---------------------------------------------------------------------------
  function applyDisplayMode(m) {
    if (m === 'parimutuel_monitor') {
      // Tear down live stream
      stopStreamTimer();
      destroyPlayback();
      $offline.classList.add('hidden');
      $overlays.classList.add('hidden');
      if ($videoContainer) $videoContainer.classList.add('hidden');
      // Show tote board
      $tote.classList.remove('hidden');
      // Start tote polling (immediate + interval)
      stopToteTimer();
      pollTote();
      toteTimer = setInterval(pollTote, toteRefreshIn * 1000);
    } else {
      // Switch back to live stream
      stopToteTimer();
      $tote.classList.add('hidden');
      if ($videoContainer) $videoContainer.classList.remove('hidden');
      // Reveal offline screen until pollStream confirms live
      $offline.classList.remove('hidden', 'fade-out');
      // Start live polling (also restarts after a tote → live switch)
      startStreamTimer();
    }
  }

  function stopToteTimer() {
    if (toteTimer) {
      clearInterval(toteTimer);
      toteTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mode & rotation
  // ---------------------------------------------------------------------------
  function applyMode(m) {
    if (m === 'web') {
      document.body.classList.add('mode-web');
      $webControls.classList.remove('hidden');
      setupWebControls();
    } else {
      document.body.classList.remove('mode-web');
      $webControls.classList.add('hidden');
    }
  }

  function applyRotation(deg) {
    // Remove existing rotation classes
    document.body.classList.remove('rotate-90', 'rotate-180', 'rotate-270');
    if ([90, 180, 270].includes(deg)) {
      document.body.classList.add('rotate-' + deg);
    }
  }

  // ---------------------------------------------------------------------------
  // Stream & display polling
  // ---------------------------------------------------------------------------
  async function pollStream() {
    // Stream URL now comes from cloud (signed Bunny CDN URL), no longer
    // from the local LAN streamer. Display settings (sponsors, leaderboard,
    // current hole) still poll the local streamer — they're not in the
    // cloud yet — and are allowed to fail silently if the LAN is gone.
    if (!isRegistered) {
      // Fallback to old behavior for unregistered / dev kiosks
      try {
        const [statusRes, settingsRes] = await Promise.all([
          fetch(apiBase + '/api/stream/status').then(r => r.json()),
          fetch(apiBase + '/api/system/display-settings').then(r => r.json()),
        ]);
        handleStreamStatus(statusRes.data || {});
        handleDisplaySettings(settingsRes.data || {});
      } catch (_err) {
        goOffline();
      }
      return;
    }

    // Cloud-sourced stream status (CDN-backed)
    let streamData = null;
    try {
      const res = await fetch(SERVER_URL + '/api/players/' + PLAYER_ID + '/live', {
        headers: { Authorization: 'Bearer ' + DEVICE_KEY },
      });
      const body = await res.json();
      streamData = body.data || {};
    } catch (_err) {
      goOffline();
      return;
    }
    handleStreamStatus(streamData);

    // Best-effort local display-settings fetch — overlay just stays
    // empty/stale if the LAN can't be reached.
    try {
      const res = await fetch(apiBase + '/api/system/display-settings');
      const body = await res.json();
      handleDisplaySettings(body.data || {});
    } catch (_err) {
      /* overlays remain in their last-known state */
    }
  }

  // ---------------------------------------------------------------------------
  // Stream status
  // ---------------------------------------------------------------------------
  function handleStreamStatus(data) {
    if (data.live && data.hlsUrl) {
      goLive(data.hlsUrl);
    } else {
      goOffline();
    }
  }

  function goLive(hlsUrl) {
    // Compare path-only, not the full signed URL. Cloud re-signs every
    // poll with a fresh token + expiry query string (5-min TTL vs
    // 10-second poll cadence), so a naive full-URL equality check sees
    // a "new" URL on every tick and tears down HLS — the kiosk would
    // flash black continuously while the source stream never actually
    // moved. The path is the stable identity.
    var sameStream = (function () {
      if (!isLive || !currentHlsUrl) return false;
      try {
        var a = new URL(hlsUrl, window.location.origin).pathname;
        var b = new URL(currentHlsUrl, window.location.origin).pathname;
        return a === b;
      } catch (_e) {
        return hlsUrl === currentHlsUrl;
      }
    })();
    if (sameStream) {
      // Same playlist — keep playing, just remember the freshest signed
      // URL so HLS.js will use it on its own segment fetches.
      currentHlsUrl = hlsUrl;
      return;
    }

    isLive = true;
    currentHlsUrl = hlsUrl;

    // Hide offline screen
    $offline.classList.add('fade-out');
    setTimeout(() => { $offline.classList.add('hidden'); }, 600);

    // Show overlays
    $overlays.classList.remove('hidden');

    // Start HLS playback
    startPlayback(hlsUrl);
  }

  function goOffline() {
    if (!isLive) return;
    isLive = false;
    currentHlsUrl = null;

    // Tear down player
    destroyPlayback();

    // Show offline screen
    $offline.classList.remove('hidden', 'fade-out');
    $overlays.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // HLS playback
  // ---------------------------------------------------------------------------
  function startPlayback(url) {
    destroyPlayback();

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
      });
      hls.loadSource(url);
      hls.attachMedia($video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        $video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            destroyPlayback();
          }
        }
      });
    } else if ($video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      $video.src = url;
      $video.addEventListener('loadedmetadata', () => {
        $video.play().catch(() => {});
      }, { once: true });
    }
  }

  function destroyPlayback() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    $video.removeAttribute('src');
    $video.load();
  }

  // ---------------------------------------------------------------------------
  // Display settings
  // ---------------------------------------------------------------------------
  function handleDisplaySettings(data) {
    // Tournament info
    $tournamentName.textContent = data.tournamentName || '';
    $currentHole.textContent = data.currentHole ? 'Hole ' + data.currentHole : '';

    // Leaderboard
    if (data.leaderboardVisible && data.leaderboard) {
      $leaderboard.classList.remove('hidden');
      updateLeaderboard(data.leaderboard);
      // Apply configurable scale (default 1)
      var scale = parseFloat(data.leaderboardScale) || 1;
      $leaderboard.style.transform = scale !== 1 ? 'scale(' + scale + ')' : '';
      $leaderboard.style.transformOrigin = 'bottom left';
    } else {
      $leaderboard.classList.add('hidden');
    }

    // Sponsors
    if (data.sponsorsVisible && data.sponsors && data.sponsors.length) {
      sponsors = data.sponsors;
      $sponsorBar.classList.remove('hidden');
      if (!sponsorTimer) {
        showSponsor();
        sponsorTimer = setInterval(showSponsor, 5000);
      }
    } else {
      $sponsorBar.classList.add('hidden');
      sponsors = [];
      if (sponsorTimer) { clearInterval(sponsorTimer); sponsorTimer = null; }
    }

    // Active team
    if (data.activeTeam) {
      $activeTeam.classList.remove('hidden');
      $teamName.textContent = data.activeTeam.name || '';
      $teamHole.textContent = data.activeTeam.hole ? 'Hole ' + data.activeTeam.hole : '';
      $teamMembers.textContent = (data.activeTeam.members || []).join(', ');
    } else {
      $activeTeam.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // Leaderboard ticker
  // ---------------------------------------------------------------------------
  function updateLeaderboard(raw) {
    // Parse "Name (score), Name (score), ..." format
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    // Build HTML — duplicate for seamless scroll
    const html = entries.map((entry, i) => {
      const match = entry.match(/^(.+?)\s*\(([^)]+)\)$/);
      const name  = match ? match[1] : entry;
      const score = match ? match[2] : '';
      return `<span class="lb-entry"><span class="lb-pos">${i + 1}</span><span class="lb-name">${esc(name)}</span><span class="lb-score">${esc(score)}</span></span>`;
    }).join('');

    $lbContent.innerHTML = html + html; // duplicate for infinite scroll
  }

  // ---------------------------------------------------------------------------
  // Sponsor rotation
  // ---------------------------------------------------------------------------
  function showSponsor() {
    if (!sponsors.length) return;
    const s = sponsors[sponsorIndex % sponsors.length];
    $sponsorText.textContent = s.text || '';
    if (s.logo) {
      $sponsorLogo.src = s.logo;
      $sponsorLogo.classList.remove('hidden');
    } else {
      $sponsorLogo.classList.add('hidden');
    }
    sponsorIndex++;
  }

  // ---------------------------------------------------------------------------
  // Parimutuel tote board polling + render
  // ---------------------------------------------------------------------------
  async function pollTote() {
    if (!parimutuelPoolId || !SERVER_URL) {
      renderToteEmpty('Awaiting pool assignment…');
      return;
    }
    try {
      const res = await fetch(SERVER_URL + '/api/parimutuel/tv/' + parimutuelPoolId);
      if (!res.ok) {
        renderToteEmpty('Pool not found');
        return;
      }
      const json = await res.json();
      if (!json || !json.success) return;
      renderTote(json.data);
      // Honor the cloud's refresh hint (default 5 s). Only restart timer
      // if it's actually changed.
      if (json.data.refreshIn && json.data.refreshIn !== toteRefreshIn) {
        toteRefreshIn = json.data.refreshIn;
        stopToteTimer();
        toteTimer = setInterval(pollTote, toteRefreshIn * 1000);
      }
    } catch (_err) {
      // Silent — keep last frame
    }
  }

  function renderToteEmpty(msg) {
    $toteEventName.textContent = msg || 'No active pool';
    $toteStatus.textContent = '—';
    $toteStatus.className = 'tote-status tote-status-draft';
    setCountdown(null);
    $toteGridBodyLeft.innerHTML = '<div class="tote-empty">' + esc(msg || 'No active pool') + '</div>';
    $toteGridBodyRight.innerHTML = '';
  }

  function renderTote(data) {
    const h = data.header || {};
    const o = data.odds || {};
    const r = data.recentActivity || [];
    const stats = data.stats || {};
    // Hide odds ("--") until the pool has enough bets — matches the cloud TV +
    // mobile so early lopsided odds (e.g. 1/100) never show.
    const provisional = !!(o.win && o.win.provisional);

    // Header
    $toteEventName.textContent = h.eventName || '—';
    setStatus(h.poolStatus);
    setCountdown(h.countdown);

    // Grid — union of teams across W/P/S so every team gets one row
    const teamMap = new Map();
    for (const bt of ['win', 'place', 'show']) {
      const teams = (o[bt] && o[bt].teams) || [];
      for (const t of teams) {
        const cur = teamMap.get(t.teamId) || {
          teamId: t.teamId,
          teamNumber: t.teamNumber,
          teamName: t.teamName,
          playerNames: t.playerNames,
          win: null, place: null, show: null,
        };
        cur[bt] = t;
        teamMap.set(t.teamId, cur);
      }
    }
    const teams = Array.from(teamMap.values()).sort(byTeamNumber);

    // Determine favorite — lowest win odds = most popular = "hot".
    // Skipped while provisional (odds aren't revealed yet).
    let favoriteId = null;
    if (!provisional) {
      let lowestOdds = Infinity;
      for (const t of teams) {
        if (t.win && typeof t.win.decimalOdds === 'number' && t.win.decimalOdds < lowestOdds) {
          lowestOdds = t.win.decimalOdds;
          favoriteId = t.teamId;
        }
      }
    }

    // Render grid (rebuild on each tick — small N, simpler than DOM diffing)
    // Two columns: first half left (e.g. teams 1–10), second half right (11–20).
    const half = Math.ceil(teams.length / 2);
    $toteGridBodyLeft.innerHTML  = teams.slice(0, half).map((t) => renderRow(t, favoriteId, provisional)).join('');
    $toteGridBodyRight.innerHTML = teams.slice(half).map((t) => renderRow(t, favoriteId, provisional)).join('');

    // Per-cell flash for odds movement — only once odds are live. While
    // provisional we don't record prev odds, so the reveal doesn't flash-storm.
    if (!provisional) {
      for (const t of teams) {
        for (const bt of ['win', 'place', 'show']) {
          const odds = t[bt];
          if (!odds) continue;
          const prev = totePrevOdds[bt][t.teamId];
          if (prev != null && prev !== odds.decimalOdds) {
            // odds shortened (number went down) → more popular → green
            // odds lengthened (number went up) → less popular → red
            const dir = odds.decimalOdds < prev ? 'flash-up' : 'flash-down';
            flashCell(t.teamId, bt, dir);
          }
          totePrevOdds[bt][t.teamId] = odds.decimalOdds;
        }
      }
    }

    // Recent activity → marquee. Keep growing the marquee but cap at
    // ~30 entries to avoid runaway DOM.
    if (r.length) {
      const newBets = r.filter((b) => !toteSeenBetIds.has(b.id)).reverse();
      for (const bet of newBets) toteSeenBetIds.add(bet.id);
      if (newBets.length) {
        const html = newBets.map(renderMarqueeBet).join('');
        $toteMarquee.innerHTML = (html + $toteMarquee.innerHTML).slice(0, 8000);
      }
      if (toteSeenBetIds.size > 200) {
        // Trim memory — keep recent 200
        toteSeenBetIds = new Set(Array.from(toteSeenBetIds).slice(-200));
      }
    }

    // Popular pick footer line in marquee (always present)
    if (stats.popularPick && !$toteMarquee.querySelector('.tote-marquee-popular')) {
      const txt =
        '<span class="tote-marquee-bet tote-marquee-popular">🔥 HOT PICK · <b>' +
        esc(stats.popularPick.teamName) + '</b> ' + esc(stats.popularPick.betType) +
        ' · ' + stats.popularPick.betCount + ' bets</span>';
      $toteMarquee.innerHTML = txt + $toteMarquee.innerHTML;
    }
  }

  function renderRow(t, favoriteId, provisional) {
    const isFav = t.teamId === favoriteId;
    const players = (t.playerNames || []).join(' & ');
    return (
      '<div class="tote-row' + (isFav ? ' is-favorite' : '') + '" data-team="' + esc(t.teamId) + '">' +
        '<div class="tote-row-team">' +
          '<span class="tote-row-team-name">' + esc(t.teamName || ('Team ' + t.teamNumber)) + '</span>' +
          (players ? '<span class="tote-row-team-players">' + esc(players) + '</span>' : '') +
        '</div>' +
        renderOddsCell(t.win,   t.teamId, 'win',   provisional) +
        renderOddsCell(t.place, t.teamId, 'place', provisional) +
        renderOddsCell(t.show,  t.teamId, 'show',  provisional) +
      '</div>'
    );
  }

  function renderOddsCell(odds, teamId, bt, provisional) {
    if (provisional || !odds) {
      return '<div class="tote-row-odds" data-team="' + esc(teamId) + '" data-bt="' + bt + '">' +
               '<div class="tote-row-odds-value">—</div>' +
             '</div>';
    }
    const arrow = odds.movement === 'up'   ? '▲'
                : odds.movement === 'down' ? '▼'
                : '';
    return '<div class="tote-row-odds" data-team="' + esc(teamId) + '" data-bt="' + bt + '">' +
             '<div class="tote-row-odds-value">' + esc(odds.fractionalOdds || '—') + '</div>' +
             '<div class="tote-row-odds-decimal">' + (odds.decimalOdds ? odds.decimalOdds.toFixed(2) : '') + '</div>' +
             (arrow ? '<div class="tote-row-odds-arrow">' + arrow + '</div>' : '') +
           '</div>';
  }

  function renderMarqueeBet(bet) {
    // No bettor names on the public board — amount · team · type only.
    return '<span class="tote-marquee-bet">' +
             '<span class="amt">$' + Math.round(bet.amount || 0) + '</span> on ' +
             '<b>' + esc(bet.teamName || '—') + '</b> to ' +
             esc(String(bet.betType || '').toUpperCase()) +
             ' @ ' + esc(bet.odds || '—') +
           '</span>';
  }

  function setStatus(status) {
    const s = (status || 'OPEN').toUpperCase();
    $toteStatus.textContent = s === 'OPEN' ? 'OPEN' : s;
    $toteStatus.className = 'tote-status ' +
      (s === 'OPEN' ? 'tote-status-open'
      : s === 'CLOSED' || s === 'SETTLING' ? 'tote-status-closing'
      : s === 'CANCELLED' ? 'tote-status-closed'
      : s === 'SETTLED' ? 'tote-status-settled'
      : 'tote-status-draft');
  }

  function setCountdown(seconds) {
    // null = no scheduled close (manual-close pool). Hide the whole block
    // rather than show a misleading timer.
    if (seconds == null) {
      if ($toteCountdownBox) $toteCountdownBox.style.display = 'none';
      $toteCountdown.classList.remove('urgent');
      return;
    }
    if ($toteCountdownBox) $toteCountdownBox.style.display = '';
    const hrs = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    $toteCountdown.textContent = hrs > 0
      ? hrs + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
      : m + ':' + String(s).padStart(2, '0');
    $toteCountdown.classList.toggle('urgent', seconds <= 60);
  }

  function flashCell(teamId, bt, cls) {
    // Set on next paint so the freshly-rendered row picks up the class.
    requestAnimationFrame(() => {
      const sel = '.tote-row[data-team="' + cssEscape(teamId) + '"] .tote-row-odds[data-bt="' + bt + '"]';
      const el = $tote.querySelector(sel);
      if (!el) return;
      el.classList.remove('flash-up', 'flash-down');
      // force reflow so re-applied animation restarts
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 700);
    });
  }

  function byTeamNumber(a, b) {
    return (a.teamNumber || 0) - (b.teamNumber || 0);
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // ---------------------------------------------------------------------------
  // Web controls
  // ---------------------------------------------------------------------------
  let webControlsSetup = false;
  function setupWebControls() {
    if (webControlsSetup) return;
    webControlsSetup = true;

    $btnMute.addEventListener('click', () => {
      $video.muted = !$video.muted;
      $btnMute.title = $video.muted ? 'Unmute' : 'Mute';
    });

    $btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
