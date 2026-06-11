'use strict';
// Run with: npm test   (Node's built-in test runner — no dependencies)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildHlsConfig } = require('../hls-config.js');

// The OLD config was { lowLatencyMode: true, maxBufferLength: 10,
// maxMaxBufferLength: 30 } with no live-sync tuning — that parked the player at
// the live edge with a thin buffer and made playback jumpy on a single-rendition
// (no-ABR) kiosk. Every assertion below fails against that old config: this is
// the regression guard the task asked for.

test('kiosk hls config buffers deep and sits back from the live edge', () => {
  const c = buildHlsConfig();
  assert.equal(c.lowLatencyMode, false, 'lowLatencyMode must be OFF for a passive kiosk');
  assert.ok(c.maxBufferLength >= 30, `maxBufferLength should be deep (>=30s), got ${c.maxBufferLength}`);
  assert.ok(c.maxMaxBufferLength >= c.maxBufferLength, 'maxMaxBufferLength must be >= maxBufferLength');
  assert.ok(c.backBufferLength >= 20, `keep a real back-buffer (>=20s), got ${c.backBufferLength}`);
  assert.ok(c.liveSyncDuration >= 12, `should sit well back from live (>=12s), got ${c.liveSyncDuration}`);
  assert.ok(
    c.liveMaxLatencyDuration > c.liveSyncDuration,
    'latency budget must exceed the live-sync target',
  );
  assert.ok(c.liveMaxLatencyDuration >= 30, `a kiosk can be 30s+ behind live, got ${c.liveMaxLatencyDuration}`);
  assert.ok(c.maxLiveSyncPlaybackRate > 1, 'catch up by speeding up (smooth), not by seeking (visible jump)');
});

test('kiosk hls config retries segment fetches patiently (no ABR fallback)', () => {
  const c = buildHlsConfig();
  const p = c.fragLoadPolicy && c.fragLoadPolicy.default;
  assert.ok(p, 'fragLoadPolicy.default must be present');
  assert.ok(p.errorRetry && p.errorRetry.maxNumRetry >= 4, 'must retry FAILED segment loads (>=4)');
  assert.ok(p.timeoutRetry && p.timeoutRetry.maxNumRetry >= 4, 'must retry SLOW segment loads (>=4)');
  assert.ok(c.nudgeMaxRetry >= 5, 'must nudge persistently past brief stalls (>=5)');
});

test('player.js wires buildHlsConfig + the stall watchdog and never re-adds low latency', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player.js'), 'utf8');
  assert.ok(/new Hls\(buildHlsConfig\(\)\)/.test(src), 'player.js must construct Hls from buildHlsConfig()');
  assert.ok(!/lowLatencyMode:\s*true/.test(src), 'player.js must not re-introduce lowLatencyMode: true');
  assert.ok(/startStallWatchdog\s*\(\)/.test(src), 'player.js must arm the stall watchdog on playback start');
  assert.ok(/stopStallWatchdog\s*\(\)/.test(src), 'player.js must clear the watchdog on teardown');
});

test('index.html loads hls-config.js before player.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const cfg = html.indexOf('hls-config.js');
  const player = html.indexOf('player.js');
  assert.ok(cfg !== -1, 'index.html must include hls-config.js');
  assert.ok(cfg < player, 'hls-config.js must load before player.js');
});

test('Dockerfile copies every local script/style index.html references', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  // Local .js/.css referenced in index.html (skip absolute CDN URLs + ?v=).
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1].split('?')[0])
    .filter((u) => /\.(js|css)$/.test(u) && !/^(https?:)?\/\//.test(u));
  assert.ok(refs.length >= 2, 'expected local assets in index.html');
  for (const ref of refs) {
    const base = ref.replace(/^\.?\//, '');
    const re = new RegExp('COPY\\s+' + base.replace(/\./g, '\\.') + '\\b');
    assert.ok(re.test(dockerfile), `index.html loads "${ref}" but the Dockerfile never COPYs it into the image (it would 404 on the kiosk)`);
  }
});
