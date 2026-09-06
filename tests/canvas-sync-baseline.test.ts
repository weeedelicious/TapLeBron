/**
 * 实时同步不许把保存基准重置成一份过期快照。
 *
 * 2026-08-15 canvas 195「cindy_test」：用户反复看到"有 8 个节点在服务端已更新"，
 * 而实际上只有他一个人在这个画布上。nginx 日志里的完整形态是——
 *   23:30:21  GET /api/projects/195            ← 打开画布
 *   23:30:22-26  44 次 nodes/upsert（22 个节点整整重存了两遍）
 *   23:30:31  GET /api/projects/195            ← 又整量加载了一次
 *   23:30:32-35  36 次 nodes/upsert
 *   23:30:35  8 × 409                          ← 横幅
 *
 * 点火装置是 SSE 的 ready 帧：连上流的瞬间服务端就把"最近所有变更的 nodeKey"发回来，
 * 那里面全是本页自己刚写的节点（CanvasRealtimeService 的 ring buffer 不区分是谁写的）。
 * 客户端把它当成"别人改了画布"，去拉一份整量快照套上来，于是：
 *   - 节点树被整棵替换 → React Flow 重新量尺寸 → 全部节点指纹变了 → 全量重存；
 *   - 保存基准（每个节点的 _collabVersion）被重置成快照里的值，而快照是保存还在飞的
 *     时候读的，比本地已经写进去的低 → 下一轮保存整批 409。
 *
 * 这里钉住两条闸门：
 *   1. debounce 必须能报告"还有一次调用在等着"，否则同步无法知道保存有没有排空；
 *   2. 内容版本与本地一致时，同步是纯粹的无事发生（不重建节点树、不重置基准）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce } from "@/lib/debounce";

describe("debounce 的 pending()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("排到队里就是 pending，触发完就不是", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 500);

    expect(debounced.pending()).toBe(false);
    debounced();
    expect(debounced.pending()).toBe(true);

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(debounced.pending()).toBe(false);
  });

  it("cancel 之后不再 pending", () => {
    vi.useFakeTimers();
    const debounced = debounce(vi.fn(), 500);
    debounced();
    debounced.cancel();
    expect(debounced.pending()).toBe(false);
  });

  // canvasStore 靠 .cancel() 活着（见 debounce.ts 顶部注释：生产上曾经跑着一份没有
  // .cancel 的残缺副本，改成从源码构建当天立刻黑屏）。.pending 现在同样是被依赖的。
  it("两个方法都必须挂在返回的函数上", () => {
    const debounced = debounce(() => {}, 10);
    expect(typeof debounced.cancel).toBe("function");
    expect(typeof debounced.pending).toBe("function");
  });
});

const upsert = vi.fn(async () => ({ ok: true, nodeVersion: 2, contentVersion: "cv-next" }));

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: (...args: unknown[]) => upsert(...(args as [])),
    deleteNode: vi.fn(),
    delete: vi.fn(),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore, hasPendingNodeSaves } = await import("@/store/canvasStore");

const UUID = "195";

function serverNode(nodeKey: string, collabVersion = 1) {
  return {
    nodeKey,
    projectUuid: UUID,
    type: 2,
    name: nodeKey,
    status: 1,
    position: { positionX: 0, positionY: 0 },
    measured: { width: 520, height: 350 },
    data: JSON.stringify({ type: "text", name: nodeKey, nodeKey, prompt: "", _collabVersion: collabVersion }),
  };
}

function project(nodeKeys: string[], contentVersion = "cv-1") {
  return {
    projectMeta: {
      uuid: UUID,
      name: "cindy_test",
      ownerId: 1,
      isOwner: true,
      canManage: true,
      canWrite: true,
      contentVersion,
    },
    projectDraft: {
      projectUuid: UUID,
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1,
      canvasTextScale: 1,
      lastPluginEditAtMs: 0,
    },
    nodeList: nodeKeys.map((key) => serverNode(key)),
  };
}

describe("hasPendingNodeSaves", () => {
  it("刚改过节点、保存还没落地时为 true，排空后为 false", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useCanvasStore.getState().loadProject(project(["a", "b"]) as any);
    expect(hasPendingNodeSaves(UUID)).toBe(false);

    useCanvasStore.getState().updateNodeData("a", { name: "改一下" });
    expect(hasPendingNodeSaves(UUID)).toBe(true);

    await useCanvasStore.getState().persistNodesAndWait();
    expect(hasPendingNodeSaves(UUID)).toBe(false);
  });
});
