process.chdir('/data/wyx_root/tapflow-workbench')
const db = require('/data/wyx_root/tapflow-workbench/server/db')
;(async () => {
  const pool = db.getUsagePool()
  const [rows] = await pool.query(
    "SELECT resolution, status, created_at, request_params FROM generation_tasks WHERE task_type='video' AND model='Seedance_2_5' AND created_at >= '2026-10-26 08:20:00' ORDER BY created_at ASC"
  )
  for (const row of rows) {
    let req = {}
    try { req = typeof row.request_params === 'string' ? JSON.parse(row.request_params) : (row.request_params || {}) } catch (e) { req = {} }
    const settings = (req.requested && req.requested.settings) || {}
    const text = JSON.stringify(req)
    console.log(JSON.stringify({
      at: row.created_at,
      resolution: row.resolution,
      status: row.status,
      draft: settings.draft === true,
      finalize: text.includes('finalizeDraftTaskId'),
      keys: Object.keys(req).slice(0, 12),
    }))
  }
  process.exit(0)
})().catch((error) => {
  console.error(String(error && error.message || error).slice(0, 300))
  process.exit(1)
})
