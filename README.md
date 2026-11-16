# ♥ Commit Pulse

**Your git history, with a heartbeat.** Commit Pulse reads your pulse and breathing from the webcam with the [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra). It stamps the median of the last minute onto every commit you make, then draws a **stress map** of the files that raise your heart rate.

```
fix: handle expired refresh token

Heart-Rate: 91 bpm
Breathing-Rate: 17.5 /min
Commit-Pulse: racing (median of last 60s, SmartSpectra)
```

Your `auth/` folder probably makes your heart race. Now you can prove it.

## How it works

```
webcam ─▶ SmartSpectra SDK (local, Node) ─▶ 60 s rolling median ─▶ 127.0.0.1:47647
                                                        │
git commit ─▶ prepare-commit-msg hook ─ GET /now ───────┘─▶ Heart-Rate / Breathing-Rate trailers
git log ─▶ stress map: avg pulse per file vs your own baseline (median)
```

- `server.js` runs the SmartSpectra SDK headless in Node: `useCamera(CameraSelection.default)` with the breathing and cardio metric bundles. It keeps a 60-second rolling buffer and serves a small dashboard on `http://127.0.0.1:47647`.
- **Install commit hook** writes `.git/hooks/prepare-commit-msg`. It chains any hook you already had, and it never blocks a commit: no app, no reading, or a paused camera all mean no stamp.
- **Stress map** reads `Heart-Rate` trailers from `git log`. It ranks files by how far their commits sit above *your* baseline, so it compares you with you rather than with a population norm.
- Merge, squash and amend-with-same-message commits are left alone. Conventional-commit subjects such as `fix: …` are handled correctly, and a test covers it.

## Run it

Requirements: Windows x64, macOS (Apple silicon) or Linux; Node 20 or newer; a webcam; git.

```bash
npm install
cp .env.example .env        # add PRESAGE_API_KEY from https://physiology.presagetech.com (free)
node server.js              # open http://127.0.0.1:47647
```

In the dashboard:
1. Wait for "mood: …". That needs about 15 s of a steady, well-lit face.
2. Paste a repository path.
3. Press **Install commit hook**.
4. Commit as usual.
5. Press **Stress map** whenever you're curious.

### Phone camera over Wi-Fi

No webcam, or a virtual webcam driver that hands the SDK blank frames? (DroidCam's Windows driver did exactly that during development: every frame Media Foundation delivered was solid green, so the SDK kept reporting "No face found.") Point Commit Pulse at the phone's MJPEG stream instead:

```bash
COMMIT_PULSE_STREAM="http://<phone-ip>:4747/video?640x480" node server.js
```

`lib/mjpeg.js` splits the multipart stream into JPEGs, decodes the newest one with `jpeg-js`, and pushes RGB frames through SmartSpectra's custom input (`useCustomInput()` + `sendFrame()`) with real capture timestamps. Close the DroidCam PC client first: the phone app serves one client at a time. Keep it at 640×480: the SDK needs at least 25 fps, and decoding 720p in pure JavaScript is too slow for that on one core.

`node server.js --simulate` produces clearly labelled synthetic readings for UI work without a camera. It is never used for real stamps.

Tests: `npm test`. These are unit tests plus an end-to-end test that runs the server, installs the hook into a temporary repo, makes real commits, checks the trailers and the stress map, and confirms that pausing stops stamping.

## Consent and data handling

- **Camera:** on only while the dashboard says *measuring*. **Pause camera** stops the SDK and releases the device.
- **Frames:** processed on this machine by the SmartSpectra SDK and never written to disk or sent anywhere by Commit Pulse.
- **What is stored:** only three short trailers, added to commits *you* make in repositories where *you* installed the hook. Remove the hook (dashboard button, or delete `.git/hooks/prepare-commit-msg`) or use `git commit --no-verify` to skip a commit. Trailers are part of git history: think twice before pushing them to a public repository, or rewrite them before pushing.
- **Retention and deletion:** Commit Pulse keeps no database. The rolling buffer holds at most 60 s of numbers (5 minutes for the live chart) in memory and disappears when the app closes.
- **SDK telemetry:** **off by default** (`enableTelemetry: false`). Set `SMARTSPECTRA_TELEMETRY=1` to opt in. Presage's [telemetry docs](https://github.com/Presage-Security/SmartSpectra/blob/main/docs/telemetry-and-privacy.md) list what the SDK's session summaries contain. They never include frames or measured vitals.
- **Network:** the SDK authenticates your API key with Presage; there is no offline mode. The dashboard and the hook only talk to `127.0.0.1`.
- **No AI services** are used.
- **Not medical:** this is a playful self-awareness tool, not a diagnostic device. "Racing" means "above *your* usual", nothing more.

## Project layout

- `server.js`: SDK session, rolling buffer, local API, hook installer.
- `lib/vitals.js`: 60 s rolling median, readiness gate, mood label.
- `lib/trailers.js`: trailer formatting and safe insertion.
- `lib/hook.js`: the `prepare-commit-msg` hook, which is copied into each repo.
- `lib/stressmap.js`: `git log` parsing and the per-file comparison with your baseline.
- `lib/mjpeg.js`: optional network-camera input (MJPEG over HTTP) for SmartSpectra's custom-input mode.
- `public/index.html`: the dashboard.
- `tests/core.test.js`: unit and end-to-end tests. `tests/mjpeg.test.js`: MJPEG stream splitting.

MIT licensed. Built for the DEV Presage SmartSpectra SDK Challenge.
