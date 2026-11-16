'use strict';

// Rolling buffer of live SmartSpectra readings, summarised for commit stamps.
// Only aggregate numbers ever leave this module: no frames, no raw waveforms.

const WINDOW_MS = 60_000; // a commit is stamped with the last minute of readings

class VitalsBuffer {
  constructor({ windowMs = WINDOW_MS, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.samples = []; // { t, pulse, breathing }
  }

  push({ pulse = null, breathing = null }, t = this.now()) {
    const ok = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    const sample = {
      t,
      pulse: ok(pulse, 35, 220) ? pulse : null,
      breathing: ok(breathing, 3, 60) ? breathing : null,
    };
    if (sample.pulse === null && sample.breathing === null) return false;
    this.samples.push(sample);
    this.prune(t);
    return true;
  }

  prune(t = this.now()) {
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  summary(t = this.now()) {
    this.prune(t);
    const pulses = this.samples.map((s) => s.pulse).filter((v) => v !== null);
    const breaths = this.samples.map((s) => s.breathing).filter((v) => v !== null);
    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const pulse = median(pulses);
    const breathing = median(breaths);
    const span = this.samples.length ? (t - this.samples[0].t) / 1000 : 0;
    return {
      pulse: pulse === null ? null : Math.round(pulse),
      breathing: breathing === null ? null : Math.round(breathing * 10) / 10,
      samples: this.samples.length,
      seconds: Math.round(span),
      // Need at least 15 s of readings before a stamp is trustworthy.
      ready: pulses.length >= 5 && span >= 15,
    };
  }
}

// A gentle, non-medical label. This is a mood ring for code, not a diagnosis.
function moodLabel(pulse, baseline) {
  if (pulse == null) return 'unknown';
  const ref = baseline ?? 70;
  const delta = pulse - ref;
  if (delta >= 15) return 'racing';
  if (delta >= 7) return 'elevated';
  if (delta <= -5) return 'deep calm';
  return 'calm';
}

module.exports = { VitalsBuffer, moodLabel, WINDOW_MS };
