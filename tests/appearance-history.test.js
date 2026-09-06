'use strict';

// Unit tests for the appearance-transfer history read model (Phase C).
// Pure classification logic over fake generation_tasks rows — no DB.
//   node --test tests/appearance-history.test.js
//
// Guards the "mandatory re-verify" contract: results come from the persisted
// ledger and are classified by EXPLICIT appearanceLightingMode (manifest as
// legacy fallback), isolated per processor node, never inferred; quality
// warnings never remove a result; legacy method ids project read-only.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Provide dummy env so requiring server/db (via the service) never throws.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'test-admin';
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'test';

const svc = require(path.join(__dirname, '..', 'server', 'services', 'appearanceHistoryService'));

function row(opts = {}) {
  return {
    job_id: opts.jobId || 'job-x',
    node_key: opts.nodeKey || 'node-x',
    model: opts.model || 'gemini-3-pro-image',
    request_params: JSON.stringify({ appearanceTransfer: opts.settings || {} }),
    result_urls: JSON.stringify(opts.urls === undefined ? ['/assets/projects/p/x.png'] : opts.urls),
    status: 'succeeded',
    created_at: opts.createdAt || '2026-07-31T10:00:00Z',
    completed_at: opts.completedAt || null,
  };
}

const P = 'processor-1';

test('classifies preserve-scene and replace-background by explicit lighting mode', () => {
  const rows = [
    row({ jobId: 'a', settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' } }),
    row({ jobId: 'b', settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'replace-background' } }),
  ];
  const page = svc.buildHistoryPage(rows, P, 50);
  assert.strictEqual(page.schemaVersion, 1);
  assert.strictEqual(page.items.length, 2);
  assert.strictEqual(page.items.find((i) => i.jobId === 'a').mode, 'preserve-scene');
  assert.strictEqual(page.items.find((i) => i.jobId === 'b').mode, 'replace-background');
  assert.strictEqual(page.unclassifiedCount, 0);
});

test('falls back to manifest.mode only when explicit mode is absent (legacy)', () => {
  const r = row({
    settings: {
      appearanceProcessorNodeId: P,
      appearanceInputManifest: JSON.stringify({ mode: 'replace-background-relight' }),
    },
  });
  assert.strictEqual(svc.projectHistoryRow(r, P).item.mode, 'replace-background');
});

test('isolates by processor node (other processor is skipped, not counted)', () => {
  const rows = [
    row({ jobId: 'mine', settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' } }),
    row({ jobId: 'other', settings: { appearanceProcessorNodeId: 'processor-2', appearanceLightingMode: 'preserve-scene' } }),
  ];
  const page = svc.buildHistoryPage(rows, P, 50);
  assert.strictEqual(page.items.length, 1);
  assert.strictEqual(page.items[0].jobId, 'mine');
  assert.strictEqual(page.unclassifiedCount, 0);
});

test('non-appearance rows are skipped entirely', () => {
  const plain = { job_id: 'p', node_key: 'n', model: 'm', request_params: JSON.stringify({ prompt: 'hi' }), result_urls: JSON.stringify(['/assets/x.png']) };
  assert.strictEqual(svc.projectHistoryRow(plain, P).skip, true);
});

test('belongs-but-unclassifiable increments unclassifiedCount (no mode / no url)', () => {
  const noMode = row({ settings: { appearanceProcessorNodeId: P } });
  const noUrl = row({ settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' }, urls: [] });
  const page = svc.buildHistoryPage([noMode, noUrl], P, 50);
  assert.strictEqual(page.items.length, 0);
  assert.strictEqual(page.unclassifiedCount, 2);
});

test('quality warnings are retained, never filtered', () => {
  const r = row({ settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene', appearanceWarningMessage: 'quality advisory' } });
  const page = svc.buildHistoryPage([r], P, 50);
  assert.strictEqual(page.items.length, 1);
  assert.strictEqual(page.items[0].warningMessage, 'quality advisory');
});

test('legacy reference-pixel methods project read-only; direct-v1 ai-semantic is semantic-generate', () => {
  const legacy = row({ settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'replace-background', appearanceBackgroundTransferMethod: 'reference-pixels-v1', appearanceReferencePersonAction: 'remove-v1' } });
  const direct = row({ settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'replace-background', appearanceBackgroundTransferMethod: 'ai-semantic' } });
  const legacyItem = svc.projectHistoryRow(legacy, P).item;
  const directItem = svc.projectHistoryRow(direct, P).item;
  assert.strictEqual(legacyItem.backgroundTransferMethod, 'reference-pixels');
  assert.strictEqual(legacyItem.referencePersonAction, 'remove');
  assert.strictEqual(directItem.backgroundTransferMethod, 'semantic-generate');
  assert.strictEqual(directItem.referencePersonAction, 'keep');
});

test('confirmed / referenceAttached coerce from string settings; backendId falls back to model', () => {
  const r = row({
    model: 'gpt-image-2',
    settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene', appearanceConfirmed: 'true', appearanceReferenceAttached: 'false' },
  });
  const item = svc.projectHistoryRow(r, P).item;
  assert.strictEqual(item.confirmed, true);
  assert.strictEqual(item.referenceAttached, false);
  assert.strictEqual(item.backendId, 'gpt-image-2');
});

test('normalizes localhost asset origin to app-relative', () => {
  const r = row({ settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' }, urls: ['http://127.0.0.1:3020/assets/projects/p/x.png'] });
  assert.strictEqual(svc.projectHistoryRow(r, P).item.url, '/assets/projects/p/x.png');
});

test('items cap at limit while unclassifiedCount counts every belonging row', () => {
  const rows = [
    row({ jobId: 'i1', settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' } }),
    row({ jobId: 'i2', settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' } }),
    row({ jobId: 'i3', settings: { appearanceProcessorNodeId: P, appearanceLightingMode: 'preserve-scene' } }),
    row({ jobId: 'u1', settings: { appearanceProcessorNodeId: P } }),
    row({ jobId: 'u2', settings: { appearanceProcessorNodeId: P } }),
  ];
  const page = svc.buildHistoryPage(rows, P, 2);
  assert.strictEqual(page.items.length, 2);
  assert.strictEqual(page.unclassifiedCount, 2);
});
