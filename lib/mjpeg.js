'use strict';
// Network camera input: reads an MJPEG stream (for example the DroidCam phone
// app at http://<phone-ip>:4747/video) and hands decoded RGB frames to a
// callback. Used with SmartSpectra's custom-input mode when a virtual webcam
// driver delivers blank frames to Media Foundation.
const http = require('http');
const jpeg = require('jpeg-js');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// Pulls complete JPEG images out of a growing byte buffer.
function extractJpegs(buf) {
  const images = [];
  let start = buf.indexOf(SOI);
  while (start !== -1) {
    const end = buf.indexOf(EOI, start + 2);
    if (end === -1) break;
    images.push(buf.subarray(start, end + 2));
    buf = buf.subarray(end + 2);
    start = buf.indexOf(SOI);
  }
  const rest = start === -1 ? Buffer.alloc(0) : Buffer.from(buf.subarray(start));
  return { images, rest };
}

// onFrame(rgb, width, height, timestampUs, jpeg). Returns { stop() }.
function readMjpeg(url, onFrame, { maxFps = 30, onError = () => {} } = {}) {
  let pending = Buffer.alloc(0);
  let lastTs = 0;
  let stopped = false;
  const minGapUs = Math.floor(1e6 / maxFps);
  const req = http.get(url, (res) => {
    if (!/multipart|jpeg/i.test(res.headers['content-type'] || '')) {
      onError(new Error(`Stream is not MJPEG (${res.headers['content-type']}). Is the phone app busy with another client?`));
      res.destroy();
      return;
    }
    res.on('data', (chunk) => {
      if (stopped) return;
      pending = Buffer.concat([pending, chunk]);
      const { images, rest } = extractJpegs(pending);
      pending = rest.length > 4 * 1024 * 1024 ? Buffer.alloc(0) : rest;
      // Only decode the newest image so a slow decode never builds a backlog.
      const latest = images[images.length - 1];
      if (!latest) return;
      const ts = Math.max(Math.floor(performance.timeOrigin * 1000 + performance.now() * 1000), lastTs + 1);
      if (ts - lastTs < minGapUs) return;
      try {
        const img = jpeg.decode(latest, { formatAsRGBA: false, useTArray: true });
        lastTs = ts;
        onFrame(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, ts, Buffer.from(latest));
      } catch (err) {
        onError(err);
      }
    });
    res.on('end', () => !stopped && onError(new Error('Stream ended')));
  });
  req.on('error', (err) => !stopped && onError(err));
  return {
    stop() {
      stopped = true;
      req.destroy();
    },
  };
}

module.exports = { readMjpeg, extractJpegs };
