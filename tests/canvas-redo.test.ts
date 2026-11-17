/**
 * 重做 Ctrl+Shift+Z / Ctrl+Y（2026-11-17）。锁住五个风险点：
 *   1. 重做「删除」：要再次登记用户删除、真的从服务端删掉；
 *   2. 新建 → 撤销（服务端已删）→ 重做：节点回来，保存带 restoreDeleted，服务端才放行；
 *   3. 撤销之后远端推来的节点（生成写回 / Cindy 插件）重做时原样保留，绝不删；
 *   4. 撤销之后在别处删掉的节点，重做不让它复活；
 *   5. 做了新操作就不能再重做；撤销 → 重做 → 撤销往返一致。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";

type UpsertArgs = [string, { nodeKey: string }, number, string, { restoreDeleted?: boolean }?];
type DeleteArgs = [string, string, number, string, unknown];
const upsert = vi.fn(async (..._args: UpsertArgs) => ({ ok: true, nodeVersion: 3 } as Record<string, unknown>));
const deleteNode = vi.fn(async (..._args: DeleteArgs) => ({ ok: true, deleted: true, nodeVersion: 3 }));

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: (...args: unknown[]) => upsert(...(args as UpsertArgs)),
    deleteNode: (...args: unknown[]) => deleteNode(...(args as DeleteArgs)),
    delete: vi.fn(),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  assetsApi: {},
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore, markNodesDeletedByUser } = await import("@/store/canvasStore");

const UUID = "777";

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
    projectMeta: { uuid: UUID, name: "重做", ownerId: 1, isOwner: true, canManage: true, canWrite: true, contentVersion: "cv-1" },
    projectDraft: { projectUuid: UUID, viewportX: 0, viewportY: 0, viewportZoom: 1, canvasTextScale: 1, lastPluginEditAtMs: 0 },
    nodeList: nodeKeys.map(serverNode),
  } as unknown as Project;
}

const store = () => useCanvasStore.getState();
const keysOf = () => store().nodes.map((node) => String(node.data.nodeKey || node.id)).sort();
const deletedKeys = () => deleteNode.mock.calls.map((call) => call[1]);

/** 同一轮事件里的多次 pushHistory 会合并成一步（见 canvasStore），真实操作之间至少隔一轮 */
const nextTick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** 模拟用户删除：先记一步历史，登记删除意图，再从画布摘掉 */
async function userDelete(nodeKey: string) {
  await nextTick();
  store().pushHistory();
  const remaining = store().nodes.filter((node) => node.data.nodeKey !== nodeKey);
  markNodesDeletedByUser(UUID, [nodeKey], remaining.length);
  store().setNodes(remaining);
}

/** 模拟用户新建：复制一个现有节点改 key */
async function userCreate(nodeKey: string) {
  await nextTick();
  store().pushHistory();
  const base = store().nodes[0];
  const created = { ...base, id: nodeKey, data: { ...base.data, nodeKey, name: nodeKey } };
  store().setNodes([...store().nodes, created]);
}

beforeEach(() => {
  upsert.mockClear();
  upsert.mockImplementation(async () => ({ ok: true, nodeVersion: 3 }));
  deleteNode.mockClear();
  store().clearProject();
});

describe("重做", () => {
  it("删除 → 撤销 → 重做：节点再次被删掉，服务端也删", async () => {
    store().loadProject(project(["a", "b"]));
    await userDelete("b");
    await store().persistNodesAndWait();
    expect(deletedKeys()).toEqual(["b"]);

    store().undo();
    await store().persistNodesAndWait();
    expect(keysOf()).toEqual(["a", "b"]);

    deleteNode.mockClear();
    store().redo();
    await store().persistNodesAndWait();
    expect(keysOf()).toEqual(["a"]);
    expect(deletedKeys()).toEqual(["b"]);
  });

  it("新建 → 撤销（服务端已删）→ 重做：节点回来，保存带 restoreDeleted", async () => {
    store().loadProject(project(["a"]));
    await userCreate("n1");
    await store().persistNodesAndWait();

    store().undo();
    await store().persistNodesAndWait();
    expect(keysOf()).toEqual(["a"]);
    expect(deletedKeys()).toEqual(["n1"]);

    upsert.mockClear();
    store().redo();
    await store().persistNodesAndWait();
    expect(keysOf()).toEqual(["a", "n1"]);
    const call = upsert.mock.calls.find((item) => item[1].nodeKey === "n1");
    expect(call?.[4]?.restoreDeleted).toBe(true);
  });

  it("撤销之后远端推来的节点（生成写回 / 插件）重做时保留，绝不删", async () => {
    store().loadProject(project(["a", "b"]));
    await userDelete("b");
    await store().persistNodesAndWait();
    store().undo();
    await store().persistNodesAndWait();

    // Cindy 插件在撤销之后加了一个节点 c
    store().applyRemoteNodeEvent({ id: 20, nodeKey: "c", nodeVersion: 1, eventType: "upsert", node: serverNode("c") } as never);
    expect(keysOf()).toEqual(["a", "b", "c"]);

    deleteNode.mockClear();
    store().redo();
    await store().persistNodesAndWait();
    expect(keysOf()).toEqual(["a", "c"]);
    expect(deletedKeys()).toEqual(["b"]);
  });

  it("撤销之后在别处删掉的节点，重做不让它复活", async () => {
    store().loadProject(project(["a", "b"]));
    await userCreate("n1");
    await store().persistNodesAndWait();
    store().undo();
    await store().persistNodesAndWait();

    // 别的页面删了 b
    store().applyRemoteNodeEvent({ id: 30, nodeKey: "b", nodeVersion: 2, eventType: "delete" });
    expect(keysOf()).toEqual(["a"]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store().redo();
    await store().persistNodesAndWait();
    warn.mockRestore();
    expect(keysOf()).toEqual(["a", "n1"]);
    expect(upsert.mock.calls.some((item) => item[1].nodeKey === "b")).toBe(false);
  });

  it("做了新操作就不能再重做", async () => {
    store().loadProject(project(["a", "b"]));
    await userDelete("b");
    store().undo();
    expect(store().redoStack.length).toBe(1);
    await userCreate("n2");
    expect(store().redoStack.length).toBe(0);
    const before = keysOf();
    store().redo();
    expect(keysOf()).toEqual(before);
  });

  it("撤销 → 重做 → 撤销 往返一致，连续多步也对", async () => {
    store().loadProject(project(["a"]));
    await userCreate("n1");
    await userCreate("n2");
    expect(keysOf()).toEqual(["a", "n1", "n2"]);
    store().undo();
    store().undo();
    expect(keysOf()).toEqual(["a"]);
    store().redo();
    expect(keysOf()).toEqual(["a", "n1"]);
    store().redo();
    expect(keysOf()).toEqual(["a", "n1", "n2"]);
    store().redo(); // 已经到头，不动
    expect(keysOf()).toEqual(["a", "n1", "n2"]);
    store().undo();
    expect(keysOf()).toEqual(["a", "n1"]);
  });
});
