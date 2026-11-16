'use strict';
const test = require('node:test');
const assert = require('node:assert');
const jpeg = require('jpeg-js');
const { extractJpegs } = require('../lib/mjpeg');

function tinyJpeg() {
  const w = 4, h = 2, data = Buffer.alloc(w * h * 4, 200);
  return jpeg.encode({ data, width: w, height: h }, 90).data;
}

test('extractJpegs splits multipart MJPEG and keeps the partial tail', () => {
  const a = tinyJpeg();
  const b = tinyJpeg();
  const part = (img) => Buffer.concat([Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), img, Buffer.from('\r\n')]);
  const stream = Buffer.concat([part(a), part(b), part(a).subarray(0, 60)]);
  const { images, rest } = extractJpegs(stream);
  assert.strictEqual(images.length, 2);
  assert.ok(images[0].equals(a));
  const decoded = jpeg.decode(images[1], { formatAsRGBA: false, useTArray: true });
  assert.strictEqual(decoded.data.length, 4 * 2 * 3);
  assert.ok(rest.length > 0 && rest[0] === 0xff && rest[1] === 0xd8);
});
