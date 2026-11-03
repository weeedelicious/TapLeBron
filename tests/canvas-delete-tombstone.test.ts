/**
 * 删掉的节点不许被旧快照写回来（2026-11-03 canvas 497）。
 *
 * 现场：删除请求在服务端排了 30 多秒才执行，期间刷新出来的页面手里还有这个节点；
 * 删除推过来之后，它又拿删除前排好的保存快照把节点当新节点写了回去，刷新后"删不掉"。
 *
 * 服务端对"画布里没有、最后一条事件是删除"的节点返回 skippedDeleted，这里锁两条：
 *   1. 收到 skippedDeleted 时把本地副本摘掉，不再往回写；
 *   2. 本页自己删掉又撤销回来的节点，保存时带 restoreDeleted，服务端才放行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";

type UpsertArgs = [string, { nodeKey: string }, number, string, { restoreDeleted?: boolean }?];
const upsert = vi.fn(async (..._args: UpsertArgs) => ({ ok: true, nodeVersion: 2, contentVersion: "cv-next" } as Record<string, unknown>));
const deleteNode = vi.fn(async () => ({ ok: true, deleted: true, nodeVersion: 2, contentVersion: "cv-next" }));

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: (...args: unknown[]) => upsert(...(args as UpsertArgs)),
    deleteNode: (...args: unknown[]) => deleteNode(...(args as [])),
    delete: vi.fn(),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  assetsApi: {},
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore, markNodesDeletedByUser } = await import("@/store/canvasStore");

const UUID = "497";

function serverNode(nodeKey: string) {
  return {
    nodeKey,
    projectUuid: UUID,
    type: 2,
    name: nodeKey,
    status: 1,
    position: { positionX: 0, positionY: 0 },
    measured: { width: 520, height: 350 },
    data: JSON.stringify({ type: "text", name: nodeKey, nodeKey, prompt: "", _collabVersion: 1 }),
  };
}

function project(nodeKeys: string[]): Project {
  return {
    projectMeta: { uuid: UUID, name: "删除墓碑", ownerId: 1, isOwner: true, canManage: true, canWrite: true, contentVersion: "cv-1" },
    projectDraft: { projectUuid: UUID, viewportX: 0, viewportY: 0, viewportZoom: 1, canvasTextScale: 1, lastPluginEditAtMs: 0 },
    nodeList: nodeKeys.map(serverNode),
  } as unknown as Project;
}

const keysOf = () => useCanvasStore.getState().nodes.map((node) => String(node.data.nodeKey || node.id)).sort();
const upsertedKeys = () => upsert.mock.calls.map((call) => call[1].nodeKey)

beforeEach(() => {
  upsert.mockClear();
  deleteNode.mockClear();
  useCanvasStore.getState().clearProject();
});

describe("已删除的节点不许被旧快照写回", () => {
  it("别处删掉之后，删除前的旧快照再保存：服务端忽略，本地也摘掉", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    // 删除前排好的那份快照：b 被挪过位置
    const stale = useCanvasStore.getState().nodes.map((node) =>
      node.data.nodeKey === "b" ? { ...node, position: { x: 56, y: 43 } } : node,
    );
    // 别的页面删了 b，推送到达
    useCanvasStore.getState().applyRemoteNodeEvent({ id: 10, nodeKey: "b", nodeVersion: 2, eventType: "delete" });
    expect(keysOf()).toEqual(["a"]);

    upsert.mockImplementation(async (_uuid, node) =>
      node.nodeKey === "b" ? { ok: true, skippedDeleted: true, nodeKey: "b" } : { ok: true, nodeVersion: 2 },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useCanvasStore.getState().setNodes(stale);
    await useCanvasStore.getState().persistNodesAndWait();
    warn.mockRestore();

    expect(upsertedKeys()).toContain("b");
    const call = upsert.mock.calls.find((item) => item[1].nodeKey === "b");
    expect(call?.[4]?.restoreDeleted).toBe(false);
    expect(keysOf()).toEqual(["a"]);

    // 之后的保存不会再为 b 发任何请求
    upsert.mockClear();
    await useCanvasStore.getState().persistNodesAndWait();
    expect(upsertedKeys()).not.toContain("b");
  });

  it("本页删掉又撤销回来的节点，保存时声明 restoreDeleted", async () => {
    upsert.mockImplementation(async () => ({ ok: true, nodeVersion: 3 }));
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    useCanvasStore.getState().pushHistory();
    const remaining = useCanvasStore.getState().nodes.filter((node) => node.data.nodeKey !== "b");
    markNodesDeletedByUser(UUID, ["b"], remaining.length);
    useCanvasStore.getState().setNodes(remaining);
    await useCanvasStore.getState().persistNodesAndWait();
    expect(deleteNode).toHaveBeenCalledTimes(1);

    useCanvasStore.getState().undo();
    await useCanvasStore.getState().persistNodesAndWait();

    const call = upsert.mock.calls.find((item) => item[1].nodeKey === "b");
    expect(call?.[4]?.restoreDeleted).toBe(true);
    expect(keysOf()).toEqual(["a", "b"]);
  });
});
