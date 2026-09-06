/**
 * 从一张图里检测人体关键点。这个文件是**唯一**碰 MediaPipe 和网络的地方，
 * 重定向那一摊纯逻辑在 `poseFromLandmarks.ts`。
 *
 * 用的是 Google 的 `@mediapipe/tasks-vision`（**Apache-2.0**）里的 `PoseLandmarker`：
 * `runningMode: 'IMAGE'` 支持单张静态图，输出 33 个关键点并且带 **3D 世界坐标**（GHUM 模型）。
 *
 * 三件刻意的工程决定：
 *
 * ① **动态 import。** 主包已经 3.9MB 且是已知的加载瓶颈，这一坨（含 WASM）绝不能进主包。
 *    只有用户真的点了「分析参考图姿势」才开始下载，之后浏览器自己缓存。
 *
 * ② **模型和 WASM 全部自托管在我们自己域下**（`/models/...`），不走 Google 或 jsdelivr 的 CDN。
 *    这是内网工具，不能假设用户浏览器能出外网；而且外部 CDN 挂了就等于功能挂了。
 *    落地脚本见 `tools/fetch_pose_model.py`。
 *
 * ③ **实例只建一次并缓存。** 建一次要解析 WASM + 读 9MB 模型，是整个流程里最贵的一步，
 *    每次点击都重建会让第二次分析和第一次一样慢。
 */
import { LANDMARK_COUNT, LM, type Landmark } from './poseFromLandmarks'
import { HAND_LANDMARK_COUNT } from './handFromLandmarks'
import type { Side } from './skeleton'

/** WASM 和模型都在这个前缀下，由 `tools/fetch_pose_model.py` 放进 `dist/models/`。 */
export const POSE_MODEL_BASE = '/models'
export const POSE_WASM_PATH = `${POSE_MODEL_BASE}/tasks-vision-wasm`
/**
 * 用 `full`（9.0MB）而不是 `lite`（5.5MB）/ `heavy`（29.2MB）：
 * WASM 那一头本来就有 11.8MB，模型这几 MB 的差别对首次下载总量影响不大，
 * 而 full 的精度明显好于 lite。
 */
export const POSE_MODEL_PATH = `${POSE_MODEL_BASE}/pose_landmarker_full.task`

/** 首次使用要下的大致体积，界面上要如实告诉用户（WASM 11.8MB + 模型 9MB）。 */
export const POSE_FIRST_LOAD_MB = 21

/**
 * 手部关键点模型。和姿势模型同一个包（`@mediapipe/tasks-vision`）、同一份 WASM，
 * 所以勾上「连手指一起推」只多下这个 `.task`（约 12MB），WASM 不重复下。
 */
export const HAND_MODEL_PATH = `${POSE_MODEL_BASE}/hand_landmarker.task`
/** 实测 7.5MB（float16 的 /1/ 版本），报 8 给用户。 */
export const HAND_FIRST_LOAD_MB = 8

/** 裁出来的手要放大到这么大再检测。太小模型看不清指节，太大纯浪费。 */
export const HAND_CROP_SIZE = 256
/** 裁剪框比手部关键点的外接框再放大这么多 —— 留出手指伸展的余量。 */
export const HAND_CROP_MARGIN = 1.9
/** 裁剪框的下限（按前臂长的比例算）。关键点挤成一点时靠它兜住。 */
export const HAND_CROP_MIN_FOREARM_RATIO = 0.55

export interface PoseDetection {
  landmarks: Landmark[]
  /**
   * 归一化的**图像**坐标（x/y 是画面比例）。
   *
   * 解姿势用的是 `landmarks`（世界坐标），这一套只用来算「手在画面哪儿」好裁图 ——
   * 裁图本来就是图像空间的事，世界坐标反而用不上。
   */
  imageLandmarks: Landmark[]
  /** 已经解好的图，裁手的时候直接复用，不重新下载一遍 */
  image: HTMLImageElement
  /** 图里检测到几个人（我们只用最靠前那个） */
  poseCount: number
}

export interface CropRect {
  x: number
  y: number
  size: number
}

/**
 * 算出该从哪儿裁这只手。返回的是**图像像素**坐标的正方形。
 *
 * 为什么要裁：全身照里手常常只有几十个像素，直接把整张图喂给 `HandLandmarker`
 * 基本检不出来。裁一小块再放大到 256px 是 MediaPipe Holistic 当年的做法。
 *
 * 框的中心取手腕 / 小指 / 食指 / 拇指四个点的重心，半径取「到重心的最大距离 × 余量」，
 * 再用前臂长兜一个下限 —— 手握成拳时那四个点会挤在一起，只按它们算框会小到看不见手。
 */
export function handCropRect(
  imageLandmarks: readonly Landmark[] | undefined,
  side: Side,
  imageWidth: number,
  imageHeight: number,
): CropRect | null {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null
  const pick = (index: number) => {
    const point = imageLandmarks?.[index]
    if (!point) return null
    const x = Number(point.x) * imageWidth
    const y = Number(point.y) * imageHeight
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return [x, y] as [number, number]
  }
  const wrist = pick(side === 'L' ? LM.leftWrist : LM.rightWrist)
  if (!wrist) return null
  const others = [
    pick(side === 'L' ? LM.leftPinky : LM.rightPinky),
    pick(side === 'L' ? LM.leftIndex : LM.rightIndex),
    pick(side === 'L' ? LM.leftThumb : LM.rightThumb),
  ].filter((point): point is [number, number] => point !== null)
  const points = [wrist, ...others]
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length
  let radius = 0
  for (const point of points) radius = Math.max(radius, Math.hypot(point[0] - cx, point[1] - cy))
  radius *= HAND_CROP_MARGIN

  const elbow = pick(side === 'L' ? LM.leftElbow : LM.rightElbow)
  if (elbow) {
    const forearm = Math.hypot(wrist[0] - elbow[0], wrist[1] - elbow[1])
    radius = Math.max(radius, forearm * HAND_CROP_MIN_FOREARM_RATIO)
  }
  // 兜底：连前臂都没有时，别退化成 0 像素
  radius = Math.max(radius, Math.min(imageWidth, imageHeight) * 0.04)

  const size = Math.min(Math.round(radius * 2), Math.min(imageWidth, imageHeight))
  if (size < 8) return null
  const x = Math.round(Math.min(Math.max(cx - size / 2, 0), imageWidth - size))
  const y = Math.round(Math.min(Math.max(cy - size / 2, 0), imageHeight - size))
  return { x, y, size }
}

/** 分析失败的原因。界面按这个出不同的说法，不要把英文异常直接甩给用户。 */
export type PoseEstimateErrorKind = 'load-failed' | 'no-person' | 'image-failed'

export class PoseEstimateError extends Error {
  readonly kind: PoseEstimateErrorKind
  constructor(kind: PoseEstimateErrorKind, message: string) {
    super(message)
    this.name = 'PoseEstimateError'
    this.kind = kind
  }
}

type LandmarkerLike = {
  detect: (image: HTMLImageElement | HTMLCanvasElement) => {
    worldLandmarks?: Array<Array<{ x: number; y: number; z: number; visibility?: number }>>
    landmarks?: Array<Array<{ x: number; y: number; z: number; visibility?: number }>>
  }
}

let landmarkerPromise: Promise<LandmarkerLike> | null = null
let handLandmarkerPromise: Promise<LandmarkerLike> | null = null

/**
 * 建（或复用）检测器。第一次会下 WASM + 模型，所以调用方必须给等待态。
 *
 * 失败时把缓存清掉：否则一次网络抽风会让这个功能在整个会话里永久失效
 * （Promise 被 reject 后一直缓存着那个 reject）。
 */
export async function ensurePoseLandmarker(): Promise<LandmarkerLike> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(POSE_WASM_PATH)
      return (await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL_PATH, delegate: 'GPU' },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      })) as unknown as LandmarkerLike
    })().catch((error) => {
      landmarkerPromise = null
      throw new PoseEstimateError(
        'load-failed',
        `姿势识别模型没加载起来（${error instanceof Error ? error.message : String(error)}）`,
      )
    })
  }
  return landmarkerPromise
}

/**
 * 建（或复用）手部检测器。WASM 和姿势检测器共用，所以这里只多下模型那 12MB。
 *
 * `numHands: 1` —— 我们每次只喂一只手的裁剪图（左右由裁剪决定，见 handFromLandmarks
 * 文件头「左右手怎么定」），所以不需要模型去分辨画面里有几只手。
 */
export async function ensureHandLandmarker(): Promise<LandmarkerLike> {
  if (!handLandmarkerPromise) {
    handLandmarkerPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(POSE_WASM_PATH)
      return (await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate: 'GPU' },
        runningMode: 'IMAGE',
        numHands: 1,
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      })) as unknown as LandmarkerLike
    })().catch((error) => {
      handLandmarkerPromise = null
      throw new PoseEstimateError(
        'load-failed',
        `手部识别模型没加载起来（${error instanceof Error ? error.message : String(error)}）`,
      )
    })
  }
  return handLandmarkerPromise
}

/**
 * 把参考图读成一个可以喂给检测器的 `HTMLImageElement`。
 *
 * `crossOrigin = 'use-credentials'` 和灯光台的贴图加载一致（`LightStageThreePreview`）：
 * `/assets/...` 是本应用带会话鉴权发出来的，同域时这个设置无害，
 * 万一以后资产走到对象存储域名上，也能在服务端配好 CORS 后继续工作。
 */
export async function loadReferenceImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'use-credentials'
    image.decoding = 'sync'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new PoseEstimateError('image-failed', '参考图没读出来，可能是地址失效了'))
    image.src = url
  })
}

function normalizeLandmarks(
  raw: Array<{ x: number; y: number; z: number; visibility?: number }> | undefined,
  limit: number = LANDMARK_COUNT,
): Landmark[] {
  const list = Array.isArray(raw) ? raw : []
  return list.slice(0, limit).map((point) => ({
    x: Number(point?.x),
    y: Number(point?.y),
    z: Number(point?.z),
    ...(typeof point?.visibility === 'number' ? { visibility: point.visibility } : {}),
  }))
}

/**
 * 检测一张图里的人体关键点，返回**世界坐标**那一套。
 *
 * 为什么必须用 `worldLandmarks` 而不是 `landmarks`：后者是归一化的图像坐标
 * （x/y 是画面比例、z 是个相对深度），拿它算骨头方向会被画面宽高比和构图带偏；
 * 前者是以髋部中心为原点的三维米制坐标，与取景无关，正是重定向要的东西。
 */
export async function estimatePoseFromImage(url: string): Promise<PoseDetection> {
  const landmarker = await ensurePoseLandmarker()
  const image = await loadReferenceImage(url)
  const result = landmarker.detect(image)
  const world = Array.isArray(result?.worldLandmarks) ? result.worldLandmarks : []
  const first = world[0]
  if (!first || first.length === 0) {
    throw new PoseEstimateError('no-person', '这张图里没识别出人物，换一张人物完整、清晰一点的试试')
  }
  const screen = Array.isArray(result?.landmarks) ? result.landmarks : []
  return {
    landmarks: normalizeLandmarks(first),
    imageLandmarks: normalizeLandmarks(screen[0]),
    image,
    poseCount: world.length,
  }
}

/**
 * 检测某一只手的 21 个关键点。
 *
 * 三步：按身体关键点算裁剪框 → 裁出来放大到 256px → 喂 `HandLandmarker`。
 * 检不到就返回 null（调用方把那只手留在原位）—— 手太小 / 侧对镜头 / 被遮挡时
 * 检不出来是常态，不该当成错误弹给用户。
 */
export async function estimateHandFromCrop(
  image: HTMLImageElement,
  imageLandmarks: readonly Landmark[] | undefined,
  side: Side,
): Promise<Landmark[] | null> {
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  const rect = handCropRect(imageLandmarks, side, width, height)
  if (!rect) return null

  const canvas = document.createElement('canvas')
  canvas.width = HAND_CROP_SIZE
  canvas.height = HAND_CROP_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(image, rect.x, rect.y, rect.size, rect.size, 0, 0, HAND_CROP_SIZE, HAND_CROP_SIZE)

  const landmarker = await ensureHandLandmarker()
  const result = landmarker.detect(canvas)
  // 手指角度要的是三维方向，所以同样取 worldLandmarks 而不是图像坐标
  const world = Array.isArray(result?.worldLandmarks) ? result.worldLandmarks : []
  const first = world[0]
  if (!first || first.length < HAND_LANDMARK_COUNT) return null
  return normalizeLandmarks(first, HAND_LANDMARK_COUNT)
}

function wristNorm(
  imageLandmarks: readonly Landmark[] | undefined,
  side: Side,
): [number, number] | null {
  const index = side === 'L' ? LM.leftWrist : LM.rightWrist
  const point = imageLandmarks?.[index]
  if (!point) return null
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return [x, y]
}

/**
 * 把整图检到的手，按离身体左右手腕谁更近配对。
 * 输入必须是**图像归一化坐标**（0–1），worldLandmarks 的原点在手上，拿去比距离会配对错。
 */
export function assignHandsByWrist(
  imageLandmarks: readonly Landmark[] | undefined,
  hands: Array<{ world: Landmark[]; image: Landmark[] }>,
): { L: Landmark[] | null; R: Landmark[] | null } {
  const leftWrist = wristNorm(imageLandmarks, 'L')
  const rightWrist = wristNorm(imageLandmarks, 'R')
  const out: { L: Landmark[] | null; R: Landmark[] | null } = { L: null, R: null }
  if (hands.length === 0) return out
  const dist = (hand: Landmark[], wrist: [number, number]) => {
    const hx = Number(hand[0]?.x)
    const hy = Number(hand[0]?.y)
    if (!Number.isFinite(hx) || !Number.isFinite(hy)) return Number.POSITIVE_INFINITY
    return Math.hypot(hx - wrist[0], hy - wrist[1])
  }
  if (hands.length === 1) {
    const only = hands[0]
    if (leftWrist && rightWrist) {
      if (dist(only.image, leftWrist) <= dist(only.image, rightWrist)) out.L = only.world
      else out.R = only.world
      return out
    }
    if (leftWrist) out.L = only.world
    else out.R = only.world
    return out
  }
  const a = hands[0]
  const b = hands[1]
  if (leftWrist && rightWrist) {
    const same = dist(a.image, leftWrist) + dist(b.image, rightWrist)
    const swapped = dist(a.image, rightWrist) + dist(b.image, leftWrist)
    if (swapped < same) {
      out.L = b.world
      out.R = a.world
      return out
    }
  }
  out.L = a.world
  out.R = b.world
  return out
}

/**
 * 整图检测双手。裁切失败（手贴边、被挡住）时的兜底：
 * numHands 临时提到 2，检完立刻改回 1，避免下次裁切误检两只。
 */
export async function estimateHandsFromFullImage(
  image: HTMLImageElement,
  imageLandmarks: readonly Landmark[] | undefined,
): Promise<{ L: Landmark[] | null; R: Landmark[] | null }> {
  const landmarker = await ensureHandLandmarker() as LandmarkerLike & {
    setOptions?: (options: { numHands?: number }) => Promise<void>
  }
  try {
    await landmarker.setOptions?.({ numHands: 2 })
  } catch {
    // 旧版 WASM 没有 setOptions 就按当前 numHands 检一次，总比直接放弃好
  }
  const result = landmarker.detect(image)
  try {
    await landmarker.setOptions?.({ numHands: 1 })
  } catch {
    /* ignore */
  }
  const world = Array.isArray(result?.worldLandmarks) ? result.worldLandmarks : []
  const screen = Array.isArray(result?.landmarks) ? result.landmarks : []
  const hands: Array<{ world: Landmark[]; image: Landmark[] }> = []
  for (let index = 0; index < world.length; index += 1) {
    const item = world[index]
    if (!Array.isArray(item) || item.length < HAND_LANDMARK_COUNT) continue
    hands.push({
      world: normalizeLandmarks(item, HAND_LANDMARK_COUNT),
      image: normalizeLandmarks(screen[index], HAND_LANDMARK_COUNT),
    })
  }
  return assignHandsByWrist(imageLandmarks, hands)
}

/**
 * 先按身体关键点裁切左右手；哪只裁空了，再用整图双手检测兜底。
 * 左右永远由身体手腕位置决定，不看模型的 handedness。
 */
export async function estimateHandsFromImage(
  image: HTMLImageElement,
  imageLandmarks: readonly Landmark[] | undefined,
): Promise<{ L: Landmark[] | null; R: Landmark[] | null }> {
  const cropped: { L: Landmark[] | null; R: Landmark[] | null } = {
    L: await estimateHandFromCrop(image, imageLandmarks, 'L'),
    R: await estimateHandFromCrop(image, imageLandmarks, 'R'),
  }
  if (cropped.L && cropped.R) return cropped
  const assigned = await estimateHandsFromFullImage(image, imageLandmarks)
  return {
    L: cropped.L ?? assigned.L,
    R: cropped.R ?? assigned.R,
  }
}

/** 只给测试用：把缓存的检测器清掉。 */
export function resetPoseLandmarkerForTests() {
  landmarkerPromise = null
  handLandmarkerPromise = null
}
