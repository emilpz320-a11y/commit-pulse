'use strict';

// Commit Pulse: a local companion that reads pulse and breathing from your
// webcam with the Presage SmartSpectra SDK, stamps the median of the last
// minute onto every git commit you make, and maps which files raise your pulse.
//
// Usage:
//   node server.js                 # live camera via SmartSpectra (needs PRESAGE_API_KEY)
//   node server.js --simulate      # UI development only: synthetic readings, clearly labelled
//   COMMIT_PULSE_STREAM="http://<phone-ip>:4747/video?640x480" node server.js   # phone camera over Wi-Fi (MJPEG)
//
// Everything listens on 127.0.0.1 only.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { VitalsBuffer, moodLabel } = require('./lib/vitals');
const { readCommits, buildStressMap } = require('./lib/stressmap');
const { readMjpeg } = require('./lib/mjpeg');

const PORT = Number(process.env.COMMIT_PULSE_PORT || 47647);
const SIMULATE = process.argv.includes('--simulate');
const ROOT = __dirname;

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const state = {
  buffer: new VitalsBuffer(),
  paused: false,
  source: SIMULATE ? 'simulated' : 'camera',
  status: 'starting',
  hint: '',
  lastPulse: null,
  lastBreathing: null,
  baseline: null,
  history: [], // last 5 minutes of { t, pulse, breathing } for the live chart
  error: null,
};

function record(pulse, breathing) {
  const t = Date.now();
  if (pulse != null) state.lastPulse = Math.round(pulse);
  if (breathing != null) state.lastBreathing = Math.round(breathing * 10) / 10;
  state.buffer.push({ pulse, breathing }, t);
  state.history.push({ t, pulse: state.lastPulse, breathing: state.lastBreathing });
  while (state.history.length && state.history[0].t < t - 5 * 60_000) state.history.shift();
}

// ------------------------------------------------------------------ sensing

let sdk = null;
let streamReader = null;

// Local camera preview (stream input only): the newest JPEG is kept in memory
// and relayed to dashboard viewers on 127.0.0.1. Nothing is written to disk,
// and pausing the camera ends every preview connection.
const preview = {
  clients: new Set(),
  lastSent: 0,
  publish(jpegBytes) {
    const t = Date.now();
    if (!this.clients.size || t - this.lastSent < 66) return; // ~15 fps is plenty for a preview
    this.lastSent = t;
    for (const res of this.clients) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBytes.length}\r\n\r\n`);
      res.write(jpegBytes);
      res.write('\r\n');
    }
  },
  closeAll() {
    for (const res of this.clients) res.end();
    this.clients.clear();
  },
};

function lastValue(arr) {
  return arr && arr.length ? arr[arr.length - 1].value : null;
}

async function startCamera() {
  const {
    SmartSpectraSDK,
    CameraSelection,
    ProcessingStatus,
    ValidationCode,
    breathingMetrics,
    cardioMetrics,
    decodeMetrics,
  } = require('@smartspectra/node-sdk');
  if (!process.env.PRESAGE_API_KEY) {
    state.status = 'no-api-key';
    state.error = 'Set PRESAGE_API_KEY in .env (free key at physiology.presagetech.com)';
    console.error(state.error);
    return;
  }
  const statusName = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));
  const validationName = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));
  sdk = new SmartSpectraSDK({
    apiKey: process.env.PRESAGE_API_KEY,
    // COMMIT_PULSE_METRICS=cardio reads pulse from the face only (no chest framing needed).
    requestedMetrics:
      process.env.COMMIT_PULSE_METRICS === 'cardio' ? [...cardioMetrics] : [...breathingMetrics, ...cardioMetrics],
    enableTelemetry: process.env.SMARTSPECTRA_TELEMETRY === '1', // off unless the user opts in
  });
  sdk.on('processingStatus', (s) => (state.status = statusName[s] || String(s)));
  sdk.on('validationStatus', (code, _ts, hint) => {
    state.hint = code === ValidationCode.kOk ? '' : hint || validationName[code] || String(code);
  });
  sdk.on('metrics', (buf) => {
    const m = decodeMetrics(buf);
    record(lastValue(m.cardio?.pulseRate), lastValue(m.breathing?.rate));
  });
  sdk.on('error', (code, message) => {
    state.error = `SmartSpectra error ${code}: ${message}`;
    console.error(state.error);
  });
  const streamUrl = process.env.COMMIT_PULSE_STREAM;
  if (streamUrl) {
    // Network camera (e.g. a phone running DroidCam: http://<phone-ip>:4747/video).
    // Frames are decoded here and pushed through SmartSpectra's custom input.
    state.camera = `stream ${streamUrl}`;
    sdk.useCustomInput();
  } else {
    // Many USB webcams report facing "unknown", so pick an explicit camera by id
    // (COMMIT_PULSE_CAMERA = index into availableCameras(), default 0) at a
    // conservative capture mode instead of relying on CameraSelection.default.
    const cameras = SmartSpectraSDK.availableCameras();
    const pick = cameras[Number(process.env.COMMIT_PULSE_CAMERA || 0)];
    state.camera = pick ? pick.name || pick.id : 'default';
    sdk.useCamera(pick ? CameraSelection.byId(pick.id) : CameraSelection.default, {
      width: Number(process.env.COMMIT_PULSE_WIDTH || 640),
      height: Number(process.env.COMMIT_PULSE_HEIGHT || 480),
      fps: Number(process.env.COMMIT_PULSE_FPS || 30),
    });
  }
  try {
    sdk.start();
    if (streamUrl) {
      const { PixelFormat } = require('@smartspectra/node-sdk');
      const live = sdk;
      streamReader = readMjpeg(
        streamUrl,
        (rgb, w, h, ts, jpegBytes) => {
          if (sdk !== live) return;
          live.sendFrame(rgb, w, h, w * 3, PixelFormat.kRGB, ts);
          preview.publish(jpegBytes);
        },
        {
          // SmartSpectra needs >= 25 fps; only drop frames that arrive faster than 60 fps.
          maxFps: Number(process.env.COMMIT_PULSE_STREAM_FPS || 60),
          onError: (err) => {
            state.error = `Camera stream: ${err.message}`;
            console.error(state.error);
          },
        },
      );
    }
    state.status = 'measuring';
    state.error = null;
  } catch (err) {
    state.status = 'camera unavailable';
    state.error =
      `${err.message} Check that a webcam is connected, not in use by another app, ` +
      'and that Windows Settings > Privacy > Camera allows desktop apps. Then press Resume camera.';
    console.error(state.error);
    state.paused = true;
    await sdk.destroy().catch(() => {});
    sdk = null;
  }
}

async function stopCamera() {
  preview.closeAll();
  if (streamReader) {
    streamReader.stop();
    streamReader = null;
  }
  if (sdk) {
    await sdk.stopAsync();
    await sdk.destroy();
    sdk = null;
  }
}

function startSimulation() {
  // Synthetic, clearly-labelled readings so the UI and hook can be developed
  // without a camera. Never used for the published demo.
  let phase = 0;
  state.status = 'simulating';
  setInterval(() => {
    if (state.paused) return;
    phase += 0.05;
    record(72 + 8 * Math.sin(phase) + Math.random() * 2, 14 + 2 * Math.sin(phase / 2));
  }, 1000);
}

// ------------------------------------------------------------------ hooks

function installHook(repo) {
  const gitDir = path.join(repo, '.git');
  if (!fs.existsSync(gitDir)) throw new Error(`${repo} is not a git repository (no .git folder)`);
  const hooksDir = path.join(gitDir, 'hooks');
  const target = path.join(hooksDir, 'commit-pulse');
  fs.mkdirSync(target, { recursive: true });
  for (const f of ['hook.js', 'trailers.js']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(target, f));
  const hookFile = path.join(hooksDir, 'prepare-commit-msg');
  let chained = '';
  if (fs.existsSync(hookFile) && !fs.readFileSync(hookFile, 'utf8').includes('commit-pulse')) {
    fs.renameSync(hookFile, `${hookFile}.before-commit-pulse`);
    chained = `"$(dirname "$0")/prepare-commit-msg.before-commit-pulse" "$@" || exit $?\n`;
  }
  fs.writeFileSync(
    hookFile,
    `#!/bin/sh\n# Installed by Commit Pulse. Remove this file to stop stamping commits.\n${chained}node "$(dirname "$0")/commit-pulse/hook.js" "$@" || true\n`,
    { mode: 0o755 },
  );
  return { installed: hookFile, chainedPrevious: Boolean(chained) };
}

function uninstallHook(repo) {
  const hooksDir = path.join(repo, '.git', 'hooks');
  const hookFile = path.join(hooksDir, 'prepare-commit-msg');
  if (fs.existsSync(hookFile) && fs.readFileSync(hookFile, 'utf8').includes('commit-pulse')) fs.unlinkSync(hookFile);
  if (fs.existsSync(`${hookFile}.before-commit-pulse`)) fs.renameSync(`${hookFile}.before-commit-pulse`, hookFile);
  fs.rmSync(path.join(hooksDir, 'commit-pulse'), { recursive: true, force: true });
  return { removed: true };
}

// ------------------------------------------------------------------ http

function nowPayload() {
  const s = state.buffer.summary();
  return {
    ...s,
    mood: moodLabel(s.pulse, state.baseline),
    paused: state.paused,
    source: state.source,
    status: state.status,
    hint: state.hint,
    live: { pulse: state.lastPulse, breathing: state.lastBreathing },
    error: state.error,
    preview: Boolean(streamReader) && !state.paused,
  };
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/now') return send(res, 200, nowPayload());
    if (req.method === 'GET' && url.pathname === '/camera.mjpeg') {
      if (!streamReader || state.paused) return send(res, 404, { error: 'no live preview' });
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
      preview.clients.add(res);
      req.on('close', () => preview.clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') return send(res, 200, state.history);
    if (req.method === 'POST' && url.pathname === '/pause') {
      state.paused = true;
      if (!SIMULATE) await stopCamera();
      state.status = 'paused (camera off)';
      return send(res, 200, nowPayload());
    }
    if (req.method === 'POST' && url.pathname === '/resume') {
      state.paused = false;
      if (!SIMULATE) await startCamera();
      return send(res, 200, nowPayload());
    }
    const repo = url.searchParams.get('repo');
    if (url.pathname === '/install-hook' && req.method === 'POST') return send(res, 200, installHook(repo));
    if (url.pathname === '/uninstall-hook' && req.method === 'POST') return send(res, 200, uninstallHook(repo));
    if (url.pathname === '/stress-map' && req.method === 'GET') {
      const map = buildStressMap(readCommits(repo));
      if (map.baseline != null) state.baseline = map.baseline;
      return send(res, 200, map);
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Commit Pulse on http://127.0.0.1:${PORT}  (source: ${state.source})`);
  if (SIMULATE) startSimulation();
  else await startCamera();
});

process.on('SIGINT', async () => {
  await stopCamera().catch(() => {});
  process.exit(0);
});
