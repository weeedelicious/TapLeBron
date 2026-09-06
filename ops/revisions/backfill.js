#!/usr/bin/env node
const crypto = require('crypto');
const { closePools, getContentPool, getPool } = require('../../server/db');

async function main() {
  const adminDb = getPool();
  const contentDb = getContentPool();
  const [rows] = await adminDb.query('SELECT id, owner_id, data FROM canvases ORDER BY id ASC');

  let inserted = 0;
  for (const row of rows) {
    const [existingRows] = await contentDb.query(
      'SELECT id FROM canvas_revisions WHERE canvas_id = ? ORDER BY id DESC LIMIT 1',
      [row.id]
    );
    if (existingRows.length > 0) continue;
    const snapshotString = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
    const revisionHash = crypto.createHash('sha1').update(snapshotString).digest('hex');
    await contentDb.query(
      `INSERT INTO canvas_revisions
        (canvas_id, owner_id, revision_hash, revision_reason, snapshot, created_by)
       VALUES (?, ?, ?, 'baseline', ?, ?)`,
      [row.id, row.owner_id, revisionHash, snapshotString, row.owner_id]
    );
    inserted += 1;
  }

  console.log(`Inserted ${inserted} baseline revision(s).`);
  await closePools();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
