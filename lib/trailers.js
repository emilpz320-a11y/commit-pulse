'use strict';

// Git trailer helpers shared by the commit hook and the stress map.

const KEYS = {
  pulse: 'Heart-Rate',
  breathing: 'Breathing-Rate',
  mood: 'Commit-Pulse',
};

function formatTrailers(summary, mood) {
  const lines = [];
  if (summary.pulse != null) lines.push(`${KEYS.pulse}: ${summary.pulse} bpm`);
  if (summary.breathing != null) lines.push(`${KEYS.breathing}: ${summary.breathing} /min`);
  if (lines.length) lines.push(`${KEYS.mood}: ${mood} (median of last ${summary.seconds}s, SmartSpectra)`);
  return lines;
}

// Append trailers to a commit message, keeping git's trailer block rules:
// a blank line before the block, and no duplicates if the hook runs twice (amend).
function appendTrailers(message, trailerLines) {
  if (!trailerLines.length) return message;
  const keep = message
    .split(/\r?\n/)
    .filter((l) => !Object.values(KEYS).some((k) => l.startsWith(`${k}:`)));
  // Git puts comment lines (starting with #) at the end of the template; insert before them.
  let end = keep.length;
  while (end > 0 && (keep[end - 1].startsWith('#') || keep[end - 1].trim() === '')) end--;
  const body = keep.slice(0, end);
  const tail = keep.slice(end).filter((l) => l.startsWith('#'));
  // The last line only counts as an existing trailer block if it is NOT in the
  // first paragraph: "fix: handle null" is a conventional-commit subject, not a trailer.
  const firstBlank = body.findIndex((l) => l.trim() === '');
  const lastIsTrailer =
    body.length > 0 &&
    firstBlank !== -1 &&
    firstBlank < body.length - 1 &&
    /^[A-Za-z-]+: /.test(body[body.length - 1]);
  const out = [...body];
  if (!lastIsTrailer) out.push('');
  out.push(...trailerLines);
  if (tail.length) out.push('', ...tail);
  return out.join('\n') + '\n';
}

function parsePulse(value) {
  const m = /(\d+(?:\.\d+)?)/.exec(value || '');
  return m ? Number(m[1]) : null;
}

module.exports = { KEYS, formatTrailers, appendTrailers, parsePulse };
