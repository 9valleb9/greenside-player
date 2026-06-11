/**
 * Greenside Player — hls.js configuration for the kiosk live stream.
 *
 * Extracted into its own file so it is unit-testable in Node AND loadable as a
 * plain <script> in the browser (no build step in this repo).
 *
 * The kiosk is a PASSIVE display — nobody interacts with it, so latency does NOT
 * matter; it should buffer DEEP and sit well back from the live edge to ride out
 * last-mile network jitter. There is a SINGLE rendition (no ABR), so there is no
 * lower-bitrate variant to fall back to: a thin buffer means any dip = a stall.
 *
 * The previous config did the opposite — `lowLatencyMode: true` parked the player
 * right at the live edge with only ~10s of buffer, so every bit of jitter drained
 * it and caused the "jumpy" stalls. This config kills low-latency mode, sits ~18s
 * back, buffers deep, catches up smoothly (rate, not seek), and retries patiently
 * on slow/failed segment fetches.
 *
 * Origin produces 2.0s segments; durations below are in seconds. Buffer depth is
 * ultimately bounded by the live window the origin retains, but we ask for as
 * much cushion as it will give us.
 */
(function (root) {
  'use strict';

  function buildHlsConfig() {
    return {
      enableWorker: true,

      // Passive kiosk: do NOT chase the live edge. lowLatencyMode parks the
      // playhead ~at the edge with a tiny buffer — exactly what made it jumpy.
      lowLatencyMode: false,

      // Sit ~18s behind live and tolerate up to 60s of latency before a catch-up.
      // When we fall behind, speed up to 1.5x to close the gap SMOOTHLY instead
      // of seeking forward (a seek looks like a visible jump on the TV).
      liveSyncDuration: 18,
      liveMaxLatencyDuration: 60,
      maxLiveSyncPlaybackRate: 1.5,

      // Deep forward + back buffer to absorb jitter (bounded by the live window).
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      backBufferLength: 30,

      // No ABR fallback, so a slow/failed segment fetch must RETRY patiently (the
      // deep buffer covers the delay) rather than erroring straight to a stall.
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 20000,
          maxLoadTimeMs: 120000,
          timeoutRetry: { maxNumRetry: 6, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'linear' },
        },
      },

      // Nudge past brief buffer stalls more persistently before giving up.
      nudgeMaxRetry: 10,
    };
  }

  root.buildHlsConfig = buildHlsConfig;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildHlsConfig };
  }
})(typeof window !== 'undefined' ? window : globalThis);
