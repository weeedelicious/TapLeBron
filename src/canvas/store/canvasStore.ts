import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { Node, Edge, Viewport } from "@xyflow/react";
import type {
  CanvasNode,
  CanvasNodeData,
  FavoriteLibraryPayload,
  Project,
} from "@/lib/types";
import {
  NODE_TYPE_INT,
  makeNodeData,
  NODE_LABELS,
  defaultVideoParams,
} from "@/lib/nodeData";
import { assetsApi, nodesApi, projectsApi, type CanvasNodeEvent } from "@/lib/api";
import {
  collectLocalAssetUrls,
  parseLocalAssetUrl,
  rewriteLocalAssetUrls,
} from "@/lib/localAssetUrls";
import { debounce } from "@/lib/debounce";
import {
  assetUrlCandidates,
  mergeAssetCreatedAtMap,
} from "@/lib/assetTimestamps";

const EDGE_INTERACTION_WIDTH = 34;
/** 这些节点的产出走右侧名为 capture 的输出 handle，而不是节点默认输出点 */
const CAPTURE_OUTPUT_NODE_TYPES = new Set(["panorama_viewer", "image_compare", "video_compare"]);
const SCRIPT_NODE_DRAG_HANDLE = ".script-node-drag-area";
const GROUP_NODE_DRAG_HANDLE = ".group-node-drag-surface";
const NODE_TITLE_SCREEN_HEIGHT = 26;
const GROUP_BOUNDS_PADDING_SCREEN = 10;
const DEFAULT_CANVAS_TEXT_SCALE = 1;
const MIN_CANVAS_TEXT_SCALE = 0.7;
const MAX_CANVAS_TEXT_SCALE = 1.8;
const NODE_REF_LIST_KEYS = [
  "imageList",
  "videoList",
  "audioList",
  "textList",
  "mixedList",
] as const;
const knownPluginEditAtMsByProject = new Map<string, number>();
const contentVersionByProject = new Map<string, string>();
const saveBlockedProjects = new Set<string>();
const conflictNotifiedProjects = new Set<string>();
/**
 * 服务端已有更新版本、本页撞过 409 的单个节点。
 *
 * 逐节点保存时，一个节点的版本冲突不该连坐整个画布：以前 CANVAS_NODE_VERSION_CONFLICT
 * 会把画布加进 saveBlockedProjects，于是**整页永久停止保存**，而且界面上只有一条容易被
 * 忽略的横幅（2026-08-14 canvas 235「衣篇6」：19:26:31 撞一次 upsert 409，之后 25 分钟
 * 心跳正常、一次保存都没有，用户以为在正常工作）。
 *
 * 现在改成：记下这个节点、跳过它，继续保存同一批里其它节点。既不停掉画布，也不拿本地
 * 内容去盖服务端那份更新的（那会静默丢掉别人的修改）。这个节点要等刷新后重新对齐。
 */
const conflictedNodesByProject = new Map<string, Set<string>>();
const nodeVersionsByProject = new Map<string, Map<string, number>>();
const nodeFingerprintsByProject = new Map<string, Map<string, string>>();
const nodeEventCursorByProject = new Map<string, number>();

// 用户真的删掉了哪些节点。自动保存只会删这里登记过的 key——
// "节点从本地列表里消失了"本身不是删除意图（2026-08-12 canvas 220、08-13 canvas 238
// 两次节点丢失就是被当成了删除意图），登记表之外的消失一律不动服务端数据。
type PendingNodeDeletion = {
  bulkDeleteConfirmed: boolean;
  allowClearCanvas: boolean;
};
const pendingNodeDeletionsByProject = new Map<
  string,
  Map<string, PendingNodeDeletion>
>();

/**
 * 远端来源的节点：从服务端加载进来的，以及通过 SSE 推过来的（别的客户端 / Cindy 插件写的）。
 *
 * 只有 undo 用它。撤销要还原的是"本页做过的操作"，而远端推过来的节点从不进任何历史快照，
 * 于是它天然处于"在 nodes 里、不在任何快照里"的状态——undo 原来会把这种节点算成"用户
 * 新建的"、登记删除意图、真的从服务端删掉。按一次 Ctrl+Z 就能删掉别人刚加的东西，而且
 * 护栏挡不住（意图是明确登记过的）。这张表就是用来把它们排除掉的。
 */
const remoteOriginNodesByProject = new Map<string, Set<string>>();

function markNodesRemoteOrigin(projectUuid: string, nodeKeys: string[]) {
  if (!projectUuid || nodeKeys.length === 0) return;
  const known =
    remoteOriginNodesByProject.get(projectUuid) ?? new Set<string>();
  remoteOriginNodesByProject.set(projectUuid, known);
  for (const nodeKey of nodeKeys) if (nodeKey) known.add(String(nodeKey));
}

/**
 * 登记"这些节点是用户点删除删掉的"。
 *
 * 自动保存只肯删登记过的节点（没登记的一律当成内存状态异常，宁可刷新后节点回来也不动
 * 服务端数据——canvas 220 / 238 两次节点丢失就是没有这道门）。所以**任何**把节点从
 * 画布上摘掉的入口都必须先走这里，包括 React Flow 自己用 Delete / Backspace 摘掉的。
 */
export function markNodesDeletedByUser(
  projectUuid: string,
  nodeKeys: string[],
  remainingNodeCount: number,
) {
  if (!projectUuid || nodeKeys.length === 0) return;
  const pending =
    pendingNodeDeletionsByProject.get(projectUuid) ??
    new Map<string, PendingNodeDeletion>();
  pendingNodeDeletionsByProject.set(projectUuid, pending);
  const declaration: PendingNodeDeletion = {
    // 一次操作删 3 个以上算批量，服务端的连删护栏需要这个确认。
    bulkDeleteConfirmed: nodeKeys.length >= 3,
    allowClearCanvas: remainingNodeCount === 0,
  };
  for (const nodeKey of nodeKeys) {
    if (nodeKey) pending.set(String(nodeKey), declaration);
  }
}
export const CANVAS_CLIENT_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const CANVAS_CLIENT_VERSION = "collab-20260810";

export const CANVAS_REMOTE_SYNC_REQUIRED_EVENT =
  "shotflow:canvas-remote-sync-required";

/**
 * 本页还有没有没落地的节点保存（正在发的 + 队列里等的 + 防抖还没触发的）。
 *
 * 实时同步必须问一下这个：拉回来的整份快照是服务端在"某一刻"读到的样子，
 * 如果那一刻本页的保存还在飞，快照里的节点版本就比本地已经写进去的低。
 * 把它当基准套上来，下一轮保存就会拿旧版本号 upsert，服务端必然 409。
 */
export function hasPendingNodeSaves(projectUuid: string) {
  if (nodeSaveInFlight) return true;
  if (pendingNodeSave?.projectUuid === projectUuid) return true;
  return debouncedPersistNodes.pending();
}

export type FlowNode = Node & {
  data: CanvasNodeData & { nodeKey: string; projectUuid: string };
};

function dragHandleForType(type: string) {
  if (type === "group") return GROUP_NODE_DRAG_HANDLE;
  return type === "script" ? SCRIPT_NODE_DRAG_HANDLE : undefined;
}

interface HistorySnapshot {
  nodes: FlowNode[];
  edges: Edge[];
}
interface SetNodesOptions {
  persist?: boolean;
  markDirty?: boolean;
  immediate?: boolean;
}
interface AddNodeOptions {
  recordHistory?: boolean;
}

const NODE_SAVE_RETRY_DELAYS_MS = [2000, 5000, 10000];

let nodeSaveVersion = 0;
let nodeSaveInFlight = false;
let pendingNodeSave: PendingNodeSave | null = null;
let nodeSaveSetState: ((s: Partial<CanvasState>) => void) | null = null;

interface CanvasState {
  projectUuid: string | null;
  projectName: string;
  collectionId: string | null;
  collectionName: string;
  projectOwnerId: number | null;
  projectOwnerName: string;
  projectShared: boolean;
  projectIsOwner: boolean;
  projectCanManage: boolean;
  projectCanWrite: boolean;
  lastPluginEditAtMs: number;
  contentVersion: string;
  nodes: FlowNode[];
  edges: Edge[];
  viewport: Viewport;
  canvasTextScale: number;
  selectedNodeKeys: string[];
  activePanelNodeId: string | null;
  connectionHoverTargetId: string | null;
  cindyMode: "default" | "film" | "master";
  cindyEnabled: boolean;
  /** 这个账号能用哪些 Skill 模式（由 /status 写入）。聊天人人可用，高级模式按名单。 */
  cindyModes: Array<"default" | "film" | "master">;
  isDirty: boolean;
  isSaving: boolean;
  clipboard: { nodes: FlowNode[]; edges: Edge[] } | null;
  history: HistorySnapshot[];
  historyIndex: number;

  loadProject: (project: Project) => void;
  clearProject: () => void;
  syncProject: (project: Project, changedNodeKeys?: string[]) => void;
  applyRemoteNodeEvent: (event: CanvasNodeEvent) => void;
  setProjectUuid: (uuid: string) => void;
  setContentVersion: (contentVersion: string) => void;
  setNodes: (nodes: FlowNode[], options?: SetNodesOptions) => void;
  setEdges: (edges: Edge[]) => void;
  setViewport: (vp: Viewport) => void;
  setCanvasTextScale: (scale: number) => void;
  setSelected: (keys: string[]) => void;
  setActivePanelNode: (nodeId: string | null) => void;
  setConnectionHoverTarget: (nodeId: string | null) => void;
  setCindyMode: (mode: "default" | "film" | "master") => void;
  setCindyEnabled: (enabled: boolean) => void;
  setCindyModes: (modes: Array<"default" | "film" | "master">) => void;
  addNode: (type: string) => FlowNode;
  addNodeAt: (
    type: string,
    x: number,
    y: number,
    extraData?: Partial<CanvasNodeData>,
    options?: AddNodeOptions,
  ) => FlowNode;
  deleteNodes: (nodeKeys: string[]) => void;
  deleteGroupWithChildren: (groupId: string) => void;
  updateNodeData: (nodeKey: string, patch: Partial<CanvasNodeData>) => void;
  updateNodeSize: (nodeKey: string, w: number, h: number) => void;
  persistNodes: () => Promise<void>;
  persistNodesAndWait: () => Promise<boolean>;
  persistViewport: () => Promise<void>;
  groupNodes: (nodeIds: string[]) => void;
  copySelected: () => void;
  pasteClipboard: (position?: { x: number; y: number }) => void;
  pushHistory: () => void;
  undo: () => void;
  ungroupNodes: (groupId: string) => void;
  duplicateNodes: (nodeIds: string[]) => void;
  insertFavoritePayload: (
    payload: FavoriteLibraryPayload,
    position?: { x: number; y: number },
  ) => Promise<void>;
}

interface PendingNodeSave {
  projectUuid: string;
  nodes: FlowNode[];
  setState: (s: Partial<CanvasState>) => void;
  saveVersion: number;
  baseContentVersion: string;
  resolve?: (saved: boolean) => void;
}

function canvasNodesFromFlow(projectUuid: string, nodes: FlowNode[]) {
  return nodes.map((n) => ({
    nodeKey: n.data.nodeKey,
    projectUuid,
    type: NODE_TYPE_INT[n.data.type] ?? 2,
    name: n.data.name,
    position: { positionX: n.position.x, positionY: n.position.y },
    measured: {
      width: n.data.contentWidth ?? n.width ?? n.measured?.width ?? 620,
      height: n.data.contentHeight ?? n.height ?? n.measured?.height ?? 350,
    },
    data: JSON.stringify(n.data),
    status: 1,
  }));
}

function nodeFingerprint(node: FlowNode) {
  const data = { ...node.data };
  delete data._collabVersion;
  // 尺寸只看 data.contentWidth / contentHeight（已经在下面的 data 里），不看 node.width /
  // node.measured。后两个是 React Flow 量出来的派生值：画布刚挂载时它会给每个节点补一次
  // dimensions 变更，于是 22 个节点的指纹同时"变了"，每次打开画布都白跑一整轮全量重存
  // （2026-08-15 canvas 195 实测：打开一次 = 80 多次 upsert，canvas_revisions 的 100 条
  // 上限十几分钟就烧光，用户点的删除还得排在这堆东西后面）。
  // 用户真的拉尺寸、以及组自动贴合子节点，走的都是 contentWidth / contentHeight，不会漏。
  return JSON.stringify({
    nodeKey: node.data.nodeKey,
    type: node.data.type,
    name: node.data.name,
    position: node.position,
    data,
  });
}

function serverNodeFromFlow(projectUuid: string, node: FlowNode) {
  return canvasNodesFromFlow(projectUuid, [node])[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeSaveErrorData(error: unknown) {
  return (
    error as {
      response?: {
        status?: number;
        data?: {
          errorCode?: string;
          changedNodeKeys?: string[];
          currentVersion?: number;
          // upsert 的 409 会带上服务端当前那份节点快照（见 canvasRoutes.js 的
          // nodes/upsert）。有它就能把本地这一个节点 rebase 回服务端版本。
          node?: CanvasNode | null;
        };
      };
      code?: string;
      message?: string;
    }
  )?.response?.data;
}

/** 一轮保存里最多 rebase 这么多个节点。超出就退回「跳过」，避免病态状态下反复重写节点。 */
const MAX_REBASE_PER_PASS = 8;

/**
 * 用服务端 409 带回来的快照把本地这一个节点 rebase 回去，返回是否真的 rebase 了。
 *
 * 直接复用 applyRemoteNodeEvent —— 它本来就在做「用服务端快照替换本地一个节点」，并且顺带
 * 处理了三件容易漏的事：版本号取 data._collabVersion 而不是事件里的 nodeVersion、重算指纹
 * 基线、markNodesRemoteOrigin（否则 undo 会把它当成本页新建的节点删掉）。
 *
 * 唯一要绕开的是它那条「本地与基线指纹不一致就拒绝覆盖」的护栏：走到这里的节点**一定**是脏的
 * （保存循环只 upsert 指纹变了的节点），那条护栏必然拦住。所以先把基线清掉再调 —— 这一步
 * 等于明确声明「这一个节点以服务端为准」。
 */
function rebaseConflictedNode(
  projectUuid: string,
  nodeKey: string,
  snapshot?: CanvasNode | null,
  serverVersion?: number,
) {
  if (!snapshot) return false;
  nodeFingerprintsByProject.get(projectUuid)?.delete(nodeKey);
  try {
    useCanvasStore.getState().applyRemoteNodeEvent({
      // 不带事件 id：applyRemoteNodeEvent 的游标判重只在 id 非 0 时生效，而这份快照不是从
      // 事件流来的，不该推进游标（推了会漏掉后面真正的远端事件）。
      id: 0,
      nodeKey,
      nodeVersion: 0,
      eventType: "upsert",
      node: snapshot,
    });
  } catch (error) {
    console.error("[canvas] rebase 冲突节点失败", nodeKey, error);
    return false;
  }
  const versions = nodeVersionsByProject.get(projectUuid);
  if (!versions?.has(nodeKey)) return false;
  // 兜底对齐：服务端乐观锁比的是 _collabVersion，快照里那个值理应等于 currentVersion。
  // 万一是早期遗留节点、快照里的 _collabVersion 停在 0，下一轮保存又会带着 0 去撞 409，
  // 变成死循环。以服务端给的 currentVersion 为准。
  const aligned = Number(serverVersion || 0);
  if (aligned && versions.get(nodeKey) !== aligned) versions.set(nodeKey, aligned);
  return true;
}

function isRetryableNodeSaveError(error: unknown) {
  const typed = error as {
    response?: { status?: number };
    code?: string;
    message?: string;
  };
  const status = Number(typed.response?.status || 0);
  const code = String(typed.code || "");
  const message = String(typed.message || "");
  if (status === 409) return false;
  if (status === 408 || status === 429 || status >= 500) return true;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ERR_NETWORK")
    return true;
  return /timeout|network|lock wait/i.test(message);
}

async function persistNodesNow(
  save: PendingNodeSave,
  attempt = 0,
): Promise<void> {
  const { projectUuid, nodes, setState, saveVersion } = save;
  if (saveBlockedProjects.has(projectUuid)) {
    save.resolve?.(false);
    return;
  }
  const canvasNodes = canvasNodesFromFlow(projectUuid, nodes);
  const clientSaveAtMs = Date.now();
  const knownPluginEditAtMs =
    knownPluginEditAtMsByProject.get(projectUuid) ?? 0;
  const baseContentVersion = save.baseContentVersion;
  try {
    const versions = nodeVersionsByProject.get(projectUuid) ?? new Map<string, number>();
    const fingerprints = nodeFingerprintsByProject.get(projectUuid) ?? new Map<string, string>();
    nodeVersionsByProject.set(projectUuid, versions);
    nodeFingerprintsByProject.set(projectUuid, fingerprints);
    const currentKeys = new Set(nodes.map((node) => String(node.data.nodeKey || node.id)));
    let latestContentVersion = contentVersionByProject.get(projectUuid) ?? "";

    // 删除先走，不排在 upsert 后面。
    //
    // 用户点删除时画布上往往还压着一堆待存的几何变更；删除请求排在它们后面要等一两秒才
    // 发出去，这段时间里用户只要刷新一次（大家验证删除有没有生效就是刷新），删除意图连同
    // 整个保存队列一起被丢掉，节点当然"又回来了"。2026-08-15 canvas 195 实测：23:49–23:50
    // 七次刷新、近百次 upsert，delete-v2 一次都没发出去。
    // 删除是明确的用户意图，优先级高于节点尺寸和位置。
    const pendingDeletions = pendingNodeDeletionsByProject.get(projectUuid);
    for (const nodeKey of [...fingerprints.keys()]) {
      if (currentKeys.has(nodeKey)) continue;
      const declaration = pendingDeletions?.get(nodeKey);
      if (!declaration) {
        // 节点在本地消失了，但没人点过删除。这正是两次节点丢失的形态：
        // 只把它从跟踪表里摘掉，不动服务端——最坏结果是刷新后节点回来，而不是没了。
        console.warn(
          `[canvas ${projectUuid}] 节点 ${nodeKey} 在本地消失但没有删除意图，已跳过服务端删除`,
        );
        versions.delete(nodeKey);
        fingerprints.delete(nodeKey);
        continue;
      }
      let response;
      try {
        response = await nodesApi.deleteNode(
          projectUuid,
          nodeKey,
          versions.get(nodeKey) ?? 0,
          CANVAS_CLIENT_ID,
          declaration,
        );
      } catch (error) {
        const errorData = nodeSaveErrorData(error);
        const serverVersion = Number(errorData?.currentVersion || 0);
        if (
          errorData?.errorCode !== "CANVAS_NODE_VERSION_CONFLICT" ||
          !serverVersion
        ) {
          throw error;
        }
        // 节点版本被别处推进了，但"用户要删掉它"这个意图没变。拿服务端给的版本再删一次，
        // 否则一次版本竞速就能静悄悄吃掉用户的删除。
        response = await nodesApi.deleteNode(
          projectUuid,
          nodeKey,
          serverVersion,
          CANVAS_CLIENT_ID,
          declaration,
        );
      }
      versions.delete(nodeKey);
      fingerprints.delete(nodeKey);
      pendingDeletions?.delete(nodeKey);
      if (response.eventId)
        nodeEventCursorByProject.set(projectUuid, Number(response.eventId));
      if (response.contentVersion)
        latestContentVersion = String(response.contentVersion);
    }

    const conflictedNodes =
      conflictedNodesByProject.get(projectUuid) ?? new Set<string>();
    const freshConflicts: string[] = [];
    let rebasedThisPass = 0;
    for (const node of nodes) {
      const nodeKey = String(node.data.nodeKey || node.id);
      const fingerprint = nodeFingerprint(node);
      if (fingerprints.get(nodeKey) === fingerprint) continue;
      // 已知撞过版本冲突的节点不再重试：否则每一轮保存都会为它多打一次 409
      if (conflictedNodes.has(nodeKey)) continue;
      let response;
      try {
        response = await nodesApi.upsert(
          projectUuid,
          serverNodeFromFlow(projectUuid, node),
          versions.get(nodeKey) ?? Number(node.data._collabVersion || 0),
          CANVAS_CLIENT_ID,
        );
      } catch (error) {
        const conflictData = nodeSaveErrorData(error);
        if (conflictData?.errorCode !== "CANVAS_NODE_VERSION_CONFLICT") throw error;
        // 只有这一个节点服务端更新过。跳过它、继续存别的，不要连坐整个画布。
        freshConflicts.push(nodeKey);
        // 撞冲突的绝大多数情况是「这一页自己的生成结果回来了」：任务完成时服务端把结果写回
        // 节点、版本 +1，而这一轮保存带的还是写回之前的版本号。2026-08-17 线上统计：55 次
        // 409 里 52 次都落在任务轮询 / apply 的 ±5s 内，跟「别人在改你的画布」无关。
        //
        // 以前这里把节点加进 conflictedNodes 永久拉黑、不再重试，而那个名单只在 loadProject
        // 时清空 —— 后果是生成一完成，那个节点就从这一页的保存里被摘出去：之后你移动它、
        // 改它的提示词都不会落库，直到刷新或点「加载最新版本」。这比多弹一条横幅严重得多。
        //
        // 现在用 409 带回来的服务端快照把这一个节点 rebase 回去，版本号和指纹基线都对齐，
        // 下一轮保存就能正常写。代价是本地对这个节点的那一次待存改动被丢弃 —— 主场景里它
        // 就是生成进度状态，而服务端那份才是带着生成结果的权威版本。横幅照旧弹。
        const rebased = rebasedThisPass < MAX_REBASE_PER_PASS
          && rebaseConflictedNode(projectUuid, nodeKey, conflictData.node, conflictData.currentVersion);
        if (rebased) {
          rebasedThisPass += 1;
        } else {
          // 拿不到快照（别的 409 形态）或这一轮 rebase 已经太多：退回老行为，
          // 至少不会每轮保存都为它打一次 409。
          conflictedNodes.add(nodeKey);
          conflictedNodesByProject.set(projectUuid, conflictedNodes);
        }
        continue;
      }
      versions.set(nodeKey, Number(response.nodeVersion || 0));
      fingerprints.set(nodeKey, fingerprint);
      if (response.eventId) nodeEventCursorByProject.set(projectUuid, Number(response.eventId));
      if (response.contentVersion) latestContentVersion = String(response.contentVersion);
    }
    if (freshConflicts.length) {
      // 提示用户这些节点需要重新加载才能对齐，但保存继续进行
      window.dispatchEvent(
        new CustomEvent(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, {
          detail: {
            projectUuid,
            conflict: true,
            // 这一类只跳过了这几个节点，画布其余部分照常保存。
            // 横幅的文案要据此区分，别再说"保存已暂停"——那是另一种情况。
            savePaused: false,
            changedNodeKeys: freshConflicts,
          },
        }),
      );
    }

    if (latestContentVersion) contentVersionByProject.set(projectUuid, latestContentVersion);
    if (saveVersion === nodeSaveVersion) {
      setState({
        isDirty: false,
        ...(latestContentVersion ? { contentVersion: latestContentVersion } : {}),
      });
    }
    save.resolve?.(true);
  } catch (error) {
    const errorData = nodeSaveErrorData(error);
    const errorCode = errorData?.errorCode;
    // 只有"整份基准过期"才值得停掉整个画布的保存——那种情况下继续写会覆盖别人的东西。
    //
    // 以前这个名单还包含 CANVAS_NODE_VERSION_CONFLICT 和三个删除护栏码，那是错的：
    // 它们说的是"这一个节点/这一次删除被拒了"，画布整体没有任何问题，却让整页永久停止
    // 保存（2026-08-14 canvas 235：一次 upsert 409 之后 25 分钟一个字没存，界面上只有
    // 一条容易忽略的横幅）。单节点冲突现在在上面的 upsert 循环里就地跳过，删除护栏
    // 被拒时也只提示、不停保存。
    if (
      errorCode === "CANVAS_CONTENT_VERSION_CONFLICT" ||
      errorCode === "CANVAS_CONTENT_VERSION_REQUIRED" ||
      errorCode === "CANVAS_CLIENT_VERSION_REQUIRED"
    ) {
      saveBlockedProjects.add(projectUuid);
      debouncedPersistNodes.cancel();
      if (pendingNodeSave?.projectUuid === projectUuid) {
        pendingNodeSave.resolve?.(false);
        pendingNodeSave = null;
      }
      if (!conflictNotifiedProjects.has(projectUuid)) {
        conflictNotifiedProjects.add(projectUuid);
        window.dispatchEvent(
          new CustomEvent(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, {
            detail: {
              projectUuid,
              conflict: true,
              savePaused: true, // 整份基准过期，这个画布真的停止保存了
              changedNodeKeys: errorData?.changedNodeKeys || [],
            },
          }),
        );
      }
      if (saveVersion === nodeSaveVersion) setState({ isDirty: true });
      save.resolve?.(false);
      return;
    }
    // 删除护栏拒了某一次删除：提示用户重新同步，但不许停掉整个画布的保存。
    // 服务端拒绝的是"这一次删除"，画布其余部分照旧可写。
    if (
      errorCode === "CANVAS_DELETE_INTENT_REQUIRED" ||
      errorCode === "CANVAS_CLEAR_GUARD" ||
      errorCode === "CANVAS_DELETE_BURST_GUARD"
    ) {
      if (!conflictNotifiedProjects.has(projectUuid)) {
        conflictNotifiedProjects.add(projectUuid);
        window.dispatchEvent(
          new CustomEvent(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, {
            detail: {
              projectUuid,
              conflict: true,
              savePaused: false, // 拒的是这一次删除，画布其余部分照常保存
              changedNodeKeys: errorData?.changedNodeKeys || [],
            },
          }),
        );
      }
      if (saveVersion === nodeSaveVersion) setState({ isDirty: true });
      save.resolve?.(false);
      return;
    }
    if (errorCode === "CANVAS_PLUGIN_REVISION_CONFLICT") {
      if (saveVersion === nodeSaveVersion) {
        window.dispatchEvent(
          new CustomEvent(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, {
            detail: {
              projectUuid,
              changedNodeKeys: errorData?.changedNodeKeys || [],
            },
          }),
        );
        setState({ isDirty: true });
      }
      save.resolve?.(false);
      return;
    }
    if (
      saveVersion === nodeSaveVersion &&
      isRetryableNodeSaveError(error) &&
      attempt < NODE_SAVE_RETRY_DELAYS_MS.length
    ) {
      const delayMs = NODE_SAVE_RETRY_DELAYS_MS[attempt];
      console.warn(
        `autosave nodes retrying in ${Math.round(delayMs / 1000)}s`,
        error,
      );
      await sleep(delayMs);
      if (saveVersion !== nodeSaveVersion) return;
      await persistNodesNow(save, attempt + 1);
      return;
    }
    console.error("autosave nodes failed", error);
    if (saveVersion === nodeSaveVersion) setState({ isDirty: true });
    save.resolve?.(false);
  }
}

async function drainNodeSaveQueue() {
  if (nodeSaveInFlight) return;
  nodeSaveInFlight = true;
  nodeSaveSetState?.({ isSaving: true });
  try {
    while (pendingNodeSave) {
      const nextSave = pendingNodeSave;
      pendingNodeSave = null;
      nodeSaveSetState = nextSave.setState;
      await persistNodesNow(nextSave);
    }
  } finally {
    nodeSaveInFlight = false;
    if (pendingNodeSave) {
      void drainNodeSaveQueue();
      return;
    }
    nodeSaveSetState?.({ isSaving: false });
  }
}

function enqueuePersistNodes(save: PendingNodeSave) {
  if (saveBlockedProjects.has(save.projectUuid)) {
    save.resolve?.(false);
    return;
  }
  pendingNodeSave?.resolve?.(false);
  pendingNodeSave = save;
  nodeSaveSetState = save.setState;
  void drainNodeSaveQueue();
}

const debouncedPersistNodes = debounce(enqueuePersistNodes, 500);

function schedulePersistNodes(
  projectUuid: string,
  nodes: FlowNode[],
  setState: (s: Partial<CanvasState>) => void,
) {
  if (saveBlockedProjects.has(projectUuid)) return;
  nodeSaveVersion += 1;
  debouncedPersistNodes({
    projectUuid,
    nodes,
    setState,
    saveVersion: nodeSaveVersion,
    baseContentVersion: contentVersionByProject.get(projectUuid) ?? "",
  });
}

function persistNodesImmediately(
  projectUuid: string,
  nodes: FlowNode[],
  setState: (s: Partial<CanvasState>) => void,
) {
  if (saveBlockedProjects.has(projectUuid)) return;
  debouncedPersistNodes.cancel();
  nodeSaveVersion += 1;
  enqueuePersistNodes({
    projectUuid,
    nodes,
    setState,
    saveVersion: nodeSaveVersion,
    baseContentVersion: contentVersionByProject.get(projectUuid) ?? "",
  });
}

function persistNodesAndWait(
  projectUuid: string,
  nodes: FlowNode[],
  setState: (s: Partial<CanvasState>) => void,
) {
  if (saveBlockedProjects.has(projectUuid)) return Promise.resolve(false);
  debouncedPersistNodes.cancel();
  nodeSaveVersion += 1;
  return new Promise<boolean>((resolve) => {
    enqueuePersistNodes({
      projectUuid,
      nodes,
      setState,
      saveVersion: nodeSaveVersion,
      baseContentVersion: contentVersionByProject.get(projectUuid) ?? "",
      resolve,
    });
  });
}

const debouncedPersistViewport = debounce(
  async (projectUuid: string, viewport: Viewport, canvasTextScale: number) => {
    await projectsApi.saveDraft(projectUuid, {
      projectUuid,
      viewportX: viewport.x,
      viewportY: viewport.y,
      viewportZoom: viewport.zoom,
      canvasTextScale,
    });
  },
  600,
);

function defaultNodeName(type: string, count: number) {
  if (type === "image") return "image";
  return `${NODE_LABELS[type] ?? type} ${count}`;
}

function safeZoom(value: unknown) {
  const zoom = Number(value);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function normalizeCanvasTextScale(value: unknown) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return DEFAULT_CANVAS_TEXT_SCALE;
  return Math.min(
    MAX_CANVAS_TEXT_SCALE,
    Math.max(MIN_CANVAS_TEXT_SCALE, scale),
  );
}

function groupTitlePadding(zoomValue: unknown) {
  return NODE_TITLE_SCREEN_HEIGHT / safeZoom(zoomValue);
}

function nodeVisualWidth(node: FlowNode) {
  return Math.max(
    1,
    Number(node.data.contentWidth ?? node.width ?? node.measured?.width ?? 300),
  );
}

function nodeVisualHeight(node: FlowNode) {
  return Math.max(
    1,
    Number(
      node.data.contentHeight ?? node.height ?? node.measured?.height ?? 200,
    ),
  );
}

function groupBoundsForTargets(targets: FlowNode[], zoomValue: unknown) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of targets) {
    const width = nodeVisualWidth(node);
    const height = nodeVisualHeight(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }

  const zoom = safeZoom(zoomValue);
  const padding = GROUP_BOUNDS_PADDING_SCREEN / zoom;
  const topPadding = groupTitlePadding(zoomValue);
  const x = minX - padding;
  const y = minY - topPadding - padding;
  return {
    x,
    y,
    width: Math.max(1, maxX - x + padding),
    height: Math.max(1, maxY - y + padding),
  };
}

function expandGroupBoundsForTitles(nodes: FlowNode[], zoomValue: unknown) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (node.type !== "group") return node;
    const params = (node.data.params ?? {}) as { childIds?: string[] };
    const targets = (params.childIds ?? [])
      .map((childId) => nodeMap.get(childId))
      .filter((child): child is FlowNode => Boolean(child));
    if (targets.length === 0) return node;

    const computed = groupBoundsForTargets(targets, zoomValue);
    const currentWidth = nodeVisualWidth(node);
    const currentHeight = nodeVisualHeight(node);
    const left = Math.min(node.position.x, computed.x);
    const top = Math.min(node.position.y, computed.y);
    const right = Math.max(
      node.position.x + currentWidth,
      computed.x + computed.width,
    );
    const bottom = Math.max(
      node.position.y + currentHeight,
      computed.y + computed.height,
    );
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    return {
      ...node,
      position: { x: left, y: top },
      dragHandle: dragHandleForType("group"),
      selectable: false,
      data: {
        ...node.data,
        contentWidth: width,
        contentHeight: height,
      },
      style: {
        ...(node.style ?? {}),
        width,
        height,
        pointerEvents: "auto" as const,
      },
    };
  });
}

function isVideoUrl(url: unknown) {
  return (
    typeof url === "string" && /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(url)
  );
}

const PANORAMA_VIEWER_WIDTH = 500;
const PANORAMA_VIEWER_HEIGHT = 356;

function normalizeNodeDataForRender(data: CanvasNodeData): CanvasNodeData {
  const firstUrl = Array.isArray(data.url) ? data.url[0] : undefined;
  if (data.type !== "upload" || !isVideoUrl(firstUrl)) return data;
  return {
    ...data,
    type: "video",
    action: "image_resource",
    params: {
      ...defaultVideoParams(),
      ...((data.params as Record<string, unknown> | undefined) ?? {}),
    } as Record<string, unknown>,
  };
}

function stampCopiedMediaHistory(
  data: FlowNode["data"],
  timestamp = Date.now(),
) {
  const urls = Array.isArray(data.url)
    ? data.url.filter(
        (url): url is string =>
          typeof url === "string" && url.trim().length > 0,
      )
    : [];
  if (urls.length === 0) return data;

  const metaItems = data._resourceMeta?.items ?? [];
  const timestampUrls: string[] = [];
  for (const url of urls) {
    const meta = metaItems.find(
      (item) => item.originalUrl === url || item.displayUrl === url,
    );
    timestampUrls.push(...assetUrlCandidates(url, meta));
  }

  return {
    ...data,
    _assetCreatedAtMs: mergeAssetCreatedAtMap(
      data._assetCreatedAtMs,
      timestampUrls,
      timestamp,
    ),
    _updatedAtMs: timestamp,
  };
}

function expandNodeIdsForGroups(nodeIds: string[], nodes: FlowNode[]) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const result = new Set<string>();

  const collect = (nodeId: string) => {
    if (result.has(nodeId)) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;
    result.add(node.id);
    if (node.type !== "group") return;
    const params = (node.data.params ?? {}) as { childIds?: string[] };
    (params.childIds ?? []).forEach(collect);
  };

  nodeIds.forEach(collect);
  return result;
}

function remapNodeReferences(
  value: unknown,
  idMap: Record<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return idMap[item] ?? item;
      return remapNodeReferences(item, idMap);
    });
  }

  if (!value || typeof value !== "object") return value;

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "nodeId" || key === "sourceNodeId" || key === "resultNodeId") &&
      typeof item === "string"
    ) {
      next[key] = idMap[item] ?? item;
    } else {
      next[key] = remapNodeReferences(item, idMap);
    }
  }
  return next;
}

function copiedNodeData(
  data: FlowNode["data"],
  newId: string,
  idMap: Record<string, string>,
  timestamp: number,
) {
  const stamped = stampCopiedMediaHistory(data, timestamp);
  return {
    ...stamped,
    nodeKey: newId,
    taskInfo: undefined,
    params: stamped.params
      ? (remapNodeReferences(stamped.params, idMap) as Record<string, unknown>)
      : stamped.params,
  };
}

/**
 * 从节点数据推导出所有连线。**边从不单独存库**，loadProject / syncProject 每次重算。
 *
 * 导出是为了能直接测它：2026-08-26 三维空间的参考图连线「刷新就断掉」，就是因为
 * 具名槽引用（`params.stageRef`）少了下面那个重建块 —— 数据一直是对的，只有视图丢了。
 * 从 `setNodes` 那类入口测不到，因为 setNodes 根本不重算边。
 */
export function edgesFromNodeReferences(
  nodes: FlowNode[],
  existingEdges: Edge[] = [],
) {
  const idByAlias = new Map<string, string>();
  for (const node of nodes) {
    idByAlias.set(node.id, node.id);
    if (node.data.nodeKey) idByAlias.set(node.data.nodeKey, node.id);
  }

  const nextEdges = existingEdges
    .filter((edge) => {
      const targetNode = nodes.find(
        (node) => node.id === edge.target || node.data.nodeKey === edge.target,
      );
      const targetType = String(targetNode?.data.type ?? "");
      if (targetType !== "image_compare" && targetType !== "video_compare") return true;
      // 对比节点只认具名槽。没 targetHandle 的旧线叠在真槽线上，
      // 点删一根时认不出槽，会把同一多视频占的多个槽一次清光。
      if (!edge.targetHandle) return false;
      const params = (targetNode?.data.params ?? {}) as Record<string, unknown>;
      const refKey =
        edge.targetHandle === "compare-a"
          ? "compareRefA"
          : edge.targetHandle === "compare-b"
            ? "compareRefB"
            : edge.targetHandle === "compare-c"
              ? "compareRefC"
              : edge.targetHandle === "compare-d"
                ? "compareRefD"
                : null;
      if (!refKey) return false;
      const ref = params[refKey] as { nodeId?: unknown } | null | undefined;
      return Boolean(ref?.nodeId);
    })
    .map((edge) => ({
    ...edge,
    type: edge.type || "glow",
    selectable: true,
    interactionWidth: EDGE_INTERACTION_WIDTH,
  }));
  const pairSet = new Set(
    nextEdges.map((edge) => `${edge.source}->${edge.target}`),
  );

  for (const targetNode of nodes) {
    const nodeType = String(targetNode.data.type ?? "");
    // 图片 / 视频对比只走下面的具名槽，不从 imageList / videoList 再建一根无 handle 的线。
    // 那种线删掉时认不出槽，会把同一多视频占的多个槽一次清光。
    if (nodeType === "image_compare" || nodeType === "video_compare") continue;
    const params = (targetNode.data.params ?? {}) as Record<string, unknown>;
    for (const listKey of NODE_REF_LIST_KEYS) {
      const list = params[listKey];
      if (!Array.isArray(list)) continue;

      for (const item of list) {
        const sourceAlias =
          typeof item === "string"
            ? item
            : String((item as { nodeId?: unknown })?.nodeId ?? "");
        const sourceId = idByAlias.get(sourceAlias);
        if (!sourceId || sourceId === targetNode.id) continue;

        const pairKey = `${sourceId}->${targetNode.id}`;
        if (pairSet.has(pairKey)) continue;
        pairSet.add(pairKey);
        nextEdges.push({
          id: `e-${sourceId}-${targetNode.id}`,
          source: sourceId,
          // 全景查看器和图片对比节点的产出都挂在它们右侧的 capture 输出上，
          // 少了这个 handle，刷新后这条边会从节点默认输出点画出去、对不上位置。
          sourceHandle: CAPTURE_OUTPUT_NODE_TYPES.has(
            String(nodes.find((node) => node.id === sourceId)?.data.type ?? ""),
          )
            ? "capture"
            : undefined,
          target: targetNode.id,
          type: "glow",
          selectable: true,
          selected: false,
          interactionWidth: EDGE_INTERACTION_WIDTH,
        });
      }
    }
  }

  // Atmosphere-transfer nodes bind each input to a specific target handle and keep
  // them in params.sourceRef / referenceRef (not the flat reference lists), so
  // reconstruct those edges here — edges are always derived from node data (never
  // persisted separately), so without this the 原图/参考图 connections vanish on reload.
  for (const targetNode of nodes) {
    if ((targetNode.data.type as string) !== "atmosphere_transfer") continue;
    const params = (targetNode.data.params ?? {}) as Record<string, unknown>;
    const inputs: Array<[string, unknown]> = [
      ["source", params.sourceRef],
      ["reference", params.referenceRef],
    ];
    for (const [handle, refValue] of inputs) {
      const sourceAlias = String(
        (refValue as { nodeId?: unknown } | null | undefined)?.nodeId ?? "",
      );
      if (!sourceAlias) continue;
      const sourceId = idByAlias.get(sourceAlias);
      if (!sourceId || sourceId === targetNode.id) continue;
      const edgeId = `e-${sourceId}-${targetNode.id}-${handle}`;
      if (
        nextEdges.some(
          (e) =>
            e.id === edgeId ||
            (e.source === sourceId &&
              e.target === targetNode.id &&
              e.targetHandle === handle),
        )
      )
        continue;
      nextEdges.push({
        id: edgeId,
        source: sourceId,
        target: targetNode.id,
        targetHandle: handle,
        type: "glow",
        selectable: true,
        selected: false,
        interactionWidth: EDGE_INTERACTION_WIDTH,
      });
    }
  }

  // Panorama viewer nodes bind exactly one ERP image in params.panoramaRef.
  // Reconstruct the typed input edge after reload just like the atmosphere node inputs.
  for (const targetNode of nodes) {
    if ((targetNode.data.type as string) !== "panorama_viewer") continue;
    const params = (targetNode.data.params ?? {}) as Record<string, unknown>;
    const sourceAlias = String(
      (params.panoramaRef as { nodeId?: unknown } | null | undefined)?.nodeId ??
        "",
    );
    if (!sourceAlias) continue;
    const sourceId = idByAlias.get(sourceAlias);
    if (!sourceId || sourceId === targetNode.id) continue;
    const edgeId = `e-${sourceId}-${targetNode.id}-panorama`;
    if (
      nextEdges.some(
        (e) =>
          e.id === edgeId ||
          (e.source === sourceId &&
            e.target === targetNode.id &&
            e.targetHandle === "panorama"),
      )
    )
      continue;
    nextEdges.push({
      id: edgeId,
      source: sourceId,
      target: targetNode.id,
      targetHandle: "panorama",
      type: "glow",
      selectable: true,
      selected: false,
      interactionWidth: EDGE_INTERACTION_WIDTH,
    });
  }

  // 三维空间节点的参考图存在 params.stageRef（只收一张，用来分析出人物姿势）。
  // 不在这里重建的话，刷新之后那根线就没了 —— 引用还在、分析照样能用，
  // 但画布上看不出这个节点连着谁（2026-08-26 用户反馈「刷新就断掉」）。
  for (const targetNode of nodes) {
    if ((targetNode.data.type as string) !== "director_stage") continue;
    const params = (targetNode.data.params ?? {}) as Record<string, unknown>;
    const sourceAlias = String(
      (params.stageRef as { nodeId?: unknown } | null | undefined)?.nodeId ?? "",
    );
    if (!sourceAlias) continue;
    const sourceId = idByAlias.get(sourceAlias);
    if (!sourceId || sourceId === targetNode.id) continue;
    const edgeId = `e-${sourceId}-${targetNode.id}-stage-reference`;
    // 用「同一对 source→target」判重而不是只比 handle：这根线走的是节点默认输入口
    // （没有具名 handle），只比 handle 的话会和别的路径建的边重复画一根。
    if (
      nextEdges.some(
        (e) =>
          e.id === edgeId ||
          (e.source === sourceId && e.target === targetNode.id),
      )
    )
      continue;
    nextEdges.push({
      id: edgeId,
      source: sourceId,
      target: targetNode.id,
      type: "glow",
      selectable: true,
      selected: false,
      interactionWidth: EDGE_INTERACTION_WIDTH,
    });
  }

  // 图片 / 视频对比节点把输入绑在具名槽上。边永远是从节点数据推导的、从不单独持久化。
  for (const targetNode of nodes) {
    const nodeType = String(targetNode.data.type ?? "");
    if (nodeType !== "image_compare" && nodeType !== "video_compare") continue;
    const params = (targetNode.data.params ?? {}) as Record<string, unknown>;
    const slots: Array<[string, unknown]> = [
      ["compare-a", params.compareRefA],
      ["compare-b", params.compareRefB],
      ...(nodeType === "video_compare"
        ? [
            ["compare-c", params.compareRefC],
            ["compare-d", params.compareRefD],
          ] as Array<[string, unknown]>
        : []),
    ];
    for (const [handle, refValue] of slots) {
      const sourceAlias = String(
        (refValue as { nodeId?: unknown } | null | undefined)?.nodeId ?? "",
      );
      if (!sourceAlias) continue;
      const sourceId = idByAlias.get(sourceAlias);
      if (!sourceId || sourceId === targetNode.id) continue;
      const edgeId = `e-${sourceId}-${targetNode.id}-${handle}`;
      if (
        nextEdges.some(
          (e) =>
            e.id === edgeId ||
            (e.source === sourceId &&
              e.target === targetNode.id &&
              e.targetHandle === handle),
        )
      )
        continue;
      nextEdges.push({
        id: edgeId,
        source: sourceId,
        target: targetNode.id,
        targetHandle: handle,
        type: "glow",
        selectable: true,
        selected: false,
        interactionWidth: EDGE_INTERACTION_WIDTH,
      });
    }
  }

  return nextEdges;
}

function favoriteNodeData(
  data: FlowNode["data"],
  newId: string,
  projectUuid: string,
  idMap: Record<string, string>,
  timestamp: number,
) {
  const copied = copiedNodeData(data, newId, idMap, timestamp);
  return {
    ...copied,
    projectUuid,
    uploadInfo: undefined,
    _updatedAtMs: timestamp,
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  projectUuid: null,
  projectName: "未命名画布",
  collectionId: null,
  collectionName: "",
  projectOwnerId: null,
  projectOwnerName: "",
  projectShared: false,
  projectIsOwner: false,
  projectCanManage: false,
  projectCanWrite: false,
  lastPluginEditAtMs: 0,
  contentVersion: "",
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvasTextScale: DEFAULT_CANVAS_TEXT_SCALE,
  selectedNodeKeys: [],
  activePanelNodeId: null,
  connectionHoverTargetId: null,
  cindyMode: "default",
  cindyEnabled: false,
  cindyModes: ["default"],
  isDirty: false,
  isSaving: false,
  clipboard: null,
  history: [],
  historyIndex: -1,

  loadProject: (project: Project) => {
    nodeSaveVersion += 1;
    debouncedPersistNodes.cancel();
    if (pendingNodeSave?.projectUuid === project.projectMeta.uuid) {
      pendingNodeSave.resolve?.(false);
      pendingNodeSave = null;
    }
    saveBlockedProjects.delete(project.projectMeta.uuid);
    conflictNotifiedProjects.delete(project.projectMeta.uuid);
    // 刷新/重新载入就是对齐冲突节点的方式，载入后它们不再是冲突态
    conflictedNodesByProject.delete(project.projectMeta.uuid);
    const lastPluginEditAtMs = Number(
      project.projectDraft.lastPluginEditAtMs || 0,
    );
    knownPluginEditAtMsByProject.set(
      project.projectMeta.uuid,
      lastPluginEditAtMs,
    );
    const contentVersion = String(project.projectMeta.contentVersion || "");
    contentVersionByProject.set(project.projectMeta.uuid, contentVersion);
    let nodes: FlowNode[] = project.nodeList.map((cn) => {
      let data: CanvasNodeData;
      try {
        data = JSON.parse(cn.data);
      } catch {
        data = {
          type: "upload",
          name: cn.name,
          url: [],
          action: "image_resource",
        };
      }
      data = normalizeNodeDataForRender(data);
      // Cap image/video node widths so they don't stretch across canvas
      const MAX_W: Partial<Record<string, number>> = { image: 520, video: 520 };
      const storedW = Number(cn.measured?.width ?? 520);
      const cappedW = MAX_W[data.type]
        ? Math.min(storedW, MAX_W[data.type]!)
        : storedW;
      const groupWidth = Number(
        data.contentWidth || cn.measured?.width || cappedW || 520,
      );
      const groupHeight = Number(
        data.contentHeight || cn.measured?.height || 300,
      );
      return {
        id: cn.nodeKey,
        type: data.type,
        position: {
          x: Number(cn.position.positionX),
          y: Number(cn.position.positionY),
        },
        data: { ...data, nodeKey: cn.nodeKey, projectUuid: cn.projectUuid },
        width: cappedW || undefined,
        draggable: true,
        dragHandle: dragHandleForType(data.type),
        selectable: data.type === "group" ? false : true,
        ...(data.type === "group"
          ? {
              style: {
                width: groupWidth,
                height: groupHeight,
                pointerEvents: "auto" as const,
              },
            }
          : {}),
      };
    });

    const { viewportX, viewportY, viewportZoom } = project.projectDraft;
    const canvasTextScale = normalizeCanvasTextScale(
      project.projectDraft.canvasTextScale,
    );
    nodes = expandGroupBoundsForTitles(nodes, viewportZoom);

    const edges = edgesFromNodeReferences(nodes);
    nodeVersionsByProject.set(
      project.projectMeta.uuid,
      new Map(nodes.map((node) => [String(node.data.nodeKey || node.id), Number(node.data._collabVersion || 0)])),
    );
    nodeFingerprintsByProject.set(
      project.projectMeta.uuid,
      new Map(nodes.map((node) => [String(node.data.nodeKey || node.id), nodeFingerprint(node)])),
    );
    // 这一份就是服务端此刻的真相：里面每个节点都是"远端来源"，undo 不许把它们当成
    // 本页新建的去删。整份替换而不是合并——重新加载定义了新的基线。
    remoteOriginNodesByProject.set(
      project.projectMeta.uuid,
      new Set(nodes.map((node) => String(node.data.nodeKey || node.id))),
    );
    // 删除意图不跨加载生效：重新载入后，之前登记的删除一律作废。
    pendingNodeDeletionsByProject.delete(project.projectMeta.uuid);

    const initialSnapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    };
    set({
      projectUuid: project.projectMeta.uuid,
      projectName: project.projectMeta.name,
      collectionId: project.projectMeta.collectionId ?? null,
      collectionName: project.projectMeta.collectionName || "",
      projectOwnerId: project.projectMeta.ownerId ?? null,
      projectOwnerName: project.projectMeta.ownerName ?? "",
      projectShared: Boolean(project.projectMeta.isShared),
      projectIsOwner: Boolean(project.projectMeta.isOwner),
      projectCanManage: Boolean(project.projectMeta.canManage),
      projectCanWrite: Boolean(project.projectMeta.canWrite),
      lastPluginEditAtMs,
      contentVersion,
      nodes,
      edges,
      viewport: {
        x: Number(viewportX),
        y: Number(viewportY),
        zoom: Number(viewportZoom),
      },
      canvasTextScale,
      selectedNodeKeys: [],
      activePanelNodeId: null,
      connectionHoverTargetId: null,
      isDirty: false,
      history: [initialSnapshot],
      historyIndex: 0,
    });
  },

  clearProject: () => {
    const closingProjectUuid = get().projectUuid;
    if (closingProjectUuid) {
      pendingNodeDeletionsByProject.delete(closingProjectUuid);
      remoteOriginNodesByProject.delete(closingProjectUuid);
    }
    nodeSaveVersion += 1;
    debouncedPersistNodes.cancel();
    pendingNodeSave?.resolve?.(false);
    pendingNodeSave = null;
    nodeSaveInFlight = false;
    set({
      projectUuid: null,
      projectName: "未命名画布",
      collectionId: null,
      collectionName: "",
      projectOwnerId: null,
      projectOwnerName: "",
      projectShared: false,
      projectIsOwner: false,
      projectCanManage: false,
      projectCanWrite: false,
      lastPluginEditAtMs: 0,
      contentVersion: "",
      nodes: [],
      edges: [],
      selectedNodeKeys: [],
      activePanelNodeId: null,
      connectionHoverTargetId: null,
      isDirty: false,
      isSaving: false,
      history: [],
      historyIndex: -1,
    });
  },

  syncProject: (project: Project, changedNodeKeys = []) => {
    const current = get();
    if (
      !current.projectUuid ||
      current.projectUuid !== project.projectMeta.uuid
    )
      return;

    const hadLocalNodeChanges = current.isDirty;
    debouncedPersistNodes.cancel();
    pendingNodeSave = null;
    nodeSaveVersion += 1;
    const previousSnapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(current.nodes)),
      edges: JSON.parse(JSON.stringify(current.edges)),
    };
    const nextHistory = [
      ...current.history.slice(0, current.historyIndex + 1),
      previousSnapshot,
    ].slice(-30);

    // loadProject 会清掉删除意图登记表，但同步事件不该让"用户刚删的东西"复活，
    // 所以这里跨过 loadProject 把它带过去。
    const pendingDeletions = pendingNodeDeletionsByProject.get(
      current.projectUuid,
    );
    const trackedVersions = new Map(
      nodeVersionsByProject.get(current.projectUuid) ?? [],
    );
    current.loadProject(project);
    if (pendingDeletions) {
      pendingNodeDeletionsByProject.set(current.projectUuid, pendingDeletions);
    }
    // loadProject 把节点版本表整个重置成刚拉回来那份快照里的 _collabVersion。
    // 但这份快照是服务端在某一刻读到的样子——本页的保存要是还在飞，快照里的版本就比
    // 本页已经写进去的低。基准被按低值重置之后，下一轮保存拿旧版本号去 upsert，服务端
    // 必然 409：2026-08-15 canvas 195 就是这样在打开后 14 秒里自己跟自己撞了 8 个节点，
    // 弹出"有 8 个节点在服务端已更新"，而那 8 个节点全是本页自己写的。
    // 服务端的节点版本只增不减，所以"本地记着的比快照高"只可能是上面这一种情形，取大值。
    const syncedVersions = nodeVersionsByProject.get(current.projectUuid);
    if (syncedVersions) {
      for (const [nodeKey, tracked] of trackedVersions) {
        if (tracked > (syncedVersions.get(nodeKey) ?? 0)) {
          syncedVersions.set(nodeKey, tracked);
        }
      }
    }
    const synced = get();
    const changedKeys = new Set(changedNodeKeys.map(String).filter(Boolean));
    let nextNodes = synced.nodes;
    let nextEdges = synced.edges;
    if (changedKeys.size > 0) {
      const remoteByKey = new Map(
        synced.nodes.flatMap((node) => [
          [node.id, node] as const,
          [node.data.nodeKey, node] as const,
        ]),
      );
      const localKeys = new Set(
        current.nodes.flatMap((node) => [node.id, node.data.nodeKey]),
      );
      nextNodes = current.nodes.map((node) => {
        const key = node.data.nodeKey || node.id;
        return changedKeys.has(key) ? (remoteByKey.get(key) ?? node) : node;
      });
      for (const remoteNode of synced.nodes) {
        const key = remoteNode.data.nodeKey || remoteNode.id;
        // 远端有、本地没有的节点一律补进来，不管它在不在这次事件的 changedNodeKeys 里。
        // 原来只补 changedKeys 命中的，于是本页不认识的远端节点被丢掉，紧接着的自动保存
        // 又把这份缺东西的列表当成真相发上去——canvas 220（n=3→0）和 canvas 238
        // （n=3→2→1→0）两次节点丢失就是这么来的。
        if (!localKeys.has(key) && !pendingDeletions?.has(String(key))) {
          nextNodes.push(remoteNode);
        }
      }
      nextEdges = edgesFromNodeReferences(nextNodes);
    }
    const syncedNodeIds = new Set(
      nextNodes.flatMap((node) => [node.id, node.data.nodeKey]),
    );
    set({
      nodes: nextNodes,
      edges: nextEdges,
      contentVersion: synced.contentVersion,
      viewport: current.viewport,
      canvasTextScale: current.canvasTextScale,
      selectedNodeKeys: current.selectedNodeKeys.filter((nodeId) =>
        syncedNodeIds.has(nodeId),
      ),
      activePanelNodeId:
        current.activePanelNodeId &&
        syncedNodeIds.has(current.activePanelNodeId)
          ? current.activePanelNodeId
          : null,
      connectionHoverTargetId:
        current.connectionHoverTargetId &&
        syncedNodeIds.has(current.connectionHoverTargetId)
          ? current.connectionHoverTargetId
          : null,
      history: nextHistory,
      historyIndex: nextHistory.length - 1,
      isDirty: hadLocalNodeChanges,
    });
    if (hadLocalNodeChanges) {
      schedulePersistNodes(
        current.projectUuid,
        nextNodes,
        set as (s: Partial<CanvasState>) => void,
      );
    }
  },

  applyRemoteNodeEvent: (event) => {
    const current = get();
    if (!current.projectUuid || !event?.nodeKey) return;
    const projectUuid = current.projectUuid;
    const cursor = Number(event.id || 0);
    if (cursor && cursor <= (nodeEventCursorByProject.get(projectUuid) ?? 0)) return;
    if (cursor) nodeEventCursorByProject.set(projectUuid, cursor);
    const versions = nodeVersionsByProject.get(projectUuid) ?? new Map<string, number>();
    const fingerprints = nodeFingerprintsByProject.get(projectUuid) ?? new Map<string, string>();
    nodeVersionsByProject.set(projectUuid, versions);
    nodeFingerprintsByProject.set(projectUuid, fingerprints);
    const nodeKey = String(event.nodeKey);
    if (event.eventType === "delete") {
      versions.delete(nodeKey);
      fingerprints.delete(nodeKey);
      const nodes = current.nodes.filter((node) => String(node.data.nodeKey || node.id) !== nodeKey);
      set({ nodes, edges: edgesFromNodeReferences(nodes) });
      return;
    }
    const incoming = event.node as CanvasNode | undefined;
    if (!incoming) return;
    let data: CanvasNodeData;
    try {
      data = typeof incoming.data === "string" ? JSON.parse(incoming.data) : incoming.data as CanvasNodeData;
    } catch {
      return;
    }
    data = normalizeNodeDataForRender(data);
    const flowNode: FlowNode = {
      id: incoming.nodeKey,
      type: data.type,
      position: { x: Number(incoming.position.positionX), y: Number(incoming.position.positionY) },
      data: { ...data, nodeKey: incoming.nodeKey, projectUuid },
      width: Number(incoming.measured?.width || data.contentWidth || 520),
      draggable: true,
      dragHandle: dragHandleForType(data.type),
      selectable: data.type !== "group",
    };
    const index = current.nodes.findIndex((node) => String(node.data.nodeKey || node.id) === nodeKey);
    const localNode = index >= 0 ? current.nodes[index] : null;
    const baselineFingerprint = fingerprints.get(nodeKey);
    if (localNode && baselineFingerprint && nodeFingerprint(localNode) !== baselineFingerprint) {
      window.dispatchEvent(new CustomEvent(CANVAS_REMOTE_SYNC_REQUIRED_EVENT, {
        detail: { projectUuid, conflict: true, changedNodeKeys: [nodeKey] },
      }));
      return;
    }
    const nodes = index >= 0
      ? current.nodes.map((node, nodeIndex) => nodeIndex === index ? flowNode : node)
      : [...current.nodes, flowNode];
    // 必须用节点数据里的 _collabVersion，不能用 event.nodeVersion：
    // 服务端乐观锁比的就是 _collabVersion（见 nodeEventVersion），而事件表的 node_version
    // 是另算的，两者会错开——生成结果落盘时事件版本走 MAX+1、节点的 _collabVersion 原样不动，
    // 老的整表保存也只把版本写进事件快照、没写回节点。取错字段的后果是：生成完再改那个节点
    // 就会 409，然后整个画布被 saveBlockedProjects 停掉保存，刷新前的改动全丢。
    versions.set(nodeKey, Number(data._collabVersion || 0));
    fingerprints.set(nodeKey, nodeFingerprint(flowNode));
    // 远端推过来的节点不进历史快照，必须记下来源，否则 undo 会把它当成本页新建的删掉
    markNodesRemoteOrigin(projectUuid, [nodeKey]);
    set({ nodes, edges: edgesFromNodeReferences(nodes) });
  },

  setProjectUuid: (uuid) => set({ projectUuid: uuid }),
  setContentVersion: (contentVersion) => {
    const projectUuid = get().projectUuid;
    if (projectUuid) contentVersionByProject.set(projectUuid, String(contentVersion || ""));
    set({ contentVersion: String(contentVersion || "") });
  },
  setNodes: (nodes, options = {}) => {
    const persist = options.persist ?? true;
    const markDirty = options.markDirty ?? persist;
    if (markDirty && !persist) nodeSaveVersion += 1;
    set({ nodes, ...(markDirty ? { isDirty: true } : {}) });
    const { projectUuid } = get();
    if (persist && projectUuid) {
      if (options.immediate)
        persistNodesImmediately(
          projectUuid,
          nodes,
          set as (s: Partial<CanvasState>) => void,
        );
      else
        schedulePersistNodes(
          projectUuid,
          nodes,
          set as (s: Partial<CanvasState>) => void,
        );
    }
  },
  setEdges: (edges) => set({ edges }),
  setViewport: (viewport) => {
    set({ viewport });
    const { projectUuid, canvasTextScale } = get();
    if (projectUuid)
      debouncedPersistViewport(projectUuid, viewport, canvasTextScale);
  },
  setCanvasTextScale: (scale) => {
    const canvasTextScale = normalizeCanvasTextScale(scale);
    set({ canvasTextScale });
    const { projectUuid, viewport } = get();
    if (projectUuid)
      debouncedPersistViewport(projectUuid, viewport, canvasTextScale);
  },
  setSelected: (keys) => set({ selectedNodeKeys: keys }),
  setActivePanelNode: (nodeId) => set({ activePanelNodeId: nodeId }),
  setConnectionHoverTarget: (nodeId) =>
    set({ connectionHoverTargetId: nodeId }),
  setCindyMode: (mode) => set({ cindyMode: mode }),
  setCindyEnabled: (enabled) => set({ cindyEnabled: enabled }),
  // 名单收窄时把当前模式拽回默认 —— 不然会一直往服务端发一个已经没权限的模式，
  // 服务端虽然会静默降级，但 UI 上还显示着「电影大师模式」就是在骗人
  setCindyModes: (modes) =>
    set((state) => ({
      cindyModes: modes,
      cindyMode: modes.includes(state.cindyMode) ? state.cindyMode : "default",
    })),

  addNode: (type: string) => {
    get().pushHistory();
    const { projectUuid, nodes, viewport } = get();
    const nodeKey = uuidv4();
    const name = defaultNodeName(
      type,
      nodes.filter((n) => n.data.type === type).length + 1,
    );
    const data = makeNodeData(type, name);
    // Place near center of viewport
    const x = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
    const y = (-viewport.y + window.innerHeight / 2) / viewport.zoom;
    const measuredWidth =
      type === "panorama_viewer" ? PANORAMA_VIEWER_WIDTH : 620;
    const measuredHeight =
      type === "panorama_viewer" ? PANORAMA_VIEWER_HEIGHT : 350;
    const newNode: FlowNode = {
      id: nodeKey,
      type,
      position: { x, y },
      data: { ...data, nodeKey, projectUuid: projectUuid ?? "" },
      width: type === "panorama_viewer" ? PANORAMA_VIEWER_WIDTH : undefined,
      height: type === "panorama_viewer" ? PANORAMA_VIEWER_HEIGHT : undefined,
      measured: { width: measuredWidth, height: measuredHeight },
      draggable: true,
      dragHandle: dragHandleForType(type),
      selectable: true,
    };
    const updated = [...nodes, newNode];
    // 新节点的 params 里可能已经带着对别的节点的引用（imageList/videoList/… 的 nodeId），
    // 比如「细化纹理」派生出来的图片节点就带着源节点。以前这里只 set nodes、不重算 edges，
    // 那条线当场画不出来、非得刷新一次才冒出来 —— 因为 loadProject 是用
    // edgesFromNodeReferences(nodes) 重建边的：数据一直是对的，只是视图没跟上。
    // 传 get().edges 进去会保留已有的边、只补引用推导出来的那些，不会凭空造边；
    // 这一行只是把当场的视图对齐到「刷新之后本来就会是」的样子。
    set({
      nodes: updated,
      edges: edgesFromNodeReferences(updated, get().edges),
      isDirty: true,
    });
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
    return newNode;
  },

  addNodeAt: (
    type: string,
    x: number,
    y: number,
    extraData?: Partial<CanvasNodeData>,
    options?: AddNodeOptions,
  ) => {
    if (options?.recordHistory !== false) get().pushHistory();
    const { projectUuid, nodes } = get();
    const nodeKey = uuidv4();
    const name = defaultNodeName(
      type,
      nodes.filter((n) => n.data.type === type).length + 1,
    );
    const data = { ...makeNodeData(type, name), ...extraData, nodeKey, projectUuid: projectUuid ?? "" };
    const measuredWidth =
      type === "panorama_viewer"
        ? PANORAMA_VIEWER_WIDTH
        : Number(data.contentWidth) || 620;
    const measuredHeight =
      type === "panorama_viewer"
        ? PANORAMA_VIEWER_HEIGHT
        : Number(data.contentHeight) || 350;
    const newNode: FlowNode = {
      id: nodeKey,
      type,
      position: { x, y },
      data,
      width: type === "panorama_viewer" ? PANORAMA_VIEWER_WIDTH : undefined,
      height: type === "panorama_viewer" ? PANORAMA_VIEWER_HEIGHT : undefined,
      measured: { width: measuredWidth, height: measuredHeight },
      draggable: true,
      dragHandle: dragHandleForType(type),
      selectable: true,
    };
    const updated = [...nodes, newNode];
    // 新节点的 params 里可能已经带着对别的节点的引用（imageList/videoList/… 的 nodeId），
    // 比如「细化纹理」派生出来的图片节点就带着源节点。以前这里只 set nodes、不重算 edges，
    // 那条线当场画不出来、非得刷新一次才冒出来 —— 因为 loadProject 是用
    // edgesFromNodeReferences(nodes) 重建边的：数据一直是对的，只是视图没跟上。
    // 传 get().edges 进去会保留已有的边、只补引用推导出来的那些，不会凭空造边；
    // 这一行只是把当场的视图对齐到「刷新之后本来就会是」的样子。
    set({
      nodes: updated,
      edges: edgesFromNodeReferences(updated, get().edges),
      isDirty: true,
    });
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
    return newNode;
  },

  deleteNodes: (nodeKeys: string[]) => {
    get().pushHistory();
    const { projectUuid, nodes, activePanelNodeId } = get();
    const updated = nodes.filter((n) => !nodeKeys.includes(n.data.nodeKey));
    set({
      nodes: updated,
      activePanelNodeId:
        activePanelNodeId && nodeKeys.includes(activePanelNodeId)
          ? null
          : activePanelNodeId,
      isDirty: true,
    });
    if (projectUuid) {
      markNodesDeletedByUser(
        projectUuid,
        nodes
          .filter((n) => nodeKeys.includes(n.data.nodeKey))
          .map((n) => String(n.data.nodeKey || n.id)),
        updated.length,
      );
      // 删除不走 500ms 防抖：用户点完删除下一秒就可能刷新页面来确认，防抖窗口里被刷掉的
      // 删除意图不会重来一次，节点就"又回来了"。
      persistNodesImmediately(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
    }
  },

  deleteGroupWithChildren: (groupId: string) => {
    get().pushHistory();
    const { projectUuid, nodes, edges, activePanelNodeId, selectedNodeKeys } =
      get();
    const removeIds = expandNodeIdsForGroups([groupId], nodes);
    if (removeIds.size === 0) return;

    const updatedNodes = nodes.filter(
      (node) => !removeIds.has(node.id) && !removeIds.has(node.data.nodeKey),
    );
    const updatedEdges = edges.filter(
      (edge) => !removeIds.has(edge.source) && !removeIds.has(edge.target),
    );
    const nextSelected = selectedNodeKeys.filter((id) => !removeIds.has(id));
    set({
      nodes: updatedNodes,
      edges: updatedEdges,
      selectedNodeKeys: nextSelected,
      activePanelNodeId:
        activePanelNodeId && removeIds.has(activePanelNodeId)
          ? null
          : activePanelNodeId,
      isDirty: true,
    });
    if (projectUuid) {
      markNodesDeletedByUser(
        projectUuid,
        nodes
          .filter(
            (node) =>
              removeIds.has(node.id) || removeIds.has(node.data.nodeKey),
          )
          .map((node) => String(node.data.nodeKey || node.id)),
        updatedNodes.length,
      );
      // 同上：删组连带子节点，也要立刻发，别留防抖窗口给刷新吃掉
      persistNodesImmediately(
        projectUuid,
        updatedNodes,
        set as (s: Partial<CanvasState>) => void,
      );
    }
  },

  updateNodeData: (nodeKey: string, patch: Partial<CanvasNodeData>) => {
    const { nodes, projectUuid } = get();
    const updated = nodes.map((n) => {
      if (n.data.nodeKey !== nodeKey && n.id !== nodeKey) return n;
      const nextType = String(patch.type || n.type || n.data.type);
      return {
        ...n,
        type: nextType,
        dragHandle: dragHandleForType(nextType),
        data: { ...n.data, ...patch },
      };
    });
    set({ nodes: updated, isDirty: true });
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
  },

  // updateNodePosition 已删除（2026-08-16）：全项目零调用方，而且它只改内存不落库——
  // 和 ungroupNodes 那个空 if 是同一个形状，谁哪天顺手用它，拖动位置就静默不保存。
  // 位置变更走 onNodesChange → setNodes（带 persist），不需要这个入口。

  updateNodeSize: (nodeKey: string, w: number, h: number) => {
    const { nodes, projectUuid } = get();
    const updated = nodes.map((n) =>
      n.data.nodeKey === nodeKey || n.id === nodeKey
        ? {
            ...n,
            width: w,
            height: h,
            measured: { width: w, height: h },
            data: { ...n.data, contentWidth: w, contentHeight: h },
          }
        : n,
    );
    set({ nodes: updated, isDirty: true });
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
  },

  persistNodes: async () => {
    const { projectUuid, nodes, isDirty } = get();
    if (!projectUuid || !isDirty) return;
    schedulePersistNodes(
      projectUuid,
      nodes,
      set as (s: Partial<CanvasState>) => void,
    );
  },

  persistNodesAndWait: async () => {
    const { projectUuid, nodes, isDirty } = get();
    if (!projectUuid) return false;
    if (!isDirty) return true;
    return persistNodesAndWait(
      projectUuid,
      nodes,
      set as (s: Partial<CanvasState>) => void,
    );
  },

  persistViewport: async () => {
    const { projectUuid, viewport, canvasTextScale } = get();
    if (!projectUuid) return;
    await debouncedPersistViewport(projectUuid, viewport, canvasTextScale);
  },

  pushHistory: () => {
    const { nodes, edges, history, historyIndex } = get();
    const snapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    };
    // Trim any future history (after undo) and cap at 30 snapshots
    const newHistory = [...history.slice(0, historyIndex + 1), snapshot].slice(
      -30,
    );
    set({ history: newHistory, historyIndex: newHistory.length - 1 });
  },

  undo: () => {
    const { history, historyIndex, projectUuid, nodes } = get();
    if (historyIndex <= 0) return;
    const snapshot = history[historyIndex];
    set({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      historyIndex: historyIndex - 1,
      isDirty: true,
    });
    if (projectUuid) {
      // 撤销掉"本页新建的节点"也是用户意图，要让这些节点真的从服务端消失。
      //
      // 但"现在有、快照里没有"并不等于"本页新建的"：远端推过来的节点（别的客户端 /
      // Cindy 插件，走 applyRemoteNodeEvent）从不进任何历史快照，天然满足这个条件。
      // 原来这里不加区分，于是任何人按一下 Ctrl+Z 就会把别人刚加的节点登记成用户删除、
      // 真的从服务端删掉——而删除护栏挡不住它，因为意图是明确登记过的。这正是
      // canvas 220 / 238 / 115 三次节点丢失的形状，只是触发点换成了撤销。
      // 所以只对确实不是远端来源的节点登记意图；拿不准的一律不登记，最坏后果是
      // "撤销掉的新节点刷新后又回来"，那是良性失败。
      const restoredKeys = new Set(
        snapshot.nodes.map((node) => String(node.data.nodeKey || node.id)),
      );
      const remoteOrigin =
        remoteOriginNodesByProject.get(projectUuid) ?? new Set<string>();
      const vanished = nodes
        .map((node) => String(node.data.nodeKey || node.id))
        .filter((nodeKey) => !restoredKeys.has(nodeKey));
      const createdHere = vanished.filter(
        (nodeKey) => !remoteOrigin.has(nodeKey),
      );
      const skipped = vanished.filter((nodeKey) => remoteOrigin.has(nodeKey));
      if (skipped.length > 0) {
        console.warn(
          `[canvas ${projectUuid}] 撤销跳过了 ${skipped.length} 个远端来源的节点，不删服务端：${skipped.join(", ")}`,
        );
      }
      markNodesDeletedByUser(projectUuid, createdHere, snapshot.nodes.length);
    }
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        snapshot.nodes,
        set as (s: Partial<CanvasState>) => void,
      );
  },

  copySelected: () => {
    const { selectedNodeKeys, nodes, edges } = get();
    if (selectedNodeKeys.length === 0) return;
    const selectedIds = expandNodeIdsForGroups(selectedNodeKeys, nodes);
    const selectedNodes = nodes.filter((n) => selectedIds.has(n.id));
    const selectedEdges = edges.filter(
      (e) => selectedIds.has(e.source) && selectedIds.has(e.target),
    );
    set({
      clipboard: {
        nodes: JSON.parse(JSON.stringify(selectedNodes)),
        edges: JSON.parse(JSON.stringify(selectedEdges)),
      },
    });
  },

  pasteClipboard: (position) => {
    const { clipboard, nodes, edges, projectUuid } = get();
    if (!clipboard || clipboard.nodes.length === 0) return;
    get().pushHistory();

    const idMap: Record<string, string> = Object.fromEntries(
      clipboard.nodes.map((n) => [n.id, uuidv4()]),
    );
    const minX = Math.min(...clipboard.nodes.map((n) => n.position.x));
    const minY = Math.min(...clipboard.nodes.map((n) => n.position.y));
    const dx = position ? position.x - minX : 40;
    const dy = position ? position.y - minY : 40;
    const copiedAtMs = Date.now();
    const newNodes: FlowNode[] = clipboard.nodes.map((n) => {
      const newId = idMap[n.id];
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + dx, y: n.position.y + dy },
        data: copiedNodeData(n.data, newId, idMap, copiedAtMs),
        dragHandle: dragHandleForType(n.data.type),
        selected: false,
      };
    });
    const newEdges: Edge[] = clipboard.edges.map((e) => ({
      ...e,
      id: `e-${idMap[e.source]}-${idMap[e.target]}`,
      source: idMap[e.source],
      target: idMap[e.target],
    }));

    const newNodeIds = new Set(newNodes.map((node) => node.id));
    const updatedNodes = [
      ...nodes.map((node) => ({ ...node, selected: false })),
      ...newNodes.map((node) => ({ ...node, selected: true })),
    ];
    const updatedEdges = edgesFromNodeReferences(updatedNodes, [
      ...edges,
      ...newEdges,
    ]);
    set({
      nodes: updatedNodes,
      edges: updatedEdges,
      selectedNodeKeys: [...newNodeIds],
      activePanelNodeId: newNodes.length === 1 ? newNodes[0].id : null,
      isDirty: true,
    });
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        updatedNodes,
        set as (s: Partial<CanvasState>) => void,
      );
  },

  groupNodes: (nodeIds: string[]) => {
    get().pushHistory();
    const { projectUuid, nodes } = get();
    if (nodeIds.length === 0) return;
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const groupIdsToRemove = new Set<string>();
    const childIds = new Set<string>();

    const collectNode = (nodeId: string) => {
      const node = nodeMap.get(nodeId);
      if (!node) return;
      if (node.type === "group") {
        groupIdsToRemove.add(node.id);
        const params = (node.data.params ?? {}) as { childIds?: string[] };
        (params.childIds ?? []).forEach(collectNode);
        return;
      }
      childIds.add(node.id);
    };

    nodeIds.forEach(collectNode);
    const targetIds = Array.from(childIds);
    const targets = targetIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is FlowNode => Boolean(node));
    if (targets.length === 0) return;

    const bounds = groupBoundsForTargets(targets, get().viewport.zoom);
    const gx = bounds.x,
      gy = bounds.y;
    const gw = bounds.width,
      gh = bounds.height;
    const nodeKey = uuidv4();
    const groupCount = targets.length;
    const name = `\u5206\u7ec4${groupCount}\u4e2a\u8282\u70b9`;
    const groupNode: FlowNode = {
      id: nodeKey,
      type: "group",
      position: { x: gx, y: gy },
      data: {
        type: "group",
        name,
        url: [],
        action: "image_resource",
        params: { childIds: targetIds, color: "#252525" } as unknown as Record<
          string,
          unknown
        >,
        nodeKey,
        projectUuid: projectUuid ?? "",
        contentWidth: gw,
        contentHeight: gh,
      },
      draggable: true,
      selectable: false,
      dragHandle: dragHandleForType("group"),
      style: { width: gw, height: gh, pointerEvents: "auto" },
    };
    // Group node goes first so it renders below children. After grouping,
    // select only the group so the multi-select toolbar is replaced by the group toolbar.
    const nodesWithoutOldGroups = nodes.filter(
      (node) => !groupIdsToRemove.has(node.id),
    );
    const updated = [groupNode, ...nodesWithoutOldGroups].map((node) => ({
      ...node,
      selected: false,
    }));
    set({
      nodes: updated,
      selectedNodeKeys: [nodeKey],
      activePanelNodeId: nodeKey,
      isDirty: true,
    });
    if (projectUuid) {
      if (groupIdsToRemove.size > 0) {
        // 成组会吃掉旧的分组节点：这是用户操作，登记成显式删除意图，
        // 否则自动保存那一轮会把它们当成"来路不明的消失"而跳过。
        markNodesDeletedByUser(
          projectUuid,
          Array.from(groupIdsToRemove).map(String),
          updated.length,
        );
        nodesApi
          .delete(
            projectUuid,
            Array.from(groupIdsToRemove),
            contentVersionByProject.get(projectUuid) ?? "",
            CANVAS_CLIENT_ID,
          )
          .then((response) => {
            if (response.data?.contentVersion) {
              const contentVersion = String(response.data.contentVersion);
              contentVersionByProject.set(projectUuid, contentVersion);
              set({ contentVersion });
            }
          })
          .catch(console.error);
      }
      schedulePersistNodes(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
    }
  },

  ungroupNodes: (groupId: string) => {
    get().pushHistory();
    const { projectUuid, nodes } = get();
    const target = nodes.find(
      (n) => n.id === groupId || n.data.nodeKey === groupId,
    );
    const updated = nodes.filter((n) => n !== target);
    set({ nodes: updated, isDirty: true });
    // 解组 = 删掉组框、子节点留下。这一步以前只改本地状态就完了：
    // 08-13 的版本这里调的是 nodesApi.delete，某次改动把调用去掉、只剩一个空的
    // if (projectUuid) {}，于是解组只在屏幕上生效、从不落库——组框刷新后原样回来，
    // 而组工具栏上唯一能拿掉组的按钮就是它。2026-08-15 canvas 216 的空组就是这么来的。
    if (projectUuid && target) {
      markNodesDeletedByUser(
        projectUuid,
        [String(target.data.nodeKey || target.id)],
        updated.length,
      );
      persistNodesImmediately(
        projectUuid,
        updated,
        set as (s: Partial<CanvasState>) => void,
      );
    }
  },

  duplicateNodes: (nodeIds: string[]) => {
    get().pushHistory();
    const { projectUuid, nodes, edges } = get();
    const targetIds = expandNodeIdsForGroups(nodeIds, nodes);
    const targets = nodes.filter((n) => targetIds.has(n.id));
    if (targets.length === 0) return;

    const idMap: Record<string, string> = Object.fromEntries(
      targets.map((n) => [n.id, uuidv4()]),
    );
    const copiedAtMs = Date.now();
    const newNodes: FlowNode[] = targets.map((n) => {
      const newId = idMap[n.id];
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        data: copiedNodeData(n.data, newId, idMap, copiedAtMs),
        dragHandle: dragHandleForType(n.data.type),
        selected: false,
      };
    });

    // Clone edges between duplicated nodes
    const newEdges: Edge[] = edges
      .filter((e) => targetIds.has(e.source) && targetIds.has(e.target))
      .map((e) => ({
        ...e,
        id: `e-${idMap[e.source]}-${idMap[e.target]}`,
        source: idMap[e.source],
        target: idMap[e.target],
      }));

    const updatedNodes = [...nodes, ...newNodes];
    const updatedEdges = edgesFromNodeReferences(updatedNodes, [
      ...edges,
      ...newEdges,
    ]);
    set({ nodes: updatedNodes, edges: updatedEdges, isDirty: true });
    if (projectUuid)
      schedulePersistNodes(
        projectUuid,
        updatedNodes,
        set as (s: Partial<CanvasState>) => void,
      );
  },

  insertFavoritePayload: async (payload, position) => {
    const rawNodes = (payload.nodes ?? []) as unknown as FlowNode[];
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) return;
    get().pushHistory();
    const { projectUuid, nodes, edges, viewport } = get();
    const nextProjectUuid = projectUuid ?? "";
    const sourceNodes = rawNodes.filter((node) => node?.id && node?.data);
    if (sourceNodes.length === 0) return;
    const urlMap: Record<string, string> = {};
    if (nextProjectUuid) {
      const foreignUrls = collectLocalAssetUrls(sourceNodes)
        .filter((url) => parseLocalAssetUrl(url)?.projectUuid !== nextProjectUuid);
      for (const sourceUrl of foreignUrls) {
        try {
          const copied = await assetsApi.copyToProject(nextProjectUuid, sourceUrl);
          if (copied?.url) urlMap[sourceUrl] = copied.url;
        } catch (error) {
          console.warn("copy shared asset into current canvas failed:", sourceUrl, error);
        }
      }
    }

    const idMap: Record<string, string> = Object.fromEntries(
      sourceNodes.map((node) => [node.id, uuidv4()]),
    );
    const minX = Math.min(
      ...sourceNodes.map((node) => Number(node.position?.x ?? 0)),
    );
    const minY = Math.min(
      ...sourceNodes.map((node) => Number(node.position?.y ?? 0)),
    );
    const insertPoint = position ?? {
      x: (-viewport.x + window.innerWidth / 2) / viewport.zoom,
      y: (-viewport.y + window.innerHeight / 2) / viewport.zoom,
    };
    const dx = insertPoint.x - minX;
    const dy = insertPoint.y - minY;
    const timestamp = Date.now();

    const newNodes: FlowNode[] = sourceNodes.map((node) => {
      const newId = idMap[node.id];
      const nextType = String(node.type || node.data.type || "image");
      const width = Number(
        node.data.contentWidth ?? node.width ?? node.measured?.width ?? 0,
      );
      const height = Number(
        node.data.contentHeight ?? node.height ?? node.measured?.height ?? 0,
      );
      return {
        ...node,
        id: newId,
        type: nextType,
        position: {
          x: Number(node.position?.x ?? 0) + dx,
          y: Number(node.position?.y ?? 0) + dy,
        },
        data: rewriteLocalAssetUrls(
          favoriteNodeData(
            node.data,
            newId,
            nextProjectUuid,
            idMap,
            timestamp,
          ),
          urlMap,
        ),
        draggable: true,
        selectable: nextType === "group" ? false : true,
        selected: false,
        dragHandle: dragHandleForType(nextType),
        ...(nextType === "group"
          ? {
              style: {
                ...(node.style ?? {}),
                width: width || Number(node.style?.width) || 320,
                height: height || Number(node.style?.height) || 220,
                pointerEvents: "auto" as const,
              },
            }
          : {}),
      };
    });

    const payloadEdges = Array.isArray(payload.edges)
      ? (payload.edges as unknown as Edge[])
      : [];
    const newEdges: Edge[] = payloadEdges
      .filter((edge) => idMap[edge.source] && idMap[edge.target])
      .map((edge) => ({
        ...edge,
        id: `e-${idMap[edge.source]}-${idMap[edge.target]}`,
        source: idMap[edge.source],
        target: idMap[edge.target],
        type: edge.type || "glow",
        selectable: true,
        selected: false,
        interactionWidth: EDGE_INTERACTION_WIDTH,
      }));

    const newNodeIds = new Set(newNodes.map((node) => node.id));
    const updatedNodes = [
      ...nodes.map((node) => ({ ...node, selected: false })),
      ...newNodes.map((node) => ({ ...node, selected: true })),
    ];
    const updatedEdges = edgesFromNodeReferences(updatedNodes, [
      ...edges,
      ...newEdges,
    ]);
    set({
      nodes: updatedNodes,
      edges: updatedEdges,
      selectedNodeKeys: [...newNodeIds],
      activePanelNodeId: newNodes.length === 1 ? newNodes[0].id : null,
      isDirty: true,
    });
    if (projectUuid)
      persistNodesImmediately(
        projectUuid,
        updatedNodes,
        set as (s: Partial<CanvasState>) => void,
      );
  },
}));
