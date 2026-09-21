export type NodeType =
  | "text"
  | "image"
  | "video"
  | "video_merge"
  | "director_stage"
  | "audio"
  | "script"
  | "upload"
  | "group"
  | "atmosphere_transfer"
  | "panorama_viewer"
  | "image_compare"
  | "video_compare";

export interface ResourceMeta {
  kind: "image" | "video" | "audio";
  mimeType?: string;
  byteSize?: number;
  displayUrl?: string;
  displayByteSize?: number;
  displayWidth?: number;
  displayHeight?: number;
  displayDurationSec?: number;
  originalUrl?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  hashSha1?: string;
  extension?: string;
  createdAtMs?: number;
  /** 视频媒体探测字段；用于补帧目标帧率和 RV 兼容信息。 */
  fps?: number;
  codecName?: string;
  codecProfile?: string;
  pixelFormat?: string;
  audioCodecName?: string;
  formatName?: string;
}

export interface NodeRef {
  nodeId: string;
  url: string;
  mediaType?: "image" | "video" | "audio";
}

export interface ImageParams {
  prompt: string;
  model: string;
  count: number;
  settings: {
    quality?: string;
    ratio: string;
    resolution?: string;
  };
  advancedSettings?: Record<string, unknown>;
  cameraControl?: {
    enabled: boolean;
    camera?: string;
    lens?: string;
    focal?: string;
    aperture?: string;
  };
  modeType: "text2image" | "image2image";
  promptChips?: { nodeId: string; url: string; name: string }[];
  promptHtml?: string;
  imageList: NodeRef[];
  imageListOrder: string[];
  videoList: NodeRef[];
  audioList: NodeRef[];
  textList: NodeRef[];
}

export interface VideoHistoryItem {
  id: string;
  timestamp: number;
  url: string;
  prompt: string;
  promptHtml?: string;
  promptChips?: { nodeId: string; url: string; name: string }[];
  model: string;
  modeType: string;
  settings: {
    ratio: string;
    resolution: string;
    duration: number;
    enableSound: "on" | "off";
  };
  imageList: NodeRef[];
}

export interface VideoMergeClip {
  id: string;
  nodeId: string;
  url: string;
  name: string;
  startSec: number;
  endSec?: number;
  durationSec?: number;
  volume?: number;
  muted?: boolean;
}

export interface VideoParams {
  prompt: string;
  model: string;
  modeType:
    | "t2v"
    | "i2v"
    | "keyframe"
    | "omni"
    | "video-edit"
    | "extend"
    | "text2video"
    | "image2video"
    | "mixed2video"
    | "first_last_frame"
    | "start-end"
    | "reference"
    | "video_edit";
  count: number;
  imageList: NodeRef[];
  mixedList: NodeRef[];
  mixedListOrder: string[];
  imageListOrder: string[];
  videoList: NodeRef[];
  audioList: NodeRef[];
  textList: NodeRef[];
  settings: {
    ratio: string;
    resolution: string;
    duration: number;
    enableSound: "on" | "off";
  };
  promptChips?: { nodeId: string; url: string; name: string }[];
  promptHtml?: string;
  history?: VideoHistoryItem[];
  mergeClips?: VideoMergeClip[];
  advancedSettings?: Record<string, unknown>;
}

export interface AudioParams {
  prompt?: string;
  model?: string;
  type: "tts" | "music" | "upload";
  voice?: string;
  speed?: number;
}

export interface TextParams {
  content: string; // generated / edited output text
  model: string;
  thinkingMode?: "fast" | "deep";
  performanceMode?: "highest" | "standard";
  reasoningEffort?: "high" | "medium" | "low";
  prompt: string; // user instruction
  imageList: NodeRef[];
  videoList: NodeRef[];
  textList: NodeRef[];
  manualMode?: boolean;
  hasGenerated?: boolean;
  displayStyle?: {
    fontSize?: number;
    lineHeight?: number;
    color?: string;
  };
}

export interface ScriptRow {
  id: string;
  shot: string;
  sceneType: string;
  action: string;
  dialogue: string;
  duration: number;
}

export interface ScriptParams {
  description: string;
  rows: ScriptRow[];
}

export interface TaskInfo {
  taskId: string;
  generationVersion?: number;
  applyStatus?: "legacy" | "pending" | "applied" | "superseded" | "orphaned";
  loading: boolean;
  status: 0 | 1 | 2 | 3; // 0=pending, 1=running, 2=done, 3=failed
  progressPercent: number;
  quantity?: number;
  startedAtMs?: number;
  estimatedMs?: number;
  completedAtMs?: number;
  model?: string;
  taskKind?: "image" | "video" | "video_merge" | "text" | "other";
  /**
   * 当前阶段的名字，进度条优先显示它。给「一个任务分几步跑完」的场合用
   * （细化纹理要先准备控制素材再生成修复），让人知道现在卡在哪一步，而不是只看到「生成中」。
   * 普通单步生成不用设，进度条照旧用调用方传的 label。
   */
  phaseLabel?: string;
  error?: unknown;
}

export interface UploadInfo {
  loading: boolean;
  status: "uploading" | "processing" | "done" | "failed";
  progressPercent: number;
  fileName?: string;
  byteSize?: number;
  error?: unknown;
}

/** 一次失败的生成。留在节点上让人看见"这条没成、为什么"，而不是悄悄消失。 */
export interface FailedGeneration {
  taskId: string;
  error: string;
  createdAtMs: number;
  model?: string;
  resolution?: string;
  ratio?: string;
  durationSec?: number;
  prompt?: string;
}

export interface AssetGenerationMeta {
  model?: string;
  resolution?: string;
  /** 视频才有：提交时的比例 / 时长 / 模式 / 提示词。按产物存，换了设置再生成也能对上是哪一条。 */
  ratio?: string;
  durationSec?: number;
  modeType?: string;
  prompt?: string;
  createdAtMs?: number;
  taskId?: string;
  generationVersion?: number;
  outputIndex?: number;
  /** 派生视频 / 补帧输出的媒体与质量元数据。 */
  fps?: number;
  sourceFps?: number;
  targetFps?: number;
  codecName?: string;
  codecProfile?: string;
  pixelFormat?: string;
  audioCodecName?: string;
  formatName?: string;
  frameInterpolation?: boolean;
  interpolationProvider?: string;
  /** RealSR、NVIDIA RTX 视频超分、SeedVR2 或 FlashVSR 增强产物。 */
  mediaEnhance?: boolean;
  enhanceMode?: "faithful" | "generative" | "nvidia-vsr" | "flashvsr";
  enhanceProvider?: string;
  enhanceModel?: string;
  generativeDetails?: boolean;
  scale?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  frameCount?: number;
  boundaryFramesVerified?: boolean;
  imageTta?: boolean;
  videoTta?: boolean;
  qualityMode?: string;
  crf?: number;
  preset?: string;
  colorCorrection?: string;
  batchSize?: number;
  uniformBatchSize?: boolean;
  temporalOverlap?: number;
  prependFrames?: number;
  seedvr2Commit?: string;
  nvidiaVfxVersion?: string;
  nvidiaVsrQuality?: string;
  contentFramesVerified?: boolean;
}

export interface CanvasNodeData extends Record<string, unknown> {
  type: NodeType;
  name: string;
  url: string[];
  poster?: string;
  action:
    | "image_resource"
    | "image_generate"
    | "video_generate"
    | "audio_generate"
    | "text_node"
    | "script_node"
    | "video_merge"
    | "director_stage"
    | "atmosphere_transfer"
    | "panorama_viewer"
    | "image_compare"
    | "video_compare";
  generatorType?: string;
  params?: Record<string, unknown>;
  /**
   * 最近一次生成的任务。视频节点允许并发，这里只保留**最新**那条，
   * 老画布和其它节点类型的行为完全不变；全部在跑的任务看 _pendingTasks。
   */
  taskInfo?: TaskInfo;
  /**
   * 这个节点上所有还在跑的任务，按 jobId 索引。视频节点点第二次生成不再取代第一次，
   * 两条都留在这里、各自一条进度、谁完成谁追加。
   * 改造之前存下的画布没有这个字段，tasksStore 会回落到 taskInfo 判定，不会把老任务判死。
   */
  _pendingTasks?: Record<string, TaskInfo>;
  /** 失败的生成：在多视频列表里占一个空位并显示红色报错。故意不塞进 url[]。 */
  _failedGenerations?: FailedGeneration[];
  uploadInfo?: UploadInfo;
  isStale?: boolean;
  contentWidth?: number;
  contentHeight?: number;
  _resourceMeta?: { items: ResourceMeta[] };
  _updatedAtMs?: number;
  _hiddenHistoryUrls?: string[];
  _assetCreatedAtMs?: Record<string, number>;
  _assetGenerationMeta?: Record<string, AssetGenerationMeta>;
  _assetPreviewUrls?: Record<string, string>;
  _generationVersion?: number;
  // Provenance markers stamped when a node is created by applying a Cindy
  // assistant proposal (see Canvas.tsx applyCindyProposal). Used both for
  // apply-idempotency and to render the pink "Cindy-origin" glow.
  _cindyProposalMessageId?: string;
  _cindyProposalNodeId?: string;
  // One-shot flag: Cindy "应用并生成" sets this on a freshly-applied generation
  // node; the node component fires its own generate once and clears it.
  _autoGenerate?: boolean;
}

export interface CanvasNode {
  nodeKey: string;
  projectUuid: string;
  toolId?: number;
  toolKey?: string;
  type: number; // 1=text 2=image 3=video 4=video_merge 5=director_stage 6=audio 7=script 8=upload
  name: string;
  position: { positionX: number; positionY: number };
  measured: { width: number; height: number };
  data: string; // JSON stringified CanvasNodeData
  parentKey?: string;
  status: number;
  workflowUuid?: string;
  workflowRoot?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export interface ProjectMeta {
  id?: number;
  uuid: string;
  name: string;
  coverUrl?: string;
  visibility?: number;
  collectionId?: string | null;
  collectionName?: string;
  assignedProjectId?: string | null;
  assignedProjectName?: string;
  assignedProjectStatus?: "not_started" | "in_progress" | "completed";
  assignedProjectStatusLabel?: string;
  ownerId?: number;
  ownerName?: string;
  isShared?: boolean;
  isPersonalShared?: boolean;
  personalShareCount?: number;
  canvasRole?: "normal" | "template";
  isTemplate?: boolean;
  templateSourceCanvasId?: string;
  templateSourceOwnerId?: number;
  isOwner?: boolean;
  canManage?: boolean;
  canWrite?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  contentVersion?: string;
  contentUpdatedBy?: number | null;
}

export interface ProjectDraft {
  id?: number;
  uuid?: string;
  projectUuid: string;
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  canvasTextScale?: number;
  lastEditedAtMs?: number;
  lastPluginEditAtMs?: number;
  lastClientNodeSaveAtMs?: number;
}

export interface Project {
  projectMeta: ProjectMeta;
  projectDraft: ProjectDraft;
  nodeList: CanvasNode[];
}

export interface ProjectIndex {
  uuid: string;
  name: string;
  coverUrl?: string;
  collectionId?: string | null;
  collectionName?: string;
  assignedProjectId?: string | null;
  assignedProjectName?: string;
  assignedProjectStatus?: "not_started" | "in_progress" | "completed";
  assignedProjectStatusLabel?: string;
  createdAtMs: number;
  updatedAtMs: number;
  nodeCount: number;
  ownerId?: number;
  ownerName?: string;
  isShared?: boolean;
  isPersonalShared?: boolean;
  personalShareCount?: number;
  canvasRole?: "normal" | "template";
  isTemplate?: boolean;
  templateSourceCanvasId?: string;
  templateSourceOwnerId?: number;
  isOwner?: boolean;
  canManage?: boolean;
  canWrite?: boolean;
}

export interface CanvasCollection {
  id: string;
  name: string;
  canvasCount: number;
  ownerId?: number;
  ownerName?: string;
  /** 顺序跟着 sd2 项目管理页的 shotflow 画布分类走，服务端已按它排好 */
  sortOrder?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CanvasAssignedProject {
  id: string;
  name: string;
  status: "not_started" | "in_progress" | "completed";
  shotflowApplicable?: boolean;
  /** sd2 项目管理页给这个项目选的 shotflow 画布分类 id；没选是 null */
  shotflowCategoryId?: number | null;
  statusLabel: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ShotflowCanvasCategory {
  id: number;
  name: string;
  sortOrder: number;
}

export interface CanvasOwnerOption {
  id: string;
  username: string;
  role: "user" | "admin";
  canvasCount: number;
}

export interface ProjectGroups {
  ownCanvases: ProjectIndex[];
  officialTemplateCanvases: ProjectIndex[];
  templateCanvases: ProjectIndex[];
  sharedCanvases: ProjectIndex[];
  personalSharedCanvases: ProjectIndex[];
  ownCollections: CanvasCollection[];
  /** sd2 项目管理页那份 shotflow 画布分类，按显示顺序（第一个是"测试"，它不做项目过滤） */
  shotflowCategories?: ShotflowCanvasCategory[];
  availableProjects: CanvasAssignedProject[];
  canvasOwners?: CanvasOwnerOption[];
  selectedOwnerId?: string;
  currentUserId?: string;
}

export type FavoriteLibraryItemType = "node" | "group" | "image" | "video";
export type FavoriteLibraryCategory =
  "text" | "image" | "video" | "group" | "other";

export interface FavoriteLibraryPayload {
  version: 1;
  rootIds: string[];
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  sourceProjectUuid?: string;
  sourceProjectName?: string;
}

export interface FavoriteLibraryItem {
  id: string;
  ownerId: number;
  ownerName: string;
  sourceProjectUuid?: string;
  sourceRootKey?: string;
  itemType: FavoriteLibraryItemType;
  title: string;
  description?: string;
  previewUrl?: string;
  nodeCount: number;
  shared: boolean;
  tags: string[];
  payload: FavoriteLibraryPayload;
  category?: FavoriteLibraryCategory;
  isOwner: boolean;
  canManage: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface FavoriteLibraryCreatePayload {
  itemType: FavoriteLibraryItemType;
  sourceProjectUuid?: string;
  sourceRootKey?: string;
  title: string;
  description?: string;
  previewUrl?: string;
  nodeCount: number;
  shared?: boolean;
  tags?: string[];
  payload: FavoriteLibraryPayload;
}
