process.chdir('/data/wyx_root/tapflow-workbench')
const db = require('/data/wyx_root/tapflow-workbench/server/db')
;(async () => {
  const [rows] = await db.getUsagePool().query("SELECT status, COUNT(*) AS n FROM generation_tasks WHERE status IN ('submitted','running') GROUP BY status")
  console.log(JSON.stringify(rows))
  process.exit(0)
})().catch((e) => { console.error(e.message); process.exit(1) })
