'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { VitalsBuffer, moodLabel } = require('../lib/vitals');
const { formatTrailers, appendTrailers } = require('../lib/trailers');
const { readCommits, buildStressMap } = require('../lib/stressmap');

test('vitals buffer: median over the last minute, rejects implausible values', () => {
  let t = 0;
  const b = new VitalsBuffer({ now: () => t });
  for (let i = 0; i < 20; i++) {
    t = i * 1000;
    b.push({ pulse: 70 + (i % 3), breathing: 14 });
  }
  b.push({ pulse: 400, breathing: 0.5 }, t); // ignored
  const s = b.summary(t);
  assert.equal(s.pulse, 71);
  assert.equal(s.breathing, 14);
  assert.equal(s.ready, true);
  t = 200_000; // everything older than 60 s drops out
  assert.equal(b.summary(t).samples, 0);
});

test('mood labels are relative to the personal baseline', () => {
  assert.equal(moodLabel(90, 72), 'racing');
  assert.equal(moodLabel(80, 72), 'elevated');
  assert.equal(moodLabel(66, 72), 'deep calm');
  assert.equal(moodLabel(73, 72), 'calm');
});

test('conventional-commit subjects are not mistaken for trailers', () => {
  const out = appendTrailers('fix: handle null token\n', formatTrailers({ pulse: 80, breathing: 15, seconds: 60 }, 'calm'));
  assert.match(out, /^fix: handle null token\n\nHeart-Rate: 80 bpm/);
  const withBody = appendTrailers('feat: x\n\nbody text\n\nSigned-off-by: A <a@b.c>\n', ['Heart-Rate: 70 bpm']);
  assert.match(withBody, /Signed-off-by: A <a@b.c>\nHeart-Rate: 70 bpm\n$/);
});

test('trailers are appended once, before git comment lines, and replaced on amend', () => {
  const lines = formatTrailers({ pulse: 88, breathing: 16, seconds: 60 }, 'elevated');
  const msg = 'Fix flaky auth test\n\n# Please enter the commit message\n';
  const once = appendTrailers(msg, lines);
  assert.match(once, /Fix flaky auth test\n\nHeart-Rate: 88 bpm\nBreathing-Rate: 16 \/min\nCommit-Pulse: elevated/);
  assert.ok(once.indexOf('# Please') > once.indexOf('Commit-Pulse'));
  const twice = appendTrailers(once, formatTrailers({ pulse: 70, breathing: 12, seconds: 60 }, 'calm'));
  assert.equal((twice.match(/Heart-Rate:/g) || []).length, 1);
  assert.match(twice, /Heart-Rate: 70 bpm/);
});

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

test('end to end: hook stamps real commits from the running server, stress map ranks files', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  const port = 47000 + Math.floor(Math.random() * 900);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--simulate'], {
    env: { ...process.env, COMMIT_PULSE_PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(() => server.kill());
  const base = `http://127.0.0.1:${port}`;
  // wait for the server and for >15 s of simulated readings
  for (let i = 0; i < 60; i++) {
    try {
      const now = await (await fetch(`${base}/now`)).json();
      if (now.ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const inst = await (await fetch(`${base}/install-hook?repo=${encodeURIComponent(repo)}`, { method: 'POST' })).json();
  assert.ok(inst.installed.endsWith('prepare-commit-msg'));

  const env = { ...process.env, COMMIT_PULSE_PORT: String(port) };
  for (const [file, msg] of [['auth.js', 'auth: retry token refresh'], ['ui.css', 'tweak colours'], ['auth.js', 'auth: fix race']]) {
    fs.appendFileSync(path.join(repo, file), `${msg}\n`);
    git(repo, 'add', file);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', msg], { env });
  }
  const last = git(repo, 'log', '-1', '--format=%B');
  assert.match(last, /Heart-Rate: \d+ bpm/);
  assert.match(last, /Commit-Pulse: /);

  const map = buildStressMap(readCommits(repo));
  assert.equal(map.stampedCommits, 3);
  assert.ok(map.baseline > 40);
  assert.deepEqual(map.files.map((f) => f.file).sort(), ['auth.js', 'ui.css']);

  // pausing the camera stops stamping
  await fetch(`${base}/pause`, { method: 'POST' });
  fs.appendFileSync(path.join(repo, 'ui.css'), 'paused\n');
  git(repo, 'add', 'ui.css');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'while paused'], { env });
  assert.doesNotMatch(git(repo, 'log', '-1', '--format=%B'), /Heart-Rate/);

  const un = await (await fetch(`${base}/uninstall-hook?repo=${encodeURIComponent(repo)}`, { method: 'POST' })).json();
  assert.equal(un.removed, true);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'hooks', 'prepare-commit-msg')), false);
});
