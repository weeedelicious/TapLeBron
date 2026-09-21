import axios from "axios";
import type {
  StudioBoardItem,
  StudioVideoItem,
  StudioVideoSettings,
  StudioVideoStage,
  StudioVideoStageData,
  StudioBoardSettings,
  StudioBoards,
  StudioConceptItem,
  StudioConcepts,
  StudioStoryboardRow,
} from "@/lib/studio";
import type {
  Project,
  ProjectGroups,
  CanvasNode,
  ProjectDraft,
  CanvasCollection,
  FavoriteLibraryCreatePayload,
  FavoriteLibraryItem,
} from "./types";
import { errorToText } from "./display";
import { prepareAssetForUpload } from "./uploadPrep";

const http = axios.create({ baseURL: "/api" });
const pendingGenerationErrorKey = "shotflow.pending-generation-errors.v1";

/** Add the exclusive canvas-session token to upload calls as a fallback for Cindy preview pages. */
function canvasSessionHeaders(projectUuid: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.sessionStorage.getItem("shotflow.canvas-session.v1:" + projectUuid) || "";
  return token ? { "X-Shotflow-Canvas-Session": token } : {};
}

type GenerationErrorReport = {
  clientRequestId: string;
  taskId?: string;
  projectUuid?: string;
  nodeKey?: string;
  operationType?: string;
  endpoint?: string;
  model?: string;
  mode?: string;
  ratio?: string;
  resolution?: string;
  durationSec?: number;
  quantity?: number;
  httpStatus?: number;
  errorMessage: string;
  params?: Record<string, unknown>;
};

type FavoriteLibraryListResponse = {
  items: FavoriteLibraryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function generationRequestId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function readPendingGenerationErrors(): GenerationErrorReport[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(pendingGenerationErrorKey) || "[]",
    );
    return Array.isArray(value) ? value.slice(-100) : [];
  } catch {
    return [];
  }
}

function writePendingGenerationErrors(items: GenerationErrorReport[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    pendingGenerationErrorKey,
    JSON.stringify(items.slice(-100)),
  );
}

function queueGenerationError(
  report: Omit<GenerationErrorReport, "clientRequestId"> & {
    clientRequestId?: string;
  },
) {
  const item = {
    ...report,
    clientRequestId: report.clientRequestId || generationRequestId(),
  };
  const current = readPendingGenerationErrors().filter(
    (entry) => entry.clientRequestId !== item.clientRequestId,
  );
  writePendingGenerationErrors([...current, item]);
  return item;
}

let flushingGenerationErrors = false;
async function flushPendingGenerationErrors() {
  if (typeof window === "undefined" || flushingGenerationErrors) return;
  const pending = readPendingGenerationErrors();
  if (!pending.length) return;
  flushingGenerationErrors = true;
  const remaining: GenerationErrorReport[] = [];
  for (const report of pending) {
    try {
      const response = await fetch("/api/generation-errors/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(report),
      });
      if (!response.ok) remaining.push(report);
    } catch {
      remaining.push(report);
    }
  }
  writePendingGenerationErrors(remaining);
  flushingGenerationErrors = false;
}

if (typeof window !== "undefined") {
  window.setTimeout(() => void flushPendingGenerationErrors(), 1500);
  window.addEventListener("online", () => void flushPendingGenerationErrors());
}

function generationEndpoint(url: unknown) {
  const path = String(url || "");
  return (
    path.startsWith("/generate/") ||
    path.startsWith("/toolbox/") ||
    path.startsWith("/light-stage/") ||
    path.startsWith("/subject-matting/")
  );
}

function requestBody(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

// 会话头由 public/canvas-exclusive-session-*.js 在网络层统一注入，覆盖 fetch /
// XMLHttpRequest / EventSource。不要在这里再加一遍：axios 拦截器覆盖不到源码里那些
// 直接用原生 fetch 的调用，两套并存还会互相顶掉会话。
http.interceptors.request.use((config) => {
  if (!generationEndpoint(config.url)) return config;
  const body = requestBody(config.data);
  const clientRequestId = String(body.clientRequestId || generationRequestId());
  config.data = { ...body, clientRequestId };
  return config;
});

http.interceptors.response.use(
  (response) => {
    void flushPendingGenerationErrors();
    return response;
  },
  (error) => {
    const config = error?.config;
    if (config && generationEndpoint(config.url)) {
      const body = requestBody(config.data);
      const params = requestBody(body.params);
      const responseData = error?.response?.data;
      const normalizedErrorMessage = errorToText(
        responseData?.error ?? responseData?.message ?? error,
        "生成请求失败",
      );
      const errorMessage = String(
        normalizedErrorMessage ||
          responseData?.error ||
          responseData?.message ||
          error?.message ||
          "生成请求失败",
      );
      queueGenerationError({
        clientRequestId: String(body.clientRequestId || generationRequestId()),
        projectUuid: String(body.projectUuid || ""),
        nodeKey: String(body.nodeKey || ""),
        operationType: String(config.url || "").includes("video")
          ? "video"
          : String(config.url || "").includes("image") ||
              String(config.url || "").includes("light-stage")
            ? "image"
            : "text",
        endpoint: String(config.url || ""),
        model: String(params.model || ""),
        mode: String(params.mode || params.modeType || ""),
        ratio: String(params.ratio || ""),
        resolution: String(params.resolution || params.quality || ""),
        durationSec: Number(params.duration || 0) || 0,
        quantity: Number(params.count || 1) || 1,
        httpStatus: Number(error?.response?.status || 0) || undefined,
        errorMessage,
        params,
      });
      window.setTimeout(() => void flushPendingGenerationErrors(), 1500);
    }
    return Promise.reject(error);
  },
);

export interface ActivityLogEntry {
  id: string;
  content: string;
  authorId: number;
  authorName: string;
  createdAtMs: number;
  createdAt: string;
  dateKey: string;
  updatedAtMs?: number;
  updatedAt?: string;
  updatedById?: number;
  updatedByName?: string;
}

export interface PluginTokenRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  active: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}

export interface CanvasShareUser {
  id: string;
  username: string;
  role: "user" | "admin";
}

export interface CanvasUserSharesResponse {
  users: CanvasShareUser[];
  sharedUserIds: string[];
}

export type OfficialTemplateCategory = "image" | "video" | "3d";

export interface OfficialTemplateItem {
  id: string;
  category: OfficialTemplateCategory;
  categories: OfficialTemplateCategory[];
  title: string;
  subtitle: string;
  thumbnailUrl: string;
  method: string;
  canvasId: string;
  tone: string;
  nodes: Array<{ type: string; label: string }>;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export const officialTemplatesApi = {
  list: () =>
    http
      .get<{ items: OfficialTemplateItem[]; canEdit: boolean }>("/official-templates")
      .then((response) => response.data),
  source: (id: string) =>
    http
      .get<Project>(`/official-templates/${encodeURIComponent(id)}/source`)
      .then((response) => response.data),
  create: (item: Omit<OfficialTemplateItem, "id" | "canvasId" | "createdAtMs" | "updatedAtMs">) =>
    http
      .post<{ item: OfficialTemplateItem }>("/official-templates", item)
      .then((response) => response.data.item),
  update: (id: string, item: Partial<OfficialTemplateItem>) =>
    http
      .patch<{ item: OfficialTemplateItem }>(`/official-templates/${encodeURIComponent(id)}`, item)
      .then((response) => response.data.item),
};

export const projectsApi = {
  /**
   * 画布管理页的列表。
   *
   * skipGroups 传哪一组，服务端就不去查那一组（返回空数组）：管理页右栏「官方画布模板」
   * 「画布模版」「共享画布」默认收起，收起时不该为它们付一次查询 + 每行一次建目录的代价。
   * 不传就是全返回，跟以前一字不差。
   */
  list: (
    ownerId?: string | null,
    skipGroups?: Array<"officialTemplates" | "templates" | "shared" | "personalShared">,
  ) =>
    http
      .get<ProjectGroups>("/projects", {
        params: {
          ...(ownerId ? { ownerId } : {}),
          ...(skipGroups && skipGroups.length ? { skip: skipGroups.join(",") } : {}),
        },
      })
      .then((r) => r.data),
  get: (uuid: string) =>
    http.get<Project>(`/projects/${uuid}`).then((r) => r.data),
  getRealtime: (uuid: string) =>
    http
      .get<Project>(`/projects/${uuid}`, { params: { realtime: 1 } })
      .then((r) => r.data),
  create: (
    name: string,
    collectionId?: string | null,
    assignedProjectId?: string | null,
  ) =>
    http
      .post<Project>("/projects", {
        name,
        collectionId: collectionId ?? null,
        projectId: assignedProjectId ?? null,
      })
      .then((r) => r.data),
  duplicate: (uuid: string, name?: string) =>
    http
      .post<Project>(`/projects/${uuid}/duplicate`, { name })
      .then((r) => r.data),
  createTemplate: (uuid: string, name?: string) =>
    http
      .post<Project>(`/projects/${uuid}/template`, { name })
      .then((r) => r.data),
  rename: (uuid: string, name: string) =>
    http.patch(`/projects/${uuid}`, { name }).then((r) => r.data),
  moveToCollection: (uuid: string, collectionId: string | null) =>
    http
      .patch<Project>(`/projects/${uuid}/collection`, { collectionId })
      .then((r) => r.data),
  assignProject: (uuid: string, assignedProjectId: string | null) =>
    http
      .patch<Project>(`/projects/${uuid}/project`, {
        projectId: assignedProjectId,
      })
      .then((r) => r.data),
  setShared: (uuid: string, shared: boolean) =>
    http
      .patch<Project>(`/projects/${uuid}/share`, { shared })
      .then((r) => r.data),
  getUserShares: (uuid: string) =>
    http
      .get<CanvasUserSharesResponse>(`/projects/${uuid}/user-shares`)
      .then((r) => r.data),
  updateUserShares: (uuid: string, userIds: string[]) =>
    http
      .put<CanvasUserSharesResponse>(`/projects/${uuid}/user-shares`, {
        userIds,
      })
      .then((r) => r.data),
  delete: (uuid: string) => http.delete(`/projects/${uuid}`),
  saveDraft: (uuid: string, draft: Partial<ProjectDraft>) =>
    http.patch(`/projects/${uuid}/draft`, draft),
};

export const collectionsApi = {
  create: (name: string) =>
    http
      .post<{ collection: CanvasCollection }>("/canvas-collections", { name })
      .then((r) => r.data),
  rename: (id: string, name: string) =>
    http
      .patch<{ collection: CanvasCollection }>(`/canvas-collections/${id}`, {
        name,
      })
      .then((r) => r.data),
  delete: (id: string) => http.delete(`/canvas-collections/${id}`),
};

export interface CanvasNodeEvent {
  id: number;
  nodeKey: string;
  nodeVersion: number;
  eventType: "upsert" | "delete";
  node?: CanvasNode | Record<string, unknown> | null;
  clientId?: string;
  updatedBy?: number | null;
  createdAt?: string;
}

export const nodesApi = {
  batchSave: (
    projectUuid: string,
    nodes: CanvasNode[],
    clientSaveAtMs?: number,
    knownPluginEditAtMs?: number,
    baseContentVersion?: string,
    clientId?: string,
    changedNodeKeys?: string[],
    clientVersion?: string,
  ) =>
    http.post(
      `/projects/${projectUuid}/nodes/batch`,
      {
        nodes,
        clientSaveAtMs,
        knownPluginEditAtMs,
        baseContentVersion,
        clientId,
        changedNodeKeys,
        clientVersion,
      },
      { timeout: 60_000 },
    ),
  delete: (
    projectUuid: string,
    nodeKeys: string[],
    baseContentVersion?: string,
    clientId?: string,
  ) =>
    http.post(`/projects/${projectUuid}/nodes/delete`, {
      nodeKeys,
      baseContentVersion,
      clientId,
    }),
  upsert: (projectUuid: string, node: CanvasNode, expectedVersion = 0, clientId = "") =>
    http.post<{ ok: boolean; node: CanvasNode; nodeVersion: number; contentVersion?: string; eventId?: number }>(
      `/projects/${projectUuid}/nodes/upsert`,
      { node, expectedVersion, clientId },
    ).then((r) => r.data),
  // 服务端要求显式声明"这是人点的删除"：从本地状态推断出来的节点消失不许删服务端数据，
  // 所以这个函数只应该在用户真的删了东西时被调用。
  deleteNode: (
    projectUuid: string,
    nodeKey: string,
    expectedVersion = 0,
    clientId = "",
    options: { bulkDeleteConfirmed?: boolean; allowClearCanvas?: boolean } = {},
  ) =>
    http.post<{ ok: boolean; deleted: boolean; nodeVersion?: number; contentVersion?: string; eventId?: number }>(
      `/projects/${projectUuid}/nodes/delete-v2`,
      {
        nodeKey,
        expectedVersion,
        clientId,
        intent: "user_delete",
        bulkDeleteConfirmed: options.bulkDeleteConfirmed === true,
        allowClearCanvas: options.allowClearCanvas === true,
      },
    ).then((r) => r.data),
  events: (projectUuid: string, afterId = 0) =>
    http.get<{ events: CanvasNodeEvent[] }>(`/projects/${projectUuid}/node-events`, { params: { afterId } }).then((r) => r.data.events ?? []),
};

export interface ActiveGenerationTask {
  jobId: string;
  projectUuid?: string | null;
  nodeKey: string;
  taskType: "image" | "video" | "text" | string;
  status: number;
  progressPercent: number;
  urls?: string[];
  error?: string;
  providerStatus?: Record<string, unknown> | null;
  meta?: {
    model?: string;
    resolution?: string;
    durationSec?: number;
    quantity?: number;
    generationVersion?: number;
    outputs?: Array<{
      index: number;
      url: string;
      assetId?: number | null;
      mimeType?: string;
      width?: number;
      height?: number;
      durationSec?: number;
      model?: string;
      resolution?: string;
      isPrimary?: boolean;
      metadata?: Record<string, unknown> | null;
    }>;
    createdAt?: string;
    updatedAt?: string;
    [key: string]: unknown;
  };
}

export const generateApi = {
  image: (
    projectUuid: string,
    nodeKey: string,
    params: Record<string, unknown>,
  ) =>
    http
      .post<{ jobId: string; generationVersion?: number }>("/generate/image", {
        projectUuid,
        nodeKey,
        params,
      })
      .then((r) => r.data),
  video: (
    projectUuid: string,
    nodeKey: string,
    params: Record<string, unknown>,
  ) =>
    http
      .post<{ jobId: string; generationVersion?: number }>("/generate/video", {
        projectUuid,
        nodeKey,
        params,
      })
      .then((r) => r.data),
  videoMerge: async (
    projectUuid: string,
    nodeKey: string,
    params: Record<string, unknown>,
  ) => {
    const body = { projectUuid, nodeKey, params };
    try {
      const r = await http.post<{ jobId: string; generationVersion?: number }>(
        "/render/video-merge",
        body,
      );
      return r.data;
    } catch (err) {
      // Backends that predate the dedicated merge route handle video_merge inside
      // /generate/image (params.action === 'video_merge'). Fall back to it only
      // when /render/video-merge is genuinely unrouted — a bare Express 404 whose
      // body is not a structured { error } — so real app 404s / merge errors from
      // a deployed route still surface instead of being silently retried.
      const resp = (err as { response?: { status?: number; data?: unknown } })
        ?.response;
      const routeMissing =
        resp?.status === 404 &&
        !(
          resp.data &&
          typeof resp.data === "object" &&
          "error" in (resp.data as Record<string, unknown>)
        );
      if (!routeMissing) throw err;
      const r = await http.post<{ jobId: string; generationVersion?: number }>(
        "/generate/image",
        body,
      );
      return r.data;
    }
  },
  audio: (
    projectUuid: string,
    nodeKey: string,
    params: Record<string, unknown>,
  ) =>
    http
      .post<{ jobId: string }>("/generate/audio", {
        projectUuid,
        nodeKey,
        params,
      })
      .then((r) => r.data),
  script: (
    projectUuid: string,
    nodeKey: string,
    params: Record<string, unknown>,
  ) =>
    http
      .post<{ text: string; taskId?: string; generationVersion?: number }>(
        "/generate/script",
        { projectUuid, nodeKey, params },
      )
      .then((r) => r.data),
  translate: (text: string) =>
    http
      .post<{ translated?: string; text?: string }>("/generate/translate", {
        text,
      })
      .then((r) => ({
        translated: r.data.translated ?? r.data.text ?? "",
      })),
  poll: (jobId: string) =>
    http
      .get<{
        status: number;
        progressPercent: number;
        urls?: string[];
        error?: string;
        providerStatus?: {
          previewUrls?: Array<string | null>;
          [key: string]: unknown;
        } | null;
        meta?: {
          model?: string;
          mode?: string;
          resolution?: string;
          generationVersion?: number;
          applyStatus?:
            "legacy" | "pending" | "applied" | "superseded" | "orphaned";
          supersededByJobId?: string;
          shouldApply?: boolean;
          outputs?: Array<{
            index: number;
            url: string;
            assetId?: number | null;
            mimeType?: string;
            width?: number;
            height?: number;
            durationSec?: number;
            model?: string;
            resolution?: string;
            isPrimary?: boolean;
            metadata?: Record<string, unknown> | null;
          }>;
          createdAt?: string;
          updatedAt?: string;
        };
      }>(`/tasks/${jobId}`)
      .then((r) => r.data),
  apply: (jobId: string, outputs: Array<Record<string, unknown>> = []) =>
    http
      .post<{
        generationVersion?: number;
        applyStatus?: string;
        shouldApply?: boolean;
      }>(`/tasks/${jobId}/apply`, { outputs })
      .then((r) => r.data),
  orphan: (jobId: string) =>
    http.post<{ ok: boolean }>(`/tasks/${jobId}/orphan`).then((r) => r.data),
  cancel: (jobId: string) =>
    http.post<{ ok: boolean }>(`/tasks/${jobId}/cancel`).then((r) => r.data),
  activeTasks: (projectUuid: string) =>
    http
      .get<{ tasks: ActiveGenerationTask[] }>(
        `/projects/${projectUuid}/tasks/active`,
      )
      .then((r) => r.data.tasks ?? []),
  recoverableTasks: (projectUuid: string) =>
    http
      .get<{ tasks: ActiveGenerationTask[] }>(
        `/projects/${projectUuid}/tasks/recoverable`,
      )
      .then((r) => r.data.tasks ?? []),
  recover: (projectUuid: string, jobId: string) =>
    http
      .post<{ ok: boolean; contentVersion?: string; nodeKey?: string; urls?: string[] }>(
        `/projects/${projectUuid}/tasks/${jobId}/recover`,
      )
      .then((r) => r.data),
  reportError: (
    report: Omit<GenerationErrorReport, "clientRequestId"> & {
      clientRequestId?: string;
    },
  ) => {
    const queued = queueGenerationError(report);
    void flushPendingGenerationErrors();
    return queued;
  },
  requestId: generationRequestId,
};

export const lightStageApi = {
  prepareGeometry: (projectUuid: string, nodeKey: string, sourceUrl: string) =>
    http
      .post<{
        geometry: {
          provider: "moge-2-vitb-normal" | "local-2.5d";
          modelId: string;
          status: "ready" | "fallback";
          diffuseUrl?: string;
          normalUrl?: string;
          depthUrl?: string;
          maskUrl?: string;
          pointMapUrl?: string;
          previewUrl?: string;
          manifestUrl?: string;
          width?: number;
          height?: number;
          fov?: number;
          intrinsics?: number[];
          assetVersion?: number;
          normalConvention?: "opengl-object";
          generatedAtMs?: number;
          error?: string;
        };
      }>("/light-stage/geometry", { projectUuid, nodeKey, sourceUrl })
      .then((r) => r.data),
  prepareMask: (
    projectUuid: string,
    nodeKey: string,
    normalUrl: string,
    state: unknown,
  ) =>
    http
      .post<{ maskUrl: string }>("/light-stage/mask", {
        projectUuid,
        nodeKey,
        normalUrl,
        state,
      })
      .then((r) => r.data),
};

export interface SubjectMattingAutomaticMask {
  provider: string;
  modelId: string;
  modelRevision?: string | null;
  status: "ready" | "fallback";
  width: number;
  height: number;
  maskCoverage?: number | null;
  maskBorderCoverage?: number | null;
  maskTouchedEdges?: number | null;
  maskReliable?: boolean | null;
  sha1?: string;
  maskDataUrl: string;
  warning?: string;
}

export interface SubjectMattingCorrectionMask {
  provider: string;
  modelId: string;
  modelRevision?: string | null;
  status: "ready";
  width: number;
  height: number;
  maskCoverage?: number | null;
  sha1?: string;
  maskDataUrl: string;
  taskVersion: number;
  warning?: string;
}

export const subjectMattingApi = {
  prepareAutomaticMask: (
    projectUuid: string,
    nodeKey: string,
    sourceUrl: string,
  ) =>
    http
      .post<{ mask: SubjectMattingAutomaticMask }>(
        "/subject-matting/automatic",
        {
          projectUuid,
          nodeKey,
          sourceUrl,
        },
      )
      .then((r) => r.data.mask),
  correctMask: (
    projectUuid: string,
    nodeKey: string,
    sourceUrl: string,
    request: {
      taskVersion: number;
      intent: "keep" | "exclude";
      promptType: "point" | "box";
      point?: { x: number; y: number };
      box?: { x: number; y: number; width: number; height: number };
    },
  ) =>
    http
      .post<{ mask: SubjectMattingCorrectionMask }>(
        "/subject-matting/correction",
        {
          projectUuid,
          nodeKey,
          sourceUrl,
          ...request,
        },
      )
      .then((r) => r.data.mask),
};

export const toolboxApi = {
  superResolution: (projectUuid: string, nodeKey: string, imageUrl: string) =>
    http
      .post<{ jobId: string }>("/toolbox/super-resolution", {
        projectUuid,
        nodeKey,
        imageUrl,
      })
      .then((r) => r.data),
  panorama: (
    projectUuid: string,
    nodeKey: string,
    imageUrl: string,
    options: {
      model: string;
      resolution: string;
      generationMode: string;
      description?: string;
      sourceName?: string;
    },
  ) =>
    http
      .post<{ jobId: string; generationVersion?: number }>(
        "/toolbox/panorama",
        {
          projectUuid,
          nodeKey,
          imageUrl,
          ...options,
        },
      )
      .then((r) => r.data),
  multiAngle: (projectUuid: string, nodeKey: string, imageUrl: string) =>
    http
      .post<{ jobId: string }>("/toolbox/multi-angle", {
        projectUuid,
        nodeKey,
        imageUrl,
      })
      .then((r) => r.data),
  grid: (
    projectUuid: string,
    nodeKey: string,
    imageUrl: string,
    cols: number,
  ) =>
    http
      .post<{ jobId: string }>("/toolbox/grid", {
        projectUuid,
        nodeKey,
        imageUrl,
        cols,
      })
      .then((r) => r.data),
  splitGrid: (
    projectUuid: string,
    nodeKey: string,
    imageUrl: string,
    cols: number,
    rows: number,
  ) =>
    http
      .post<{ nodeKeys: string[] }>("/toolbox/split-grid", {
        projectUuid,
        nodeKey,
        imageUrl,
        cols,
        rows,
      })
      .then((r) => r.data),
  videoTrim: (
    projectUuid: string,
    nodeKey: string,
    sourceUrl: string,
    startSec: number,
    endSec: number,
  ) =>
    http
      .post<{ url: string; sha1: string; meta: Record<string, unknown> }>(
        "/toolbox/video-trim",
        {
          projectUuid,
          nodeKey,
          sourceUrl,
          startSec,
          endSec,
        },
      )
      .then((r) => r.data),
  videoCrop: (
    projectUuid: string,
    nodeKey: string,
    sourceUrl: string,
    crop: { x: number; y: number; width: number; height: number },
  ) =>
    http
      .post<{ url: string; sha1: string; meta: Record<string, unknown> }>(
        "/toolbox/video-crop",
        {
          projectUuid,
          nodeKey,
          sourceUrl,
          crop,
        },
      )
      .then((r) => r.data),
  videoFrameInterpolation: (
    projectUuid: string,
    nodeKey: string,
    sourceUrl: string,
    targetFps: number,
    method: 'quality' | 'openflowframes' | 'video2x',
    sourceNodeKey?: string,
  ) =>
    http
      .post<{
        jobId: string;
        generationVersion?: number;
        sourceMeta?: Record<string, unknown>;
        targetFps?: number;
        method?: string;
        provider?: string;
        model?: string;
        quality?: Record<string, unknown>;
      }>('/toolbox/video-frame-interpolation', {
        projectUuid,
        nodeKey,
        sourceUrl,
        targetFps,
        method,
        sourceNodeKey,
      })
      .then((r) => r.data),
  mediaEnhance: (
    projectUuid: string,
    nodeKey: string,
    sourceUrl: string,
    mediaType: 'image' | 'video',
    scale: 2 | 4,
    enhanceMode: 'faithful' | 'generative' | 'nvidia-vsr' | 'flashvsr',
    sourceNodeKey?: string,
  ) =>
    http
      .post<{
        jobId: string;
        generationVersion?: number;
        mediaType: 'image' | 'video';
        scale: 2 | 4;
        enhanceMode: 'faithful' | 'generative' | 'nvidia-vsr' | 'flashvsr';
        sourceMeta?: Record<string, unknown>;
        outputMeta?: Record<string, unknown>;
        provider?: string;
        model?: string;
      }>('/toolbox/media-enhance', {
        projectUuid,
        nodeKey,
        sourceUrl,
        mediaType,
        scale,
        enhanceMode,
        sourceNodeKey,
      })
      .then((r) => r.data),
};

export const historyAssetsApi = {
  list: (projectUuid: string) =>
    http.get<{ items: Array<{ id: string; url: string; displayUrl?: string; kind: "image" | "video"; name: string; timestamp: number; sourceType?: string; meta?: Record<string, unknown> }> }>(
      `/projects/${projectUuid}/history-assets`,
    ).then((response) => response.data.items ?? []),
  hide: (projectUuid: string, url: string) =>
    http.post(`/projects/${projectUuid}/history-assets/hide`, { url }).then((response) => response.data),
};

export const assetsApi = {
  importMaxModel: async (
    projectUuid: string,
    file: File,
    onProgress?: (pct: number) => void,
  ) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('projectUuid', projectUuid);
    return http.post<{
      url: string;
      originalName?: string;
      sha1: string;
      meta: Record<string, unknown>;
      model: { url: string; name: string; format: 'fbx' };
      conversionJobId: string;
    }>('/director-stage/import-max', fd, {
      headers: { 'Content-Type': 'multipart/form-data', ...canvasSessionHeaders(projectUuid) },
      timeout: 35 * 60 * 1000,
      onUploadProgress: (e) => { if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100)); },
    }).then((r) => r.data);
  },
  upload: async (
    projectUuid: string,
    file: File,
    onProgress?: (pct: number) => void,
    options?: {
      sourceType?: string;
      normalizeVideoToMp4?: boolean;
    },
  ) => {
    const preparedFile = await prepareAssetForUpload(file);
    const fd = new FormData();
    fd.append("file", preparedFile);
    fd.append("projectUuid", projectUuid);
    if (options?.sourceType) fd.append("sourceType", options.sourceType);
    if (options?.normalizeVideoToMp4) fd.append("normalizeVideoToMp4", "1");
    return http
      .post<{
        url: string;
        thumbUrl?: string;
        displayUrl?: string;
        sha1: string;
        meta: Record<string, unknown>;
      }>("/assets/upload", fd, {
        headers: { "Content-Type": "multipart/form-data", ...canvasSessionHeaders(projectUuid) },
        onUploadProgress: (e) => {
          if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100));
        },
      })
      .then((r) => r.data);
  },
  listProject: (projectUuid: string) =>
    http
      .get<
        {
          url: string;
          name: string;
          mimeType: string;
          sha1: string;
          createdAtMs?: number;
        }[]
      >(`/assets/${projectUuid}`)
      .then((r) => r.data),
  listAll: () =>
    http
      .get<
        {
          url: string;
          name: string;
          mimeType: string;
          sha1: string;
          projectUuid: string;
          createdAtMs?: number;
        }[]
      >("/assets")
      .then((r) => r.data),
  copyToProject: (projectUuid: string, sourceUrl: string) =>
    http
      .post<{ url: string; copied: boolean }>("/assets/copy", {
        projectUuid,
        sourceUrl,
      })
      .then((r) => r.data),
  metadata: (projectUuid: string, sourceUrl: string) =>
    http
      .get<{ meta: Record<string, unknown> }>("/media/metadata", {
        params: { projectUuid, url: sourceUrl },
      })
      .then((r) => r.data),
};

export const logsApi = {
  list: (date?: string) =>
    http
      .get<{ logs: ActivityLogEntry[]; version: string; canAdd: boolean; canEdit?: boolean }>(
        "/logs",
        {
          params: date ? { date } : undefined,
          timeout: 10_000,
        },
      )
      .then((r) => r.data),
  add: (content: string) =>
    http
      .post<{ log: ActivityLogEntry }>("/logs", { content })
      .then((r) => r.data),
  update: (id: string, content: string) =>
    http
      .put<{ log: ActivityLogEntry }>(`/logs/${id}`, { content })
      .then((r) => r.data),
};

export const accountApi = {
  status: () =>
    http.get<{ hasApiKey: boolean }>("/auth/api-key").then((r) => r.data),
  replaceApiKey: (apiKey: string) =>
    http.post<{ ok: true }>("/auth/api-key", { apiKey }).then((r) => r.data),
};

export const pluginTokensApi = {
  list: () =>
    http
      .get<{ tokens: PluginTokenRecord[] }>("/plugin-tokens")
      .then((r) => r.data),
  create: (payload: {
    name: string;
    scopes: string[];
    expiresInDays: number;
  }) =>
    http
      .post<{ token: string; record: PluginTokenRecord }>(
        "/plugin-tokens",
        payload,
      )
      .then((r) => r.data),
  revoke: (id: string) =>
    http.delete(`/plugin-tokens/${id}`).then((r) => r.data),
};

export const favoritesApi = {
  list: (params?: {
    type?: string;
    q?: string;
    page?: number;
    pageSize?: number;
    sortOrder?: string;
  }) =>
    http
      .get<FavoriteLibraryListResponse>("/favorites", { params })
      .then((r) => r.data),
  listShared: (params?: {
    type?: string;
    q?: string;
    page?: number;
    pageSize?: number;
    sortOrder?: string;
  }) =>
    http
      .get<FavoriteLibraryListResponse & { myTotal: number }>(
        "/shared-assets",
        { params },
      )
      .then((r) => r.data),
  get: (id: string) =>
    http
      .get<{ item: FavoriteLibraryItem }>(`/favorites/${id}`)
      .then((r) => r.data),
  getShared: (id: string) =>
    http
      .get<{ item: FavoriteLibraryItem }>(`/shared-assets/${id}`)
      .then((r) => r.data),
  status: (params: { projectUuid: string; rootIds: string[] }) =>
    http
      .get<{ items: FavoriteLibraryItem[] }>("/favorites/status", {
        params: {
          projectUuid: params.projectUuid,
          rootIds: params.rootIds.join("|"),
        },
      })
      .then((r) => r.data),
  sharedStatus: (params: { projectUuid: string; rootIds: string[] }) =>
    http
      .get<{ items: FavoriteLibraryItem[] }>("/shared-assets/status", {
        params: {
          projectUuid: params.projectUuid,
          rootIds: params.rootIds.join("|"),
        },
      })
      .then((r) => r.data),
  create: (payload: FavoriteLibraryCreatePayload) =>
    http
      .post<{ item: FavoriteLibraryItem }>("/favorites", payload)
      .then((r) => r.data),
  createShared: (payload: FavoriteLibraryCreatePayload) =>
    http
      .post<{ item: FavoriteLibraryItem }>("/shared-assets", payload)
      .then((r) => r.data),
  update: (
    id: string,
    patch: Partial<
      Pick<FavoriteLibraryItem, "title" | "description" | "shared" | "tags">
    >,
  ) =>
    http
      .patch<{ item: FavoriteLibraryItem }>(`/favorites/${id}`, patch)
      .then((r) => r.data),
  updateShared: (
    id: string,
    patch: Partial<Pick<FavoriteLibraryItem, "title" | "description" | "tags">>,
  ) =>
    http
      .patch<{ item: FavoriteLibraryItem }>(`/shared-assets/${id}`, patch)
      .then((r) => r.data),
  delete: (id: string) => http.delete(`/favorites/${id}`),
  deleteShared: (id: string) => http.delete(`/shared-assets/${id}`),
};

// ── AI 出片（Studio）────────────────────────────────────────────────────
export interface StudioBrief {
  project: string;
  outline: string;
  styles: string[];
  seconds: number;
  ratio: string;
  /** 出片分辨率（480P / 720P）。老项目的 brief 里没有这个字段，服务端读的时候会补成 720P。 */
  resolution: string;
  references: Array<{ group: string; label: string; url: string }>;
}

export interface StudioProject {
  id: string;
  name: string;
  canvasId: string | null;
  canvasTitle: string | null;
  status: "draft" | "storyboard_ready";
  brief: StudioBrief;
  storyboard: { rows: StudioStoryboardRow[] };
  storyboardNodeKey: string | null;
  /** 概念图清单（第二阶段）。真源在 studio_projects.concepts，画布上的上传节点是投影。 */
  concepts: StudioConcepts;
  /** 分镜画清单（第三阶段）。老项目那一列是 NULL，服务端会补成默认 settings + 空 items。 */
  boards: StudioBoards;
  /** 动态分镜（第四阶段）与成片（第五阶段）。形状一样，服务端一套实现两处用。 */
  motion: StudioVideoStageData;
  film: StudioVideoStageData;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 细化纹理（设计文档里叫「精准修复 · 人物真实化」） */
export interface TextureClarityClassCoverage {
  id: number;
  key: string;
  label: string;
  color: string;
  repairSupport: boolean;
  coverage: number;
}

export interface TextureClarityAssets {
  sourceHash: string;
  assetVersion: number;
  fusionPolicy: string;
  source: {
    url: string;
    status: string;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    scale: number;
  };
  semantic: {
    status: "cached" | "generated" | "fallback" | "failed" | "unavailable";
    reason?: string;
    /** parts = GPU 人体部位分区；subject-silhouette = 本地人物轮廓降级路径。 */
    mode?: "parts" | "subject-silhouette";
    classMapUrl?: string;
    previewUrl?: string;
    modelId?: string;
    modelRevision?: string;
    labelSet?: string;
    elapsedSec?: number;
    classes?: TextureClarityClassCoverage[];
  };
  geometry: {
    status: "cached" | "generated" | "failed" | "unavailable";
    reason?: string;
    provider?: string;
    modelId?: string;
    depthUrl?: string;
    normalUrl?: string;
    assetVersion?: number;
  };
}

export interface TextureClarityFailure {
  code: string;
  message: string;
}

export interface TextureClarityRepair {
  sourceNodeKey: string | null;
  requestModel: string | null;
  resolvedModel: string | null;
  candidateUrl: string;
  fusedUrl: string;
  generationCalls: number;
  generationMs: number;
  fusionMs: number;
  passed: boolean;
  failures: TextureClarityFailure[];
  diagnostics: Record<string, number | string>;
  promptChars: number;
  referenceCount: number;
}

export interface TextureClarityWorkerStatus {
  configured: boolean;
  ok: boolean;
  /** GPU 服务不可用时，服务器能否用本地人物轮廓安全完成融合。 */
  fallbackAvailable?: boolean;
  /** 原始报错，交给 describeServiceError 翻译 */
  reason: string;
}

export interface TextureClarityServiceStatus {
  /** GPU 人体部位分区；不可用时服务器可降级为本地人物轮廓。 */
  semantic: TextureClarityWorkerStatus;
  /** 深度/法线（软依赖：缺了只是少一层约束） */
  geometry: TextureClarityWorkerStatus;
  canRepair: boolean;
  checkedAtMs: number;
}

export const textureClarityApi = {
  /**
   * 依赖服务探活。只打 worker 的 /health，不做推理，正常情况下几毫秒就回来。
   * 超时给 8s：服务器端单个探测 3s，两个并发，留点余量。
   */
  serviceStatus: () =>
    http
      .get<{ textureClarityStatus: TextureClarityServiceStatus }>("/texture-clarity/service-status", {
        timeout: 8_000,
      })
      .then((r) => r.data.textureClarityStatus),
  /**
   * 准备控制素材。一次生图都不调，所以这一步是零生图成本的；
   * 语义分区几秒、深度法线命中缓存时更快，所以给到 180s。
   */
  assets: (payload: { projectUuid: string; nodeKey: string; sourceUrl: string }) =>
    http
      .post<{ textureClarity: TextureClarityAssets }>("/texture-clarity/assets", payload, {
        timeout: 180_000,
      })
      .then((r) => r.data.textureClarity),
  /** 生成修复：一次生图 + 本地融合。生图本身可能几十秒，融合再几秒。 */
  repair: (payload: {
    projectUuid: string;
    nodeKey: string;
    model: string;
    sourceUrl: string;
    classMapUrl: string;
    semanticUrl?: string;
    semanticMode?: "parts" | "subject-silhouette";
    depthUrl?: string;
    normalUrl?: string;
    extraInstruction?: string;
  }) =>
    http
      .post<{ textureClarity: TextureClarityRepair }>("/texture-clarity/repair", payload, {
        timeout: 420_000,
      })
      .then((r) => r.data.textureClarity),
};

export const studioApi = {
  status: () =>
    http.get<{ enabled: boolean }>("/studio/status").then((r) => r.data),
  list: () =>
    http.get<{ projects: StudioProject[] }>("/studio/projects").then((r) => r.data.projects),
  get: (id: string) =>
    http.get<{ project: StudioProject }>(`/studio/projects/${id}`).then((r) => r.data.project),
  create: (payload: { name?: string; brief?: Partial<StudioBrief> }) =>
    http.post<{ project: StudioProject }>("/studio/projects", payload).then((r) => r.data.project),
  update: (
    id: string,
    payload: {
      name?: string;
      brief?: Partial<StudioBrief>;
      storyboard?: { rows: StudioStoryboardRow[] };
      concepts?: { items: StudioConceptItem[] };
    },
  ) =>
    http.patch<{ project: StudioProject }>(`/studio/projects/${id}`, payload).then((r) => r.data.project),
  remove: (id: string) => http.delete(`/studio/projects/${id}`),
  /**
   * 补建画布。幂等 —— 已经有画布就原样返回。
   * 历史上建项目时画布可能没建成（canvas.id 取错层级导致的 NaN bug），
   * 那些项目上传设定图会 409、同步到画布会 502，用这个补回来。
   */
  ensureCanvas: (id: string) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/canvas`, {}, { timeout: 60_000 })
      .then((r) => r.data.project),
  /** 调模型生成文字分镜（可能要几十秒） */
  generateStoryboard: (id: string) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/storyboard`, {}, { timeout: 240_000 })
      .then((r) => r.data.project),
  /** 把当前分镜表同步进画布 */
  pushStoryboard: (id: string) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/storyboard/push`, {})
      .then((r) => r.data.project),
  /** 列概念图清单：只调模型，不生图，零付费成本 */
  planConcepts: (id: string) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/concepts/plan`, {}, { timeout: 240_000 })
      .then((r) => r.data.project),

  // ── 分镜绘制（第三阶段）。跟概念图一样：plan/save 零成本，generate 才花钱 ──
  /** 列分镜画清单。零生图成本，只让模型把分镜表写成提示词。 */
  planBoards: (id: string, payload: { settings: StudioBoardSettings }) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/boards/plan`, payload, { timeout: 300_000 })
      .then((r) => r.data.project),
  /** 只存清单和设置，不生图。 */
  saveBoards: (id: string, payload: { settings: StudioBoardSettings; items: StudioBoardItem[] }) =>
    http
      .patch<{ project: StudioProject }>(`/studio/projects/${id}/boards`, payload)
      .then((r) => r.data.project),
  /**
   * 画分镜画。**付费**：每条一次生图。ids 必须显式传勾选的，
   * 服务端并发 3、一次最多 9 张，所以超时给到 8 分钟。
   */
  generateBoards: (id: string, payload: { ids: string[]; redraw?: boolean }) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/boards/generate`, payload, { timeout: 480_000 })
      .then((r) => r.data.project),
  pushBoards: (id: string) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/boards/push`, {}, { timeout: 120_000 })
      .then((r) => r.data.project),

  // ── 动态分镜（第四）与成片（第五）。同一套接口，stage 取 motion / film ──
  /** 从分镜画列视频清单。零成本。 */
  planVideoStage: (id: string, stage: StudioVideoStage, payload: { settings: StudioVideoSettings }) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/${stage}/plan`, payload, { timeout: 60_000 })
      .then((r) => r.data.project),
  saveVideoStage: (
    id: string,
    stage: StudioVideoStage,
    payload: { settings: StudioVideoSettings; items: StudioVideoItem[] },
  ) =>
    http
      .patch<{ project: StudioProject }>(`/studio/projects/${id}/${stage}`, payload)
      .then((r) => r.data.project),
  /**
   * 提交视频生成。**付费**，但只提交不等结果 —— 一条视频几分钟，
   * 同步等在请求里必被网关掐断。结果靠 pollVideoStage 收。
   */
  generateVideoStage: (id: string, stage: StudioVideoStage, payload: { ids: string[]; redraw?: boolean }) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/${stage}/generate`, payload, { timeout: 120_000 })
      .then((r) => r.data.project),
  /** 收结果。前端在有 running 条目时定时调它。零成本，可以随便调。 */
  pollVideoStage: (id: string, stage: StudioVideoStage) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/${stage}/poll`, {}, { timeout: 120_000 })
      .then((r) => r.data.project),
  pushVideoStage: (id: string, stage: StudioVideoStage) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/${stage}/push`, {}, { timeout: 120_000 })
      .then((r) => r.data.project),
  /**
   * 画概念图。**付费**：每条一次生图。ids 为空时服务端会取全部还没有图的条目，
   * 所以前端一定要显式传勾选的 id。redraw 才会重画已经有图的。
   * 服务端并发 3、一次最多 9 张，最坏三轮，所以超时给到 8 分钟。
   */
  generateConcepts: (id: string, payload: { ids: string[]; redraw?: boolean }) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/concepts/generate`, payload, { timeout: 480_000 })
      .then((r) => r.data.project),
  /** 把已经画好的概念图落成画布上的上传节点（只推还没有节点的那些） */
  pushConcepts: (id: string) =>
    http
      .post<{ project: StudioProject }>(`/studio/projects/${id}/concepts/push`, {}, { timeout: 180_000 })
      .then((r) => r.data.project),
  /**
   * 上传一张设定图 / 参考资料。文件存进这个项目自己的 ai_xxxxxx 画布的资产区。
   * 不能走 assetsApi.upload —— 那个口要画布的独占会话令牌，AI 出片页面从不进画布，
   * 拿不到令牌只会换回 428。
   */
  uploadReference: (
    id: string,
    file: File,
    onProgress?: (pct: number) => void,
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    return http
      .post<{ url: string; rawUrl: string; thumbUrl: string }>(
        `/studio/projects/${id}/references/upload`,
        fd,
        {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 300_000,
          onUploadProgress: (e) => {
            if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100));
          },
        },
      )
      .then((r) => r.data);
  },
};
