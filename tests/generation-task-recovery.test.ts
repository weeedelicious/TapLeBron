/**
 * "生成任务重启后能不能接回来"的判据。
 *
 * 2026-08-14 的实际事故：canvas 237 的 task 2363 是 MiniMax H3 视频，已经提交给
 * provider、provider_job_ids 存着 1 个，重启却被判成"服务意外中断，任务无法安全恢复"——
 * 因为 JobService.recoverInterruptedTasks() 的过滤器只认 seedance，而
 * canvasRoutes.resumePersistedGenerationTasks() 明明已经接好了 MiniMax 的轮询。
 * 两处各写一份名单，漂移了。
 *
 * 这个判据现在只有一份，两边共用；下面把两边都必须同意的边界钉住。
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isResumableGenerationTask,
  RESUMABLE_VIDEO_PROVIDERS,
} = require("../server/services/GenerationTaskRecovery.js");

const task = (over: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  taskType: "video",
  provider: "seedance",
  providerJobIds: ["cgt-1"],
  projectUuid: "226",
  ...over,
});

describe("可恢复的任务", () => {
  it("seedance 视频，有 provider job id → 可恢复", () => {
    expect(isResumableGenerationTask(task())).toBe(true);
  });

  it("minimax 视频，有 provider job id → 可恢复（task 2363 的形态）", () => {
    expect(isResumableGenerationTask(task({ provider: "minimax", providerJobIds: ["mm-1"] }))).toBe(true);
  });

  it("provider 大小写不敏感", () => {
    expect(isResumableGenerationTask(task({ provider: "MiniMax" }))).toBe(true);
    expect(isResumableGenerationTask(task({ provider: "SEEDANCE" }))).toBe(true);
  });

  it("多个 provider job 也可恢复", () => {
    expect(isResumableGenerationTask(task({ provider: "minimax", providerJobIds: ["mm-1", "mm-2"] }))).toBe(true);
  });
});

describe("不可恢复的任务", () => {
  it("图片任务：同步拿结果，进程一没就真没了", () => {
    expect(isResumableGenerationTask(task({ taskType: "image" }))).toBe(false);
  });

  it("文本任务同理", () => {
    expect(isResumableGenerationTask(task({ taskType: "text" }))).toBe(false);
  });

  it("还没提交给 provider（没有 job id）→ 无从查询", () => {
    expect(isResumableGenerationTask(task({ providerJobIds: [] }))).toBe(false);
    expect(isResumableGenerationTask(task({ providerJobIds: undefined }))).toBe(false);
  });

  it("job id 全是空串也算没有", () => {
    expect(isResumableGenerationTask(task({ providerJobIds: ["", null] }))).toBe(false);
  });

  it("没有画布归属 → 结果没法写回节点", () => {
    expect(isResumableGenerationTask(task({ projectUuid: null }))).toBe(false);
  });

  it("轮询函数还没接的 provider → 不认（认了会拿错的接口去问）", () => {
    expect(isResumableGenerationTask(task({ provider: "kling" }))).toBe(false);
    expect(isResumableGenerationTask(task({ provider: "" }))).toBe(false);
  });

  it("空值不炸", () => {
    expect(isResumableGenerationTask(null)).toBe(false);
    expect(isResumableGenerationTask(undefined)).toBe(false);
  });
});

describe("加新 provider 时的提醒", () => {
  // 这条会在有人往名单里加 provider 时变红。加之前必须先确认两件事：
  //   1. canvasRoutes.js 的 resumePoll 分派认得它；
  //   2. pollVideoManyAndStore 的 pollResult 传的是它自己的轮询函数。
  // 否则重启后会拿着它的 task id 去问别家接口。
  it("名单就是 seedance + minimax", () => {
    expect([...RESUMABLE_VIDEO_PROVIDERS].sort()).toEqual(["minimax", "seedance"]);
  });
});
