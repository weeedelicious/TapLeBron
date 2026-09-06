/**
 * 节点不许丢的回归测试。
 *
 * 对应 2026-08-12 canvas 220（n=3 → 0）和 08-13 canvas 238（n=3 → 2 → 1 → 0）两次事故。
 * 根因：syncProject 收到远端变更后，把自己不认识的远端节点丢掉，再把这份缺东西的
 * 列表当成真相保存上去。
 *
 * 这里锁死三条：
 *   1. 同步永远不会让远端已有的节点从本地列表里消失；
 *   2. 节点从本地消失但没人点删除时，自动保存不许向服务端发删除；
 *   3. 用户真的删除时，删除请求照发，并带上"这是人点的"意图。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";

const upsert = vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: "cv-next" }));
const deleteNode = vi.fn(async () => ({ ok: true, deleted: true, nodeVersion: 2, contentVersion: "cv-next" }));
const deleteLegacy = vi.fn(async () => ({ data: { contentVersion: "cv-next" } }));

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: (...args: unknown[]) => upsert(...(args as [])),
    deleteNode: (...args: unknown[]) => deleteNode(...(args as [])),
    delete: (...args: unknown[]) => deleteLegacy(...(args as [])),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore, markNodesDeletedByUser } = await import("@/store/canvasStore");

const UUID = "220";

function serverNode(nodeKey: string, collabVersion = 1) {
  return {
    nodeKey,
    projectUuid: UUID,
    type: 2,
    name: nodeKey,
    status: 1,
    position: { positionX: 0, positionY: 0 },
    measured: { width: 520, height: 350 },
    data: JSON.stringify({
      type: "text",
      name: nodeKey,
      nodeKey,
      prompt: "",
      _collabVersion: collabVersion,
    }),
  };
}

function project(nodeKeys: string[], contentVersion = "cv-1"): Project {
  return {
    projectMeta: {
      uuid: UUID,
      name: "回归测试画布",
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
  } as unknown as Project;
}

const keysOf = () =>
  useCanvasStore
    .getState()
    .nodes.map((node) => String(node.data.nodeKey || node.id))
    .sort();

beforeEach(() => {
  upsert.mockClear();
  deleteNode.mockClear();
  deleteLegacy.mockClear();
  useCanvasStore.getState().clearProject();
});

describe("同步不许丢远端节点（事故根因）", () => {
  it("远端多出来的节点即使不在 changedNodeKeys 里也要留下", () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    expect(keysOf()).toEqual(["a", "b"]);

    // 别的页面/插件加了 c，这次事件只声明 a 变了。
    // 修复前：c 被丢掉，接着自动保存把 [a,b] 当真相写回去，c 就没了。
    useCanvasStore.getState().syncProject(project(["a", "b", "c"], "cv-2"), ["a"]);

    expect(keysOf()).toEqual(["a", "b", "c"]);
  });

  it("changedNodeKeys 为空时直接采用远端全量", () => {
    useCanvasStore.getState().loadProject(project(["a"]));
    useCanvasStore.getState().syncProject(project(["a", "b", "c"], "cv-2"), []);
    expect(keysOf()).toEqual(["a", "b", "c"]);
  });

  it("本地新建还没保存的节点不会被同步冲掉", () => {
    useCanvasStore.getState().loadProject(project(["a"]));
    useCanvasStore.getState().addNode("text");
    const localOnly = keysOf().filter((key) => key !== "a");
    expect(localOnly).toHaveLength(1);

    useCanvasStore.getState().syncProject(project(["a", "b"], "cv-2"), ["b"]);
    expect(keysOf()).toContain(localOnly[0]);
    expect(keysOf()).toContain("b");
  });
});

describe("没有删除意图就不许删服务端节点", () => {
  it("节点从本地列表消失但没人点删除时，不发删除请求", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 模拟"内存状态莫名少了一个"——这正是事故里发生的事，不是用户删除。
    const remaining = useCanvasStore
      .getState()
      .nodes.filter((node) => String(node.data.nodeKey) !== "b");
    useCanvasStore.getState().setNodes(remaining);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("整个列表被清空也不发删除请求", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b", "c"]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    useCanvasStore.getState().setNodes([]);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).not.toHaveBeenCalled();
  });
});

describe("用户真的删除时照常生效", () => {
  it("deleteNodes 会带着 user_delete 意图发删除请求", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));

    useCanvasStore.getState().deleteNodes(["b"]);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(1);
    const args = deleteNode.mock.calls[0] as unknown[];
    expect(args[1]).toBe("b");
    expect(args[4]).toMatchObject({ bulkDeleteConfirmed: false, allowClearCanvas: false });
  });

  it("一次删 3 个以上会声明批量删除", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b", "c", "d"]));

    useCanvasStore.getState().deleteNodes(["b", "c", "d"]);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(3);
    for (const call of deleteNode.mock.calls as unknown[][]) {
      expect(call[4]).toMatchObject({ bulkDeleteConfirmed: true });
    }
  });

  it("删到一个不剩会声明清空画布", async () => {
    useCanvasStore.getState().loadProject(project(["a"]));

    useCanvasStore.getState().deleteNodes(["a"]);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(1);
    expect((deleteNode.mock.calls[0] as unknown[])[4]).toMatchObject({ allowClearCanvas: true });
  });

  /**
   * 2026-08-15 canvas 195：用户删一个节点、刷新，节点又回来了。
   * nginx 日志里 delete-v2 一次都没被调用过——删除请求排在几十个 upsert 后面，要一两秒
   * 才轮到它，而用户点完删除就刷新页面去确认，队列连同删除意图一起没了。
   * 删除是明确的用户意图，必须排在几何变更前面。
   */
  it("画布上压着一堆待存改动时，删除请求排在最前面", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b", "c", "d"]));
    const order: string[] = [];
    upsert.mockClear();
    deleteNode.mockClear();
    upsert.mockImplementation(async (...args: unknown[]) => {
      order.push(`upsert:${(args[1] as { nodeKey: string }).nodeKey}`);
      return { ok: true, nodeVersion: 2, contentVersion: "cv-next" };
    });
    deleteNode.mockImplementation(async (...args: unknown[]) => {
      order.push(`delete:${String(args[1])}`);
      return { ok: true, deleted: true, nodeVersion: 2, contentVersion: "cv-next" };
    });

    useCanvasStore.getState().updateNodeData("a", { name: "改了 a" });
    useCanvasStore.getState().updateNodeData("c", { name: "改了 c" });
    useCanvasStore.getState().updateNodeData("d", { name: "改了 d" });
    useCanvasStore.getState().deleteNodes(["b"]);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(order[0]).toBe("delete:b");
    expect(order).toHaveLength(4); // 删除没有挤掉其它保存
  });

  /**
   * 2026-08-15 canvas 195：右键菜单删得掉，按 Delete / Backspace 删不掉。
   * React Flow 的 deleteKeyCode 是它自己处理的——直接把节点摘掉，只通过 onNodesChange 的
   * remove 变更通知我们，走不到 store 的 deleteNodes，删除意图没人登记，自动保存于是按规矩
   * 拒绝删服务端节点（控制台留下"在本地消失但没有删除意图"），刷新后节点原样回来。
   * Canvas.tsx 现在会为 remove 变更补登记意图；这里锁死它依赖的那个契约。
   */
  it("补登记删除意图后，setNodes 摘掉的节点照样删服务端", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    deleteNode.mockClear();

    // 模拟 React Flow 用 Delete 键摘掉 b：先登记意图，再把新列表交给 store
    const remaining = useCanvasStore
      .getState()
      .nodes.filter((node) => String(node.data.nodeKey) !== "b");
    markNodesDeletedByUser("220", ["b"], remaining.length);
    useCanvasStore.getState().setNodes(remaining, { immediate: true });
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(1);
    expect((deleteNode.mock.calls[0] as unknown[])[1]).toBe("b");
  });

  it("markNodesDeletedByUser 必须是导出的（Canvas.tsx 要用）", () => {
    expect(typeof markNodesDeletedByUser).toBe("function");
  });

  /**
   * 2026-08-15 canvas 216：分组节点删不掉，屏幕上没了、刷新又回来。
   * 组工具栏上唯一能拿掉组框的按钮是"解组"，而 ungroupNodes 里的持久化早先被改成了一个
   * 空的 if (projectUuid) {}（08-13 版本里是 nodesApi.delete）——只改本地状态，从不落库。
   */
  it("解组要把组框从服务端删掉，不能只在屏幕上生效", async () => {
    const withGroup = project(["g", "a", "b"]);
    withGroup.nodeList[0].data = JSON.stringify({
      type: "group",
      name: "分组2个节点",
      nodeKey: "g",
      params: { childIds: ["a", "b"], color: "#252525" },
      _collabVersion: 1,
    });
    useCanvasStore.getState().loadProject(withGroup);
    deleteNode.mockClear();

    useCanvasStore.getState().ungroupNodes("g");
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(1);
    expect((deleteNode.mock.calls[0] as unknown[])[1]).toBe("g");
    // 子节点必须留下
    expect(keysOf()).toEqual(["a", "b"]);
  });

  it("节点版本被别处推进时，删除拿服务端版本重试一次而不是丢掉", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    deleteNode.mockClear();
    let attempts = 0;
    deleteNode.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("conflict") as Error & { response?: unknown };
        error.response = {
          status: 409,
          data: { errorCode: "CANVAS_NODE_VERSION_CONFLICT", currentVersion: 7 },
        };
        throw error;
      }
      return { ok: true, deleted: true, nodeVersion: 8, contentVersion: "cv-next" };
    });

    useCanvasStore.getState().deleteNodes(["b"]);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(2);
    // 第二次必须带服务端给的版本号，删除声明照原样带上（intent 由 api 层固定加）
    expect((deleteNode.mock.calls[1] as unknown[])[2]).toBe(7);
    expect((deleteNode.mock.calls[1] as unknown[])[4]).toEqual(
      (deleteNode.mock.calls[0] as unknown[])[4],
    );
  });
});

/**
 * 打开画布不该白跑一整轮全量重存。
 *
 * React Flow 挂载时会给每个节点补一次 dimensions 变更（量出来的宽高），这本来就会让
 * onNodesChange 触发一次 persist。指纹里要是含着这个派生尺寸，22 个节点会同时被判成
 * "变了"：2026-08-15 canvas 195 实测打开一次画布 = 80 多次 upsert，
 * canvas_revisions 的 100 条上限十几分钟烧光，用户点的删除还得排在这堆东西后面。
 */
/**
 * 撤销不许删掉别人的节点。
 *
 * 2026-08-16 逐个核对"改节点的入口有没有落库"时发现：undo 把"现在有、快照里没有"的节点
 * 一律登记成用户删除。而远端推过来的节点（别的客户端 / Cindy 插件，走 applyRemoteNodeEvent）
 * 从不进任何历史快照，天然满足这个条件——任何人按一下 Ctrl+Z 就会把别人刚加的节点从服务端
 * 删掉，而删除护栏挡不住（意图是明确登记过的）。这是 canvas 220 / 238 / 115 三次节点丢失
 * 的同一个形状，只是触发点换成了撤销。
 */
describe("撤销只删本页新建的节点", () => {
  it("撤销掉本页刚新建的节点：照常从服务端删掉", async () => {
    useCanvasStore.getState().loadProject(project(["a"]));
    deleteNode.mockClear();

    const created = useCanvasStore.getState().addNode("text");
    await useCanvasStore.getState().persistNodesAndWait();

    useCanvasStore.getState().undo();
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).toHaveBeenCalledTimes(1);
    expect((deleteNode.mock.calls[0] as unknown[])[1]).toBe(
      String(created.data.nodeKey),
    );
  });

  it("撤销不许删掉远端刚推过来的节点", async () => {
    useCanvasStore.getState().loadProject(project(["a"]));
    // 本页改点东西并等它落地（别留下没触发的防抖保存，会跨用例串门）
    useCanvasStore.getState().updateNodeData("a", { name: "本页改的" });
    await useCanvasStore.getState().persistNodesAndWait();
    // 压一个快照进历史：此刻远端节点还不存在
    useCanvasStore.getState().pushHistory();

    // 别的客户端 / 插件推来一个新节点：它不会进任何历史快照
    useCanvasStore.getState().applyRemoteNodeEvent({
      // 事件游标（nodeEventCursorByProject）跨 loadProject 保留，用例之间会互相顶：
      // 这里必须比后面用例的 id 小，否则那边的事件会被当成重放丢掉。
      id: 90,
      nodeKey: "remote-new",
      nodeVersion: 1,
      eventType: "upsert",
      node: serverNode("remote-new", 1),
      clientId: "other-page",
    });
    expect(keysOf()).toContain("remote-new");

    deleteNode.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useCanvasStore.getState().undo();
    await useCanvasStore.getState().persistNodesAndWait();

    // 修复前：remote-new 被当成"用户新建的"登记删除意图，真的从服务端删掉
    expect(deleteNode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("从服务端加载进来的节点也不会被撤销删掉", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    useCanvasStore.getState().pushHistory();
    // 手工把 b 从本地摘掉但不登记意图（模拟内存状态异常），再撤销
    const remaining = useCanvasStore
      .getState()
      .nodes.filter((node) => String(node.data.nodeKey) !== "b");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useCanvasStore.getState().setNodes(remaining, { persist: false });
    deleteNode.mockClear();

    useCanvasStore.getState().undo();
    await useCanvasStore.getState().persistNodesAndWait();

    expect(deleteNode).not.toHaveBeenCalled();
  });
});

describe("React Flow 量出来的尺寸不算改动", () => {
  it("只补上 measured 宽高，不产生任何写请求", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    upsert.mockClear();

    // 模拟挂载后的 dimensions 变更：React Flow 把量到的尺寸写进 width/height/measured
    const measured = useCanvasStore.getState().nodes.map((node) => ({
      ...node,
      width: 620,
      height: 350,
      measured: { width: 620, height: 350 },
    }));
    useCanvasStore.getState().setNodes(measured);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(upsert).not.toHaveBeenCalled();
  });

  it("用户真的改尺寸（contentWidth/contentHeight）照样保存", async () => {
    useCanvasStore.getState().loadProject(project(["a"]));
    upsert.mockClear();

    useCanvasStore.getState().updateNodeSize("a", 900, 600);
    await useCanvasStore.getState().persistNodesAndWait();

    expect(upsert).toHaveBeenCalledTimes(1);
    const node = (upsert.mock.calls[0] as unknown[])[1] as { data: string };
    expect(JSON.parse(node.data)).toMatchObject({ contentWidth: 900, contentHeight: 600 });
  });
});

describe("版本号必须跟服务端比的是同一个字段", () => {
  // 生产实测：存量节点 _collabVersion 全是 0，事件表 node_version 已经到 1~8
  // （生成结果落盘和老的整表保存都只写事件版本、没写回节点）。
  // 客户端要是采用 event.nodeVersion，下一次编辑就会带着 4 去撞服务端的 0 → 409
  // → saveBlockedProjects 停掉整个画布的保存，刷新前的改动全丢。
  it("远端事件版本领先时，仍按节点数据里的 _collabVersion 上报", async () => {
    useCanvasStore.getState().loadProject(project(["a"]));

    useCanvasStore.getState().applyRemoteNodeEvent({
      id: 9001,
      nodeKey: "a",
      nodeVersion: 4, // 事件表的版本
      eventType: "upsert",
      node: {
        ...serverNode("a", 0), // 但库里节点的 _collabVersion 是 0
        name: "被生成结果改过",
      },
      clientId: "server-generation-result",
    });

    useCanvasStore.getState().updateNodeData("a", { name: "我接着改" });
    await useCanvasStore.getState().persistNodesAndWait();

    expect(upsert).toHaveBeenCalledTimes(1);
    // 第三个参数是 expectedVersion，必须是 0（服务端会拿 _collabVersion 比），不能是 4
    expect((upsert.mock.calls[0] as unknown[])[2]).toBe(0);
  });
});

describe("刷新画布不会掉节点", () => {
  it("重新载入后立刻保存，不产生任何写请求", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b", "c"]));
    await useCanvasStore.getState().persistNodesAndWait();

    // 刷新后本地指纹 == 服务端节点，既不该 upsert 也不该 delete
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteNode).not.toHaveBeenCalled();
    expect(keysOf()).toEqual(["a", "b", "c"]);
  });
});

/**
 * 单个节点的版本冲突不许连坐整个画布。
 *
 * 2026-08-14 canvas 235「衣篇6」：19:26:31 一次 /nodes/upsert 返回 409
 * CANVAS_NODE_VERSION_CONFLICT，客户端把整个画布加进 saveBlockedProjects，
 * 之后 25 分钟心跳正常、一次保存都没有 —— 用户以为在正常工作，实际什么都没存。
 * 服务端拒的只是那一个节点（别的页面/生成结果把它改新了），画布其余部分完全可写。
 */
describe("单节点冲突不许停掉整个画布的保存", () => {
  const conflict = () => {
    const error = new Error("conflict") as Error & { response?: unknown };
    error.response = { status: 409, data: { errorCode: "CANVAS_NODE_VERSION_CONFLICT", currentVersion: 9 } };
    return error;
  };

  it("同一批里冲突节点跳过，其它节点照样存上去", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b", "c"]));
    upsert.mockClear();
    upsert.mockImplementation(async (...args: unknown[]) => {
      if ((args[1] as { nodeKey?: string })?.nodeKey === "b") throw conflict();
      return { ok: true, nodeVersion: 2, contentVersion: "cv-next" };
    });

    useCanvasStore.getState().updateNodeData("a", { name: "改了 a" });
    useCanvasStore.getState().updateNodeData("b", { name: "改了 b" });
    useCanvasStore.getState().updateNodeData("c", { name: "改了 c" });
    await useCanvasStore.getState().persistNodesAndWait();

    const saved = (upsert.mock.calls as unknown[][]).map((call) => (call[1] as { nodeKey: string }).nodeKey);
    expect(saved).toContain("a");
    expect(saved).toContain("b"); // 撞了一次
    expect(saved).toContain("c"); // 关键：b 冲突没有中断这一轮
  });

  it("冲突之后画布还能继续保存（不是永久停掉）", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    upsert.mockClear();
    upsert.mockImplementation(async (...args: unknown[]) => {
      if ((args[1] as { nodeKey?: string })?.nodeKey === "b") throw conflict();
      return { ok: true, nodeVersion: 2, contentVersion: "cv-next" };
    });

    useCanvasStore.getState().updateNodeData("b", { name: "撞冲突" });
    await useCanvasStore.getState().persistNodesAndWait();
    upsert.mockClear();

    // 修复前：这一次 persist 在第一行就 return，一个请求都不会发
    useCanvasStore.getState().updateNodeData("a", { name: "冲突之后再改别的" });
    await useCanvasStore.getState().persistNodesAndWait();

    const saved = (upsert.mock.calls as unknown[][]).map((call) => (call[1] as { nodeKey: string }).nodeKey);
    expect(saved).toEqual(["a"]);
  });

  it("已知冲突的节点不再反复重试（每轮多打一个 409）", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    upsert.mockClear();
    upsert.mockImplementation(async (...args: unknown[]) => {
      if ((args[1] as { nodeKey?: string })?.nodeKey === "b") throw conflict();
      return { ok: true, nodeVersion: 2, contentVersion: "cv-next" };
    });

    useCanvasStore.getState().updateNodeData("b", { name: "第一次" });
    await useCanvasStore.getState().persistNodesAndWait();
    useCanvasStore.getState().updateNodeData("b", { name: "第二次" });
    await useCanvasStore.getState().persistNodesAndWait();
    useCanvasStore.getState().updateNodeData("b", { name: "第三次" });
    await useCanvasStore.getState().persistNodesAndWait();

    const bCalls = (upsert.mock.calls as unknown[][]).filter((call) => (call[1] as { nodeKey: string }).nodeKey === "b");
    expect(bCalls).toHaveLength(1);
  });

  it("重新载入画布后，冲突节点恢复可保存", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    upsert.mockClear();
    upsert.mockImplementation(async (...args: unknown[]) => {
      if ((args[1] as { nodeKey?: string })?.nodeKey === "b") throw conflict();
      return { ok: true, nodeVersion: 2, contentVersion: "cv-next" };
    });
    useCanvasStore.getState().updateNodeData("b", { name: "撞一次" });
    await useCanvasStore.getState().persistNodesAndWait();

    // 刷新 = 对齐冲突节点的方式
    upsert.mockClear();
    upsert.mockImplementation(async () => ({ ok: true, nodeVersion: 3, contentVersion: "cv-next" }));
    useCanvasStore.getState().loadProject(project(["a", "b"], "cv-2"));
    useCanvasStore.getState().updateNodeData("b", { name: "刷新之后再改" });
    await useCanvasStore.getState().persistNodesAndWait();

    const saved = (upsert.mock.calls as unknown[][]).map((call) => (call[1] as { nodeKey: string }).nodeKey);
    expect(saved).toEqual(["b"]);
  });

  /**
   * 2026-08-15 canvas 195「cindy_test」：打开画布后 14 秒内自己跟自己撞了 8 个节点，
   * 弹出"有 8 个节点在服务端已更新"——而那 8 个节点全是本页刚写的，没有别的页面。
   *
   * 链路：SSE 一连上，服务端先发一帧 ready，带着最近所有变更的 nodeKey（包括本页自己
   * 刚写的）→ 客户端当成"别人改了"，去拉一份整量快照 → syncProject 内部调 loadProject
   * → 节点版本基准被重置成快照里的 _collabVersion。快照是保存还在飞的时候读的，比本地
   * 已经写进去的低，于是下一轮保存拿旧版本号 upsert，整批 409。
   */
  it("同步快照比本地旧时，不许把节点版本号退回去", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"])); // 快照里 _collabVersion = 1
    upsert.mockClear();
    upsert.mockImplementation(async () => ({ ok: true, nodeVersion: 2, contentVersion: "cv-2" }));

    useCanvasStore.getState().updateNodeData("a", { name: "本页写到 v2" });
    await useCanvasStore.getState().persistNodesAndWait();
    expect((upsert.mock.calls[0] as unknown[])[2]).toBe(1);

    // 服务端读快照那一刻 a 还是 v1（本页的写入还没落地），内容版本也还是旧的
    useCanvasStore.getState().syncProject(project(["a", "b"], "cv-stale"), ["b"]);

    upsert.mockClear();
    useCanvasStore.getState().updateNodeData("a", { name: "同步之后再改 a" });
    await useCanvasStore.getState().persistNodesAndWait();

    expect(upsert).toHaveBeenCalledTimes(1);
    // 修复前这里是 1 → 服务端 409；本地记着的 2 才是真相
    expect((upsert.mock.calls[0] as unknown[])[2]).toBe(2);
  });

  it("远端版本更高时照旧采用远端（取大值不是无脑保留本地）", async () => {
    useCanvasStore.getState().loadProject(project(["a"]));
    upsert.mockClear();
    upsert.mockImplementation(async () => ({ ok: true, nodeVersion: 7, contentVersion: "cv-next" }));

    // 别的页面把 a 写到了 v9
    useCanvasStore.getState().syncProject(
      {
        ...project(["a"], "cv-remote"),
        nodeList: [serverNode("a", 9)],
      } as unknown as Project,
      ["a"],
    );

    useCanvasStore.getState().updateNodeData("a", { name: "在远端版本上继续改" });
    await useCanvasStore.getState().persistNodesAndWait();

    expect((upsert.mock.calls[0] as unknown[])[2]).toBe(9);
  });

  it("整份基准过期仍然要停掉保存（这一类不能放行）", async () => {
    useCanvasStore.getState().loadProject(project(["a", "b"]));
    upsert.mockClear();
    upsert.mockImplementation(async () => {
      const error = new Error("stale") as Error & { response?: unknown };
      error.response = { status: 409, data: { errorCode: "CANVAS_CONTENT_VERSION_CONFLICT" } };
      throw error;
    });
    useCanvasStore.getState().updateNodeData("a", { name: "改一下" });
    await useCanvasStore.getState().persistNodesAndWait();
    upsert.mockClear();

    useCanvasStore.getState().updateNodeData("b", { name: "再改一下" });
    await useCanvasStore.getState().persistNodesAndWait();
    expect(upsert).not.toHaveBeenCalled(); // 基准过期时继续写会覆盖别人的东西
  });
});
