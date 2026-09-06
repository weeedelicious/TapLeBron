'use strict';

// Verifies the Cindy proposal `settings` whitelist added so the assistant can
// carry generation params (duration/ratio/resolution/count) into image/video
// nodes. Tests the PUBLIC normalizeProposal path (the real server gate), not an
// internal helper. Run: node --test tests/cindy-proposal-settings.test.js
//
// Note: authoritative model-specific snapping (e.g. 16s -> 15, count 3 -> 1)
// happens client-side in Canvas.tsx via videoRules/imageRules; the server only
// does coarse type-coercion + broad clamping, which is what this file checks.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Dummy env so server/config.js (required transitively) loads without throwing.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'test-admin';
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'test';

const { normalizeProposal } = require(path.join(__dirname, '..', 'server', 'services', 'CindyAssistantService.js'));

// Build a proposal with a single node of `type` carrying `settings`, run it
// through the server whitelist, and return the normalized node.
function normNode(type, settings) {
  const result = normalizeProposal(
    { title: 't', summary: 's', nodes: [{ id: 'n1', type, name: 'x', prompt: 'p', settings }], connections: [] },
    { nodes: [] },
  );
  assert.ok(result && result.nodes.length === 1, `expected 1 normalized node for type=${type}`);
  return result.nodes[0];
}

test('video: valid settings survive the whitelist', () => {
  const n = normNode('video', { ratio: '9:16', resolution: '720P', duration: 8, count: 2 });
  assert.deepEqual(n.settings, { ratio: '9:16', resolution: '720P', count: 2, duration: 8 });
});

test('video: duration is coarse-clamped to 1..60 (client snaps to model range later)', () => {
  assert.equal(normNode('video', { duration: 999 }).settings.duration, 60);
  assert.equal(normNode('video', { duration: 0 }).settings.duration, 1);
  assert.equal(normNode('video', { duration: 8.6 }).settings.duration, 9); // rounded
});

test('video: count coarse-clamped to 1..10', () => {
  assert.equal(normNode('video', { count: 99 }).settings.count, 10);
  assert.equal(normNode('video', { count: 0 }).settings.count, 1);
});

test('video: non-numeric duration/count dropped, string ratio kept', () => {
  const n = normNode('video', { ratio: 'anything', duration: 'abc', count: 'xyz' });
  assert.equal(n.settings.ratio, 'anything'); // server keeps string; client normalizes to a valid ratio
  assert.ok(!('duration' in n.settings));
  assert.ok(!('count' in n.settings));
});

test('image: no duration field even if model emits one', () => {
  const n = normNode('image', { ratio: '9:16', resolution: '2K', duration: 8, count: 3 });
  assert.equal(n.settings.ratio, '9:16');
  assert.equal(n.settings.resolution, '2K');
  assert.equal(n.settings.count, 3);
  assert.ok(!('duration' in n.settings), 'image must not carry duration');
});

test('text/audio: settings are dropped entirely', () => {
  assert.ok(!('settings' in normNode('text', { ratio: '9:16', duration: 8 })));
  assert.ok(!('settings' in normNode('audio', { ratio: '9:16', duration: 8 })));
});

test('empty/absent settings => node has no settings key', () => {
  assert.ok(!('settings' in normNode('video', {})));
  assert.ok(!('settings' in normNode('video', undefined)));
});
