#!/usr/bin/env node
'use strict';

// prepare-commit-msg hook installed by Commit Pulse.
// Asks the local Commit Pulse app (127.0.0.1 only) for the last minute of
// readings and appends them as git trailers. If the app is not running, the
// camera is off or readings are not ready yet, it does nothing: committing
// never blocks and never fails because of this hook.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { formatTrailers, appendTrailers } = require(path.join(__dirname, 'trailers.js'));

const PORT = Number(process.env.COMMIT_PULSE_PORT || 47647);

function getNow() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/now', timeout: 600 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function main() {
  const [msgFile, source] = process.argv.slice(2);
  if (!msgFile) return;
  // Leave merges, squashes and re-used messages alone.
  if (['merge', 'squash', 'commit'].includes(source)) return;
  const now = await getNow();
  if (!now || !now.ready || now.paused) return;
  const lines = formatTrailers(now, now.mood);
  if (!lines.length) return;
  const msg = fs.readFileSync(msgFile, 'utf8');
  fs.writeFileSync(msgFile, appendTrailers(msg, lines));
}

main().catch(() => {});
