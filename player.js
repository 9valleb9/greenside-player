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
  const API_BASE = (params.get('api') || 'http://10.1.10.205:3000').replace(/\/+$/, '');
  const MODE     = params.get('mode') || 'kiosk';   // kiosk | web
  const ROTATION = parseInt(params.get('rotate') || '0', 10);
  const POLL_INTERVAL = 10_000; // ms

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

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let hls = null;
  let currentHlsUrl = null;
  let isLive = false;
  let sponsorIndex = 0;
  let sponsors = [];
  let sponsorTimer = null;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    // Apply mode
    if (MODE === 'web') {
      document.body.classList.add('mode-web');
      $webControls.classList.remove('hidden');
      setupWebControls();
    }

    // Apply rotation
    if ([90, 180, 270].includes(ROTATION)) {
      document.body.classList.add('rotate-' + ROTATION);
    }

    // Start polling
    poll();
    setInterval(poll, POLL_INTERVAL);
  }

  // ---------------------------------------------------------------------------
  // API polling
  // ---------------------------------------------------------------------------
  async function poll() {
    try {
      const [statusRes, settingsRes] = await Promise.all([
        fetch(API_BASE + '/api/stream/status').then(r => r.json()),
        fetch(API_BASE + '/api/system/display-settings').then(r => r.json()),
      ]);
      handleStreamStatus(statusRes.data || {});
      handleDisplaySettings(settingsRes.data || {});
    } catch (_err) {
      // API unreachable — show offline
      goOffline();
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
    if (isLive && hlsUrl === currentHlsUrl) return;

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
  // Web controls
  // ---------------------------------------------------------------------------
  function setupWebControls() {
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
