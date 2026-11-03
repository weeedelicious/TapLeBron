process.chdir('/data/wyx_root/tapflow-workbench')
const db = require('/data/wyx_root/tapflow-workbench/server/db')
const { parseJsonDocument, saveCanvasData } = require('/data/wyx_root/tapflow-workbench/server/services/CanvasService')
const { queueCanvasMutation } = require('/data/wyx_root/tapflow-workbench/server/services/CanvasMutationQueue')

function asJson(value) {
  if (!value) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (error) { return null }
  }
  return value
}

;(async () => {
  const usage = db.getUsagePool()
  const [jobs] = await usage.query(
    "SELECT project_uuid, node_key, provider_job_ids, result_urls, request_params, created_at FROM generation_tasks WHERE task_type='video' AND status='succeeded' AND resolution='480P' AND created_at > DATE_SUB(NOW(), INTERVAL 12 HOUR) ORDER BY created_at ASC"
  )
  const drafts = []
  for (const row of jobs) {
    const req = asJson(row.request_params) || {}
    const settings = (req.requested && req.requested.settings) || {}
    if (settings.draft !== true) continue
    const ids = asJson(row.provider_job_ids) || []
    const urls = asJson(row.result_urls) || []
    const id = Array.isArray(ids) ? ids.filter(Boolean)[0] : ''
    if (!id || !row.project_uuid || !row.node_key || !Array.isArray(urls) || !urls.length) continue
    drafts.push({ project: String(row.project_uuid), nodeKey: String(row.node_key), id: String(id), urls: urls.map(String) })
  }
  console.log('drafts', drafts.length)
  const groups = new Map()
  for (const draft of drafts) {
    const key = draft.project + '\n' + draft.nodeKey
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(draft)
  }
  let updated = 0
  let tagged = 0
  for (const [key, items] of groups) {
    const project = items[0].project
    const nodeKey = items[0].nodeKey
    const result = await queueCanvasMutation(project, async () => {
      const [rows] = await db.getPool().query('SELECT id, owner_id, data FROM canvases WHERE id = ? LIMIT 1', [project])
      const row = rows[0]
      if (!row) return { status: 'missing-canvas' }
      const data = parseJsonDocument(row.data, {})
      const nodes = Array.isArray(data.nodeList) ? data.nodeList : []
      const index = nodes.findIndex((node) => String(node.nodeKey || '') === nodeKey)
      if (index < 0) return { status: 'missing-node' }
      const current = nodes[index]
      const nodeData = typeof current.data === 'string' ? parseJsonDocument(current.data, {}) : { ...(current.data || {}) }
      const meta = { ...(nodeData._assetGenerationMeta || {}) }
      let changed = 0
      for (const item of items) {
        for (const url of item.urls) {
          const prev = meta[url] || {}
          if (prev.draftTaskId === item.id) continue
          meta[url] = { ...prev, draftTaskId: item.id, resolution: prev.resolution || '480P' }
          changed += 1
        }
      }
      if (!changed) return { status: 'already', changed: 0 }
      nodeData._assetGenerationMeta = meta
      nodes[index] = { ...current, data: JSON.stringify(nodeData) }
      data.nodeList = nodes
      await saveCanvasData(project, data, {
        reason: 'draft_task_id_backfill',
        ownerId: row.owner_id,
        createdBy: row.owner_id,
        cooldownMs: 0,
      })
      return { status: 'updated', changed }
    })
    console.log(result.status, result.changed || 0)
    if (result.status === 'updated') {
      updated += 1
      tagged += result.changed || 0
    }
  }
  console.log('nodes', updated, 'urls', tagged)
  const [running] = await usage.query("SELECT COUNT(*) AS n FROM generation_tasks WHERE status IN ('submitted','running')")
  console.log('running', running[0].n)
  process.exit(0)
})().catch((error) => {
  console.error(String(error && error.stack || error).slice(0, 900))
  process.exit(1)
})
