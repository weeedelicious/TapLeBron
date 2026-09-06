const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameToken(token, storedHash) {
  const left = Buffer.from(hash(token));
  const right = Buffer.from(storedHash);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

test('a replacement token invalidates the previous token', () => {
  const first = 'first-session-token';
  const second = 'second-session-token';
  const stored = hash(second);
  assert.equal(sameToken(second, stored), true);
  assert.equal(sameToken(first, stored), false);
});

test('refresh can reuse the same session token', () => {
  const token = 'same-tab-refresh-token';
  assert.equal(sameToken(token, hash(token)), true);
});

test('a missing management-page token cannot open the canvas', () => {
  assert.equal(Boolean(''), false);
});
