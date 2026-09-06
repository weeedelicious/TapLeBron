const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeNodeSnapshots } = require('./CanvasCollaborationService');

const node = (nodeKey, value) => ({ nodeKey, data: JSON.stringify({ value }) });

test('merges independent node additions', () => {
  const result = mergeNodeSnapshots([], [node('a', 1)], [node('b', 2)]);
  assert.equal(result.merged, true);
  assert.deepEqual(result.nodes.map((item) => item.nodeKey), ['b', 'a']);
});

test('preserves remote changes while applying a local node update', () => {
  const base = [node('a', 1), node('b', 1)];
  const incoming = [node('a', 2), node('b', 1)];
  const current = [node('a', 1), node('b', 2)];
  const result = mergeNodeSnapshots(base, incoming, current);
  assert.equal(result.merged, true);
  assert.equal(JSON.parse(result.nodes[0].data).value, 2);
  assert.equal(JSON.parse(result.nodes[1].data).value, 2);
});

test('rejects edits to the same node', () => {
  const result = mergeNodeSnapshots([node('a', 1)], [node('a', 2)], [node('a', 3)]);
  assert.equal(result.merged, false);
  assert.deepEqual(result.conflictNodeKeys, ['a']);
});

test('keeps a remote addition when local snapshot deletes another node', () => {
  const result = mergeNodeSnapshots([node('a', 1)], [], [node('a', 1), node('b', 2)]);
  assert.equal(result.merged, true);
  assert.deepEqual(result.nodes.map((item) => item.nodeKey), ['b']);
});

test('does not lose an independently created video node', () => {
  const video = { nodeKey: 'video-1', data: JSON.stringify({ type: 'video', url: ['/assets/video.mp4'] }) };
  const text = { nodeKey: 'text-1', data: JSON.stringify({ type: 'text', text: 'story' }) };
  const result = mergeNodeSnapshots([], [video], [text]);
  assert.equal(result.merged, true);
  assert.deepEqual(result.nodes.map((item) => item.nodeKey), ['text-1', 'video-1']);
});
