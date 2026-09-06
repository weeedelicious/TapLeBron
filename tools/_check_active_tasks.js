// 一次性：查各库里 generation_tasks 的未结束任务，判断能不能安全重启。跑完删掉。
const config = require('../server/config');
const mysql = require('mysql2/promise');

const DONE = ['succeeded', 'success', 'failed', 'cancelled', 'canceled', 'completed', 'error', 'done'];

(async () => {
  for (const [name, cfg] of Object.entries(config.db)) {
    let pool;
    try {
      pool = await mysql.createPool(cfg);
      const [tables] = await pool.query("show tables like 'generation_tasks'");
      if (!tables.length) continue;
      const [byStatus] = await pool.query('select status, count(*) n from generation_tasks group by status');
      console.log(`db=${name} ${cfg.database}:`, JSON.stringify(byStatus));
      const placeholders = DONE.map(() => '?').join(',');
      const [open] = await pool.query(
        `select id, task_type, status, canvas_id, created_at, updated_at
           from generation_tasks
          where status not in (${placeholders})
          order by id desc limit 12`,
        DONE,
      );
      if (!open.length) console.log('  未结束任务：无');
      for (const row of open) {
        const ageMin = row.updated_at ? Math.round((Date.now() - new Date(row.updated_at).getTime()) / 60000) : null;
        console.log(`   #${row.id} ${row.task_type} ${row.status} canvas=${row.canvas_id} 上次更新 ${ageMin} 分钟前`);
      }
    } catch (error) {
      // 库不存在或没这张表都正常，跳过
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  }
  process.exit(0);
})();
