/**
 * "这个生成任务在服务重启后还能不能接回来"的唯一判据。
 *
 * 为什么单独成文件：这个判断原来在两个地方各写了一份，而且已经漂移了——
 *
 *   server/services/JobService.js  recoverInterruptedTasks()   只认 seedance
 *   server/canvasRoutes.js         resumePersistedGenerationTasks()  认 seedance + minimax
 *
 * 前者先跑，把 minimax 任务判成"无法安全恢复"直接写 failed，后者根本收不到它。
 * 结果是 MiniMax 视频任务已经提交给 provider、job id 也存着，重启却一律判失败——
 * 用户白等、额度白扣（2026-08-14 canvas 237 的 task 2363 就是这个形态）。
 *
 * 两处必须用同一个判据，任何一处多一个条件都会造成任务被"悬空"：
 * recover 认为可恢复所以留在 running，resume 却跳过它，于是没有任何人轮询它，
 * 它会一直挂着直到轮询超时都不会发生（因为压根没起轮询）。
 */

// 能在重启后凭 provider job id 继续轮询的视频 provider。
// 加新 provider 时改这里一处，两边同时生效——但要先确认它的轮询函数已经接好
// （canvasRoutes.js 里的 resumePoll 分派 + pollManyAndStore 的 pollResult）。
const RESUMABLE_VIDEO_PROVIDERS = new Set(['seedance', 'minimax']);

/**
 * @param {object} task recoveryTaskFromRow() 的产物
 * @returns {boolean} true = 重启后可以凭 provider job id 继续轮询
 */
function isResumableGenerationTask(task) {
  if (!task) return false;
  // 只有视频任务在 provider 侧是长任务、有可查询的 job id。
  // 图片/文本任务是同步拿结果的，进程一没就真的没了，只能判失败让用户重来。
  if (task.taskType !== 'video') return false;
  if (!RESUMABLE_VIDEO_PROVIDERS.has(String(task.provider || '').toLowerCase())) return false;
  const jobIds = Array.isArray(task.providerJobIds) ? task.providerJobIds.filter(Boolean) : [];
  if (jobIds.length === 0) return false;
  // 没有画布归属就没法把结果写回节点，轮询也没有意义。
  if (!task.projectUuid) return false;
  return true;
}

module.exports = { RESUMABLE_VIDEO_PROVIDERS, isResumableGenerationTask };
