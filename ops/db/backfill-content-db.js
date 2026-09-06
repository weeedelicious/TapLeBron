#!/usr/bin/env node
const {
  closePools,
  getAdminPool,
  getContentPool,
  isSeparateContentDatabase,
  upsertCanvasContent
} = require('../../server/db');

async function backfillCanvasContent(adminDb) {
  const [rows] = await adminDb.query('SELECT id, owner_id, data FROM canvases ORDER BY id ASC');
  let count = 0;
  for (const row of rows) {
    const payload = typeof row.data === 'string' ? row.data : JSON.stringify(row.data || {});
    await upsertCanvasContent(row.id, row.owner_id, payload, row.owner_id);
    count += 1;
  }
  return count;
}

async function backfillCanvasAssets(adminDb, contentDb) {
  const [rows] = await adminDb.query(
    `SELECT
       canvas_id,
       owner_id,
       kind,
       original_name,
       stored_name,
       relative_path,
       mime_type,
       byte_size,
       sha1,
       source_type,
       created_at
     FROM canvas_assets
     ORDER BY id ASC`
  );

  let count = 0;
  for (const row of rows) {
    await contentDb.query(
      `INSERT INTO canvas_assets
        (canvas_id, owner_id, kind, original_name, stored_name, relative_path, mime_type, byte_size, sha1, source_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        owner_id = VALUES(owner_id),
        kind = VALUES(kind),
        original_name = VALUES(original_name),
        relative_path = VALUES(relative_path),
        mime_type = VALUES(mime_type),
        byte_size = VALUES(byte_size),
        sha1 = VALUES(sha1),
        source_type = VALUES(source_type),
        updated_at = CURRENT_TIMESTAMP`,
      [
        row.canvas_id,
        row.owner_id,
        row.kind,
        row.original_name,
        row.stored_name,
        row.relative_path,
        row.mime_type,
        row.byte_size,
        row.sha1,
        row.source_type,
        row.created_at
      ]
    );
    count += 1;
  }
  return count;
}

async function backfillCanvasRevisions(adminDb, contentDb) {
  const [rows] = await adminDb.query(
    `SELECT
       canvas_id,
       owner_id,
       revision_hash,
       revision_reason,
       snapshot,
       created_by,
       created_at
     FROM canvas_revisions
     ORDER BY id ASC`
  );

  let count = 0;
  for (const row of rows) {
    await contentDb.query(
      `INSERT IGNORE INTO canvas_revisions
        (canvas_id, owner_id, revision_hash, revision_reason, snapshot, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.canvas_id,
        row.owner_id,
        row.revision_hash,
        row.revision_reason,
        typeof row.snapshot === 'string' ? row.snapshot : JSON.stringify(row.snapshot || {}),
        row.created_by,
        row.created_at
      ]
    );
    count += 1;
  }
  return count;
}

async function main() {
  const adminDb = getAdminPool();
  const contentDb = getContentPool();

  const contentCount = await backfillCanvasContent(adminDb);
  let assetCount = 0;
  let revisionCount = 0;

  if (isSeparateContentDatabase()) {
    assetCount = await backfillCanvasAssets(adminDb, contentDb);
    revisionCount = await backfillCanvasRevisions(adminDb, contentDb);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        contentRows: contentCount,
        assetRows: assetCount,
        revisionRows: revisionCount,
        separateContentDatabase: isSeparateContentDatabase()
      },
      null,
      2
    )
  );

  await closePools();
}

main().catch(async (error) => {
  console.error(error);
  await closePools().catch(() => null);
  process.exit(1);
});
