'use strict';

// Reads Heart-Rate trailers from git history and ranks files by how far the
// pulse at commit time sits above the author's own baseline (median).

const { execFileSync } = require('child_process');
const { KEYS, parsePulse } = require('./trailers');

const SEP = '\x1f';
const REC = '\x1e';

function readCommits(repo) {
  const fmt = `${REC}%H${SEP}%aI${SEP}%s${SEP}%(trailers:key=${KEYS.pulse},valueonly,separator=;)`;
  const out = execFileSync('git', ['-C', repo, 'log', `--format=${fmt}`, '--name-only', '-n', '2000'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split(REC)
    .filter((r) => r.trim())
    .map((rec) => {
      const [head, ...rest] = rec.split('\n');
      const [hash, date, subject, hr] = head.split(SEP);
      const files = rest.map((l) => l.trim()).filter(Boolean);
      return { hash, date, subject, pulse: parsePulse(hr), files };
    });
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function buildStressMap(commits, { minCommits = 1, top = 10 } = {}) {
  const stamped = commits.filter((c) => c.pulse != null);
  const baseline = median(stamped.map((c) => c.pulse));
  const perFile = new Map();
  for (const c of stamped) {
    for (const f of c.files) {
      const e = perFile.get(f) || { file: f, pulses: [] };
      e.pulses.push(c.pulse);
      perFile.set(f, e);
    }
  }
  const files = [...perFile.values()]
    .filter((e) => e.pulses.length >= minCommits)
    .map((e) => {
      const avg = e.pulses.reduce((a, b) => a + b, 0) / e.pulses.length;
      return {
        file: e.file,
        commits: e.pulses.length,
        avgPulse: Math.round(avg),
        delta: baseline == null ? 0 : Math.round(avg - baseline),
      };
    })
    .sort((a, b) => b.delta - a.delta || b.commits - a.commits)
    .slice(0, top);
  const timeline = stamped
    .map((c) => ({ date: c.date, pulse: c.pulse, subject: c.subject, hash: c.hash.slice(0, 7) }))
    .reverse();
  return { baseline, stampedCommits: stamped.length, totalCommits: commits.length, files, timeline };
}

module.exports = { readCommits, buildStressMap, median };
