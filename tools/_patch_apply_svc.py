from pathlib import Path
import sys

def patch(text):
    old = """      generationMeta[url] = {
        ...(persisted?.metadata || {}),
        model: persisted?.model || task.meta?.model,
        resolution: persisted?.resolution || task.meta?.resolution,
        createdAtMs: completedAtMs,
        taskId: jobId,
        generationVersion: taskVersion,
        outputIndex,
      };"""
    new = """      generationMeta[url] = {
        ...(generationMeta[url] || {}),
        ...(persisted?.metadata || {}),
        model: persisted?.model || task.meta?.model,
        resolution: persisted?.resolution || task.meta?.resolution,
        createdAtMs: completedAtMs,
        taskId: jobId,
        generationVersion: taskVersion,
        outputIndex,
        ...(draftProviderId ? { draftTaskId: draftProviderId } : {}),
      };"""
    if text.count(old) != 1:
        raise SystemExit('meta block %s' % text.count(old))
    text = text.replace(old, new, 1)
    old_import = """const {
  getContentPool,
  getPool,
} = require('../db');"""
    new_import = """const {
  getContentPool,
  getPool,
  getUsagePool,
} = require('../db');"""
    if old_import not in text:
        raise SystemExit('import missing')
    text = text.replace(old_import, new_import, 1)
    helper = """
async function draftProviderIdForJob(jobId, task) {
  const fromTask = Array.isArray(task && task.providerJobIds) ? task.providerJobIds.filter(Boolean)[0] : '';
  try {
    const [rows] = await getUsagePool().query(
      'SELECT provider_job_ids, request_params FROM generation_tasks WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    const row = rows && rows[0];
    if (!row) return '';
    let req = row.request_params;
    if (typeof req === 'string') req = JSON.parse(req);
    const settings = (req && req.requested && req.requested.settings) || {};
    if (settings.draft !== true) return '';
    let jobs = row.provider_job_ids;
    if (typeof jobs === 'string') jobs = JSON.parse(jobs);
    const id = (Array.isArray(jobs) && jobs.filter(Boolean)[0]) || fromTask;
    return id ? String(id) : '';
  } catch (error) {
    return '';
  }
}

"""
    needle = "async function applyGenerationResult"
    text = text.replace(needle, helper + needle, 1)
    old_loop = """    const completedAtMs = Date.parse(String(task.meta?.updatedAt || '')) || Date.now();
    const urls = task.urls.map(String).filter(Boolean);"""
    new_loop = """    const completedAtMs = Date.parse(String(task.meta?.updatedAt || '')) || Date.now();
    const urls = task.urls.map(String).filter(Boolean);
    const draftProviderId = await draftProviderIdForJob(jobId, task);"""
    if text.count(old_loop) != 1:
        raise SystemExit('loop %s' % text.count(old_loop))
    return text.replace(old_loop, new_loop, 1)

path = Path(sys.argv[1])
path.write_text(patch(path.read_text(encoding='utf-8')), encoding='utf-8')
print('patched')
