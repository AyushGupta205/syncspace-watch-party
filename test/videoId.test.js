import test from 'node:test';
import assert from 'node:assert/strict';
import { videoIdFrom } from '../src/videoId.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

test('parses supported YouTube video URL forms and raw IDs', () => {
  assert.equal(videoIdFrom(VIDEO_ID), VIDEO_ID);
  assert.equal(videoIdFrom(`https://youtu.be/${VIDEO_ID}`), VIDEO_ID);
  assert.equal(videoIdFrom(`https://www.youtube.com/watch?v=${VIDEO_ID}`), VIDEO_ID);
  assert.equal(videoIdFrom(`https://m.youtube.com/shorts/${VIDEO_ID}`), VIDEO_ID);
  assert.equal(videoIdFrom(`https://youtube.com/embed/${VIDEO_ID}`), VIDEO_ID);
  assert.equal(videoIdFrom(`youtube.com/live/${VIDEO_ID}`), VIDEO_ID);
});

test('rejects malformed or non-YouTube video references', () => {
  assert.equal(videoIdFrom(''), '');
  assert.equal(videoIdFrom('not a video'), '');
  assert.equal(videoIdFrom('https://example.com/watch?v=' + VIDEO_ID), '');
  assert.equal(videoIdFrom('https://youtube.com/watch?v=short'), '');
});
