import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: "cv-next" })),
    deleteNode: vi.fn(async () => ({ ok: true, deleted: true, nodeVersion: 2, contentVersion: "cv-next" })),
    delete: vi.fn(async () => ({ data: { contentVersion: "cv-next" } })),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore } = await import("@/store/canvasStore");

const UUID = "group-second";

function serverNode(nodeKey: string, x: number) {
  return {
    nodeKey,
    projectUuid: UUID,
    type: 2,
    name: nodeKey,
    status: 1,
    position: { positionX: x, positionY: 0 },
    measured: { width: 240, height: 160 },
    data: JSON.stringify({
      type: "text",
      name: nodeKey,
      nodeKey,
      prompt: "",
      contentWidth: 240,
      contentHeight: 160,
    }),
  };
}

function project(): Project {
  return {
    projectMeta: {
      uuid: UUID,
      name: "打组",
      ownerId: 1,
      isOwner: true,
      canManage: true,
      canWrite: true,
      contentVersion: "cv-1",
    },
    projectDraft: {
      projectUuid: UUID,
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1,
      canvasTextScale: 1,
      lastPluginEditAtMs: 0,
    },
    nodeList: ["a", "b", "c", "d"].map((key, index) => serverNode(key, index * 400)),
  } as unknown as Project;
}

function groups() {
  return useCanvasStore.getState().nodes.filter((node) => node.type === "group");
}

function childIds(node: { data: { params?: unknown } }) {
  const params = (node.data.params ?? {}) as { childIds?: string[] };
  return params.childIds ?? [];
}

beforeEach(() => {
  useCanvasStore.getState().clearProject();
  useCanvasStore.getState().loadProject(project());
});

describe("groupNodes", () => {
  it("creates a second group without absorbing the first", () => {
    useCanvasStore.getState().groupNodes(["a", "b"]);
    useCanvasStore.getState().groupNodes(["c", "d"]);
    const grouped = groups();
    expect(grouped).toHaveLength(2);
    const members = grouped.map((node) => childIds(node).slice().sort());
    expect(members).toEqual(expect.arrayContaining([["a", "b"], ["c", "d"]]));
    expect(new Set(members.flat()).size).toBe(4);
  });

  it("does not stack a second frame on the same nodes", () => {
    useCanvasStore.getState().groupNodes(["a", "b"]);
    useCanvasStore.getState().groupNodes(["a", "b"]);
    const grouped = groups();
    expect(grouped).toHaveLength(1);
    expect(childIds(grouped[0]).slice().sort()).toEqual(["a", "b"]);
  });

  it("releases a node from the previous group instead of sharing it", () => {
    useCanvasStore.getState().groupNodes(["a", "b"]);
    useCanvasStore.getState().groupNodes(["b", "c"]);
    const grouped = groups();
    expect(grouped).toHaveLength(1);
    expect(childIds(grouped[0]).slice().sort()).toEqual(["b", "c"]);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === "a")).toBe(true);
  });
});
