/**
 * 三维空间的 three.js 运行时。
 *
 * 结构照 `features/light-stage/LightStageThreePreview.tsx`：一个 Runtime ref 装住所有
 * three 对象，挂载时建一次、卸载时全部 dispose，状态变化用若干个小 effect 往里同步 ——
 * 不重建场景。重建的代价是 GPU 资源反复分配，而且 OrbitControls 的手感会断。
 *
 * 用的都是 three 官方 MIT 模块：OrbitControls（自由视角）、TransformControls（旋转手柄）。
 * 出图靠 `preserveDrawingBuffer: true` + canvas.toBlob，和全景截图（PanoramaViewport）
 * 完全同一套流程。
 *
 * 一个刻意的选择：**背景板关掉时出的是透明背景 PNG**（renderer 开 alpha，clearAlpha 给 0）。
 * 这张图多半要当构图参考喂给图片模型，能抠掉背景比多一块灰底有用。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import {
  DIRECTOR_JOINTS,
  JOINT_BY_ID,
  JOINT_EULER_ORDER,
  axisEulerSign,
  applyEulerDelta,
  clampJointAngles,
  eulerForJoint,
  fingerIkChainFor,
  ikChainFor,
  isFingerJoint,
  poseAngles,
  type JointId,
  type Pose,
} from './skeleton'
import { forwardKinematics, solveIk, type Vec3 } from './ik'
import { clampFocalMm, focalToFovDeg, orbitToPosition, positionToOrbit } from './cameraMath'
import type { DirectorStageState, StageProp } from './types'

export type StageTool = 'slider' | 'rotate' | 'ik' | 'finger'
export type PropTool = 'translate' | 'rotate' | 'scale'

export interface StageCaptureResult {
  blob: Blob
  width: number
  height: number
}

export interface DirectorStageThreeHandle {
  capture: (size: { width: number; height: number }) => Promise<StageCaptureResult>
}

interface Props {
  state: DirectorStageState
  tool: StageTool
  propTool: PropTool
  selectedJoint: JointId | null
  selectedPropId: string | null
  onSelectJoint: (jointId: JointId | null) => void
  onSelectProp: (propId: string | null) => void
  onPoseChange: (pose: Pose) => void
  onPropChange: (prop: StageProp) => void
  onCameraChange: (camera: DirectorStageState['camera']) => void
  /** false = 藏掉身上的关节小球（出图本来就会藏，这是编辑时预览用的）。 */
  showJointHandles?: boolean
  /** 关节小球相对默认半径的倍率。1 = 原来的大小。 */
  jointHandleScale?: number
}

export const MIN_JOINT_HANDLE_SCALE = 0.4
export const MAX_JOINT_HANDLE_SCALE = 2
export const DEFAULT_JOINT_HANDLE_SCALE = 1

export function clampJointHandleScale(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_JOINT_HANDLE_SCALE
  return Math.min(MAX_JOINT_HANDLE_SCALE, Math.max(MIN_JOINT_HANDLE_SCALE, num))
}

const FIGURE_COLOR = 0xe8e6ef
const HANDLE_COLOR = 0x7c5cfc
const HANDLE_ACTIVE_COLOR = 0xffd166
const IK_HANDLE_COLOR = 0x4ad6a5
const FINGER_HANDLE_COLOR = 0x6ec8ff
const PROP_COLOR = 0x9c93b8

/**
 * MakeHuman 白模（CC0，由 tools/build_mannequin.py 合成）。
 * 同域绝对路径 —— 和 poseEstimator 的 `POSE_MODEL_BASE` 同一个目录，
 * 也和 `/shotflow-logo.png` 一样走 public/，浏览器不需要外网。
 */
const MANNEQUIN_URL = '/models/mannequin.glb'

/** 胶囊几何默认沿 +Y —— `alignTo` 就是把它转到骨头方向去。 */
const CAPSULE_AXIS = new THREE.Vector3(0, 1, 0)

interface Runtime {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  orbit: OrbitControls
  transform: TransformControls
  figure: THREE.Group
  joints: Record<JointId, THREE.Bone>
  handles: THREE.Mesh[]
  /** 小号指节手柄。只在「手指」工具下显示，避免和手腕绿球糊成一团。 */
  fingerHandles: THREE.Mesh[]
  /** 程序化白模的那些图元。蒙皮白模载入成功后它们被隐藏，失败就一直显示（兜底）。 */
  shapeMeshes: THREE.Mesh[]
  /** 程序化图元和蒙皮网格共用同一份材质 —— 两者外观必须一致 */
  bodyMaterial: THREE.MeshStandardMaterial
  /** MakeHuman 蒙皮白模。没载进来时是 null。 */
  skin: THREE.SkinnedMesh | null
  propGroup: THREE.Group
  propMeshes: Map<string, THREE.Mesh>
  ground: THREE.Mesh
  grid: THREE.GridHelper
  backdrop: THREE.Mesh
  raycaster: THREE.Raycaster
  frameId: number
  resize: () => void
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material?.dispose()
  })
}

function geometryForShape(shape: NonNullable<(typeof DIRECTOR_JOINTS)[number]['shape']>) {
  if (shape.kind === 'sphere') return new THREE.SphereGeometry(shape.size[0], 24, 18)
  if (shape.kind === 'capsule') return new THREE.CapsuleGeometry(shape.size[0], shape.size[1], 6, 14)
  return new THREE.BoxGeometry(shape.size[0], shape.size[1], shape.size[2])
}

/**
 * 按关节表把骨骼树搭出来，顺便挂上程序化的身体图元和点选把手。
 *
 * 关节用 `THREE.Bone` 而不是 `Object3D` —— 它们除了做姿势载体，还要直接当
 * MakeHuman 蒙皮白模的骨（见 attachMannequinSkin）。Bone 就是带标记的 Object3D，
 * 旋转 / 层级 / getWorldPosition 用法完全一样。
 *
 * 程序化图元是**兜底**：蒙皮白模载入成功后它们会被隐藏。保留它是因为
 * 一个 748KB 的同域资产虽然基本不会失败，但真失败了整个节点就没法用了。
 *
 * 把手用 `depthTest: false` + 高 renderOrder：被身体挡住的关节也要点得到，
 * 否则调背面的姿势得先把镜头转过去。手指默认不出身体那套把手（`pickable: false`）——
 * 手上挤 30 个球既点不准也糊成一团。手指工具另外挂小号手柄，只在那一档显示。
 */
function buildFigure() {
  const figure = new THREE.Group()
  figure.name = 'director-figure'
  const joints = {} as Record<JointId, THREE.Bone>
  const handles: THREE.Mesh[] = []
  const fingerHandles: THREE.Mesh[] = []
  const shapeMeshes: THREE.Mesh[] = []
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: FIGURE_COLOR,
    roughness: 0.72,
    metalness: 0.04,
  })

  for (const joint of DIRECTOR_JOINTS) {
    const node = new THREE.Bone()
    node.name = joint.id
    node.rotation.order = JOINT_EULER_ORDER
    node.position.set(joint.offset[0], joint.offset[1], joint.offset[2])
    joints[joint.id] = node
    const parent = joint.parent ? joints[joint.parent] : figure
    parent.add(node)

    if (joint.shape) {
      const mesh = new THREE.Mesh(geometryForShape(joint.shape), bodyMaterial)
      mesh.position.set(joint.shape.offset[0], joint.shape.offset[1], joint.shape.offset[2])
      const aim = joint.shape.alignTo
      if (aim) {
        const dir = new THREE.Vector3(aim[0], aim[1], aim[2])
        if (dir.lengthSq() > 1e-18) mesh.quaternion.setFromUnitVectors(CAPSULE_AXIS, dir.normalize())
      } else if (joint.shape.rotation) {
        mesh.rotation.set(...joint.shape.rotation)
      }
      mesh.castShadow = false
      node.add(mesh)
      shapeMeshes.push(mesh)
    }

    if (joint.pickable === false) {
      if (isFingerJoint(joint.id)) {
        const fingerHandle = new THREE.Mesh(
          new THREE.SphereGeometry(0.012, 12, 10),
          new THREE.MeshBasicMaterial({
            color: FINGER_HANDLE_COLOR,
            transparent: true,
            opacity: 0.55,
            depthTest: false,
          }),
        )
        fingerHandle.renderOrder = 11
        fingerHandle.userData.jointId = joint.id
        fingerHandle.visible = false
        node.add(fingerHandle)
        fingerHandles.push(fingerHandle)
      }
      continue
    }

    const isIkHandle = Boolean(ikChainFor(joint.id))
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(joint.handleRadius ?? 0.042, 16, 12),
      new THREE.MeshBasicMaterial({
        color: isIkHandle ? IK_HANDLE_COLOR : HANDLE_COLOR,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
      }),
    )
    handle.renderOrder = 10
    handle.userData.jointId = joint.id
    node.add(handle)
    handles.push(handle)
  }

  return { figure, joints, handles, fingerHandles, shapeMeshes, bodyMaterial }
}

/**
 * 载入 MakeHuman 白模，把它的蒙皮**重绑到我们自己那 49 根骨上**，然后隐藏程序化图元。
 *
 * 为什么不直接用 glb 自带的骨：那样骨架就有两份真源了。glb 的骨长和 `DIRECTOR_JOINTS`
 * 出自同一个脚本，但「同一个脚本算的」不等于「运行时一定一致」—— 而 IK、旋转手柄、
 * 参考图反推读的全是 `DIRECTOR_JOINTS`。一旦两边错开，画面上的手和 IK 以为的手就不在一处。
 * 所以这里只取网格和逆绑定矩阵，骨照旧是 buildFigure 建的那些。
 *
 * 成功返回 true；失败返回 false 并保留程序化白模（调用方不需要额外补救）。
 *
 * `GLTFLoader` 走**动态 import**：它有 100KB 上下，而主包已经 3.9MB 且是已知的加载瓶颈。
 * 这个函数本来就是异步的（要等 glb 下载），顺手把 loader 也并行下来，一点不多花时间。
 */
async function attachMannequinSkin(runtime: Runtime): Promise<boolean> {
  let source: THREE.SkinnedMesh | null = null
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const gltf = await new GLTFLoader().loadAsync(MANNEQUIN_URL)
    gltf.scene.traverse((child) => {
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) source = child as THREE.SkinnedMesh
    })
  } catch (error) {
    console.warn('[三维空间] 白模没载进来，退回程序化白模：', error)
    return false
  }
  const mesh = source as THREE.SkinnedMesh | null
  if (!mesh) {
    console.warn('[三维空间] glb 里没有蒙皮网格，退回程序化白模')
    return false
  }

  const names = mesh.skeleton.bones.map((bone) => bone.name)
  const missing = names.filter((name) => !runtime.joints[name as JointId])
  if (missing.length > 0) {
    console.warn(`[三维空间] glb 的骨在关节表里找不到（${missing.join(', ')}），退回程序化白模`)
    return false
  }

  /*
   * 静止骨位对账。逆绑定矩阵是 translate(−静止世界位置)，所以取负就是骨该在哪；
   * 拿它和关节表算出来的静止姿势比。差超过 1mm 说明生成脚本和关节表脱钩了 ——
   * 这种错不会报异常，只会让蒙皮和 IK 各说各话，必须自己喊出来。
   */
  const rest = forwardKinematics({})
  const drift: string[] = []
  names.forEach((name, index) => {
    const inv = mesh.skeleton.boneInverses[index]
    const expected = rest[name as JointId]?.position
    if (!inv || !expected) return
    const dx = -inv.elements[12] - expected[0]
    const dy = -inv.elements[13] - expected[1]
    const dz = -inv.elements[14] - expected[2]
    const off = Math.hypot(dx, dy, dz)
    if (off > 1e-3) drift.push(`${name} 差 ${(off * 1000).toFixed(1)}mm`)
  })
  if (drift.length > 0) {
    console.warn(`[三维空间] 白模骨位和关节表不一致，重跑 tools/build_mannequin.py：${drift.join('；')}`)
  }

  const skin = new THREE.SkinnedMesh(mesh.geometry, runtime.bodyMaterial)
  skin.name = 'mannequin-skin'
  // 摆姿势后包围球会失真、导致整个人被误剔除。就一个网格，不值得为剔除操心。
  skin.frustumCulled = false
  skin.castShadow = false
  runtime.figure.add(skin)
  // bindMatrix 给单位矩阵：figure 和 skin 都在原点且无变换，骨的世界矩阵就是蒙皮矩阵
  skin.bind(
    new THREE.Skeleton(names.map((name) => runtime.joints[name as JointId]), mesh.skeleton.boneInverses),
    new THREE.Matrix4(),
  )
  runtime.skin = skin
  runtime.shapeMeshes.forEach((item) => { item.visible = false })
  return true
}

function propGeometry(kind: StageProp['kind']) {
  return kind === 'cylinder'
    ? new THREE.CylinderGeometry(0.5, 0.5, 1, 24)
    : new THREE.BoxGeometry(1, 1, 1)
}

const DEG = Math.PI / 180

/** three 的 Euler（YXZ，弧度）→ 语义角度。是 skeleton.eulerForJoint 的反函数。 */
function semanticFromEuler(jointId: JointId, euler: THREE.Euler): [number, number, number] {
  return clampJointAngles(jointId, [
    (euler.x / DEG) * axisEulerSign(jointId, 0),
    (euler.y / DEG) * axisEulerSign(jointId, 1),
    (euler.z / DEG) * axisEulerSign(jointId, 2),
  ])
}

/**
 * 把这次拖动的欧拉差加到拖之前的语义角上。
 *
 * 不能每帧直接拆 `object.rotation`：Three 的 YXZ 把 Y 解在 ±180，胯转过 180°
 * 会被解成 -180 再被钳死，看起来就是「转不过去」。周期轴走最短弧，其它轴照差值加。
 */
export const DirectorStageThree = forwardRef<DirectorStageThreeHandle, Props>(function DirectorStageThree({
  state,
  tool,
  propTool,
  selectedJoint,
  selectedPropId,
  onSelectJoint,
  onSelectProp,
  onPoseChange,
  onPropChange,
  onCameraChange,
  showJointHandles = true,
  jointHandleScale = DEFAULT_JOINT_HANDLE_SCALE,
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<Runtime | null>(null)
  // 事件回调里要读到最新的 props，但又不能因为 props 变化重建整个场景，所以走 ref。
  const stateRef = useRef(state)
  const toolRef = useRef(tool)
  const selectedJointRef = useRef(selectedJoint)
  const showJointHandlesRef = useRef(showJointHandles)
  const callbacksRef = useRef({ onSelectJoint, onSelectProp, onPoseChange, onPropChange, onCameraChange })
  /** 正在用代码改相机 —— 此时 OrbitControls 的 change 事件不要再回写状态，否则来回打架。 */
  const applyingCameraRef = useRef(false)
  /** 正在拖旋转手柄。拖的时候姿势由 gizmo 直接改 quaternion，不要再用欧拉角回写。 */
  const transformingRef = useRef(false)
  /**
   * 默认机位已经从 state 写进 three 了。在这之前 OrbitControls 派的 change
   * 一律丢掉 —— 相机还在原点，写回去就是「打开三维空间对着原点」。
   */
  const cameraLiveRef = useRef(false)

  stateRef.current = state
  toolRef.current = tool
  selectedJointRef.current = selectedJoint
  showJointHandlesRef.current = showJointHandles
  callbacksRef.current = { onSelectJoint, onSelectProp, onPoseChange, onPropChange, onCameraChange }

  useImperativeHandle(forwardedRef, () => ({
    /**
     * 出图。和全景截图同一套：临时把 pixelRatio 压到 1、按目标尺寸 setSize、
     * 渲染一帧、finish() 等 GPU 真的画完、再 toBlob；finally 里恢复原来的尺寸。
     */
    capture: async ({ width, height }) => {
      const runtime = runtimeRef.current
      if (!runtime) throw new Error('三维空间还没准备好')
      const captureWidth = Math.max(16, Math.round(width))
      const captureHeight = Math.max(16, Math.round(height))
      const previousPixelRatio = runtime.renderer.getPixelRatio()
      const previousAspect = runtime.camera.aspect
      const gizmoWasVisible = runtime.transform.getHelper().visible
      const handleOpacity = runtime.handles.map((handle) => (handle.material as THREE.Material).opacity)
      const fingerHandleOpacity = runtime.fingerHandles.map((handle) => (handle.material as THREE.Material).opacity)
      const fingerHandleVisible = runtime.fingerHandles.map((handle) => handle.visible)
      try {
        // 出图里不能有把手和 gizmo —— 那是编辑用的辅助物，不是画面内容
        runtime.transform.getHelper().visible = false
        runtime.handles.forEach((handle) => { handle.visible = false })
        runtime.fingerHandles.forEach((handle) => { handle.visible = false })
        runtime.renderer.setPixelRatio(1)
        runtime.renderer.setSize(captureWidth, captureHeight, false)
        runtime.camera.aspect = captureWidth / captureHeight
        runtime.camera.updateProjectionMatrix()
        runtime.renderer.render(runtime.scene, runtime.camera)
        runtime.renderer.getContext().finish()
        const blob = await new Promise<Blob>((resolve, reject) => {
          runtime.renderer.domElement.toBlob((result) => {
            if (result) resolve(result)
            else reject(new Error('当前浏览器无法导出这张图'))
          }, 'image/png')
        })
        return { blob, width: captureWidth, height: captureHeight }
      } finally {
        runtime.transform.getHelper().visible = gizmoWasVisible
        runtime.handles.forEach((handle, index) => {
          handle.visible = showJointHandlesRef.current
          ;(handle.material as THREE.Material).opacity = handleOpacity[index]
        })
        runtime.fingerHandles.forEach((handle, index) => {
          handle.visible = fingerHandleVisible[index]
          ;(handle.material as THREE.Material).opacity = fingerHandleOpacity[index]
        })
        runtime.renderer.setPixelRatio(previousPixelRatio)
        runtime.camera.aspect = previousAspect
        runtime.camera.updateProjectionMatrix()
        runtime.resize()
      }
    },
  }), [])

  // ── 建场景（只跑一次）──────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new THREE.Scene()
    const initialCamera = stateRef.current.camera
    const camera = new THREE.PerspectiveCamera(focalToFovDeg(initialCamera.focalMm), 1, 0.05, 200)
    // 相机默认在原点。必须在 new OrbitControls 之前摆到默认机位，
    // 否则控件一 update 就会按原点派 change，打开三维空间就对着脚底下。
    const [ix, iy, iz] = orbitToPosition(initialCamera)
    camera.position.set(ix, iy, iz)
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'director-stage-canvas'
    renderer.domElement.setAttribute('aria-label', '三维空间视图')
    host.appendChild(renderer.domElement)

    // 三点式打光：白模只有形状没有材质，光不给足就看不出体积
    scene.add(new THREE.HemisphereLight(0xdfe4ff, 0x2a2a33, 0.85))
    const key = new THREE.DirectionalLight(0xffffff, 1.65)
    key.position.set(2.4, 3.4, 3.2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xbfc6ff, 0.5)
    fill.position.set(-3, 1.6, 1.4)
    scene.add(fill)
    const rim = new THREE.DirectionalLight(0xffffff, 0.45)
    rim.position.set(-1.2, 2.2, -3.4)
    scene.add(rim)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x33333d, roughness: 0.95, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)

    const grid = new THREE.GridHelper(20, 40, 0x6a6480, 0x3d3a4d)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.45
    grid.position.y = 0.002
    scene.add(grid)

    // 背景板：立在人物后面的一块大板，兼顾「有个干净底」和「知道人站在哪」
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 12),
      new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 1, metalness: 0 }),
    )
    backdrop.position.set(0, 6, -6)
    scene.add(backdrop)

    const { figure, joints, handles, fingerHandles, shapeMeshes, bodyMaterial } = buildFigure()
    scene.add(figure)

    const propGroup = new THREE.Group()
    propGroup.name = 'director-props'
    scene.add(propGroup)

    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true
    orbit.dampingFactor = 0.08
    orbit.minDistance = 0.4
    orbit.maxDistance = 40
    // 不许转到地面以下 —— 从地底往上看白模没有任何构图意义，只会让人迷失方向
    orbit.maxPolarAngle = Math.PI / 2 - 0.01
    orbit.target.set(initialCamera.target[0], initialCamera.target[1], initialCamera.target[2])
    applyingCameraRef.current = true
    orbit.update()
    applyingCameraRef.current = false

    const transform = new TransformControls(camera, renderer.domElement)
    transform.setSize(0.8)
    // 关节旋转按骨头自己的轴（YXZ / 弯曲·扭转·侧倾），世界轴会把三个环拧成一团，
    // 拖起来像在绕任意轴转 —— 用户 2026-08-27 报的就是这个。
    transform.setSpace('local')
    scene.add(transform.getHelper())

    const raycaster = new THREE.Raycaster()
    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    const runtime: Runtime = {
      renderer, scene, camera, orbit, transform, figure, joints, handles, fingerHandles,
      shapeMeshes, bodyMaterial, skin: null,
      propGroup, propMeshes: new Map(), ground, grid, backdrop, raycaster,
      frameId: 0, resize,
    }
    runtimeRef.current = runtime
    resize()

    // 蒙皮白模异步载入。载不进来就一直用程序化白模 —— 节点始终可用。
    // 载进来的时候姿势可能已经摆好了，不用管：蒙皮绑的是活的骨，当前姿势自动生效。
    void attachMannequinSkin(runtime).then(() => {
      // 卸载竞速：组件已经拆了就别再往一个 dispose 过的场景里塞东西
      if (runtimeRef.current !== runtime && runtime.skin) {
        runtime.figure.remove(runtime.skin)
        runtime.skin.geometry.dispose()
        runtime.skin = null
      }
    })

    // ── 相机：拖的过程中就把结果读回状态（出图 / 下次打开接着用）────────────
    //
    // 走 `change` 而不是 `end`：滚轮缩放的 start/end 是同步派的，等 end 会丢。
    // 轨道不进撤销栈（见 stageHistory.sameStageStateIgnoringOrbit），
    // 所以这里提交不会让 Ctrl+Z 把镜头倒回去。
    const emitCamera = () => {
      if (applyingCameraRef.current || !cameraLiveRef.current) return
      const current = stateRef.current.camera
      const target: [number, number, number] = [orbit.target.x, orbit.target.y, orbit.target.z]
      const orbitAngles = positionToOrbit([camera.position.x, camera.position.y, camera.position.z], target)
      const next = { ...current, ...orbitAngles, target }
      const same =
        Math.abs(next.yaw - current.yaw) < 0.05 &&
        Math.abs(next.pitch - current.pitch) < 0.05 &&
        Math.abs(next.distance - current.distance) < 0.005 &&
        Math.abs(next.target[0] - current.target[0]) < 0.002 &&
        Math.abs(next.target[1] - current.target[1]) < 0.002 &&
        Math.abs(next.target[2] - current.target[2]) < 0.002
      if (same) return
      callbacksRef.current.onCameraChange(next)
    }
    orbit.addEventListener('change', emitCamera)

    // ── 旋转手柄：按增量累加语义角，不每帧拆欧拉 ──────────────────────────────
    const rotateDrag = {
      jointId: null as JointId | null,
      start: [0, 0, 0] as [number, number, number],
      last: new THREE.Euler(),
    }
    const emitTransform = () => {
      const object = transform.object
      if (!object) return
      const jointId = object.name as JointId
      if (JOINT_BY_ID[jointId]) {
        // 拖的时候只读增量、不写回物体。YXZ 欧拉每帧 round-trip 会在万向节附近跳，
        // 而且 ±180 会被解成另一端（用户 2026-08-28）。钳制放到松手那一帧。
        if (rotateDrag.jointId === jointId) {
          const angles = applyEulerDelta(jointId, rotateDrag.start, rotateDrag.last, object.rotation)
          rotateDrag.last.copy(object.rotation)
          rotateDrag.start = angles
          callbacksRef.current.onPoseChange({ ...stateRef.current.pose, [jointId]: angles })
        } else {
          callbacksRef.current.onPoseChange({
            ...stateRef.current.pose,
            [jointId]: semanticFromEuler(jointId, object.rotation),
          })
        }
        return
      }
      const propId = object.userData.propId as string | undefined
      if (!propId) return
      const prop = stateRef.current.props.find((item) => item.id === propId)
      if (!prop) return
      callbacksRef.current.onPropChange({
        ...prop,
        position: [object.position.x, object.position.y, object.position.z],
        rotation: [object.rotation.x / DEG, object.rotation.y / DEG, object.rotation.z / DEG],
        scale: [object.scale.x, object.scale.y, object.scale.z],
      })
    }
    transform.addEventListener('objectChange', emitTransform)
    // 拖 gizmo 期间别让 OrbitControls 也跟着转；松手再按钳制后的欧拉落盘一次。
    const onDraggingChanged = (event: { value: boolean }) => {
      orbit.enabled = !event.value
      transformingRef.current = event.value
      const object = transform.object
      const jointId = object?.name as JointId | undefined
      if (event.value) {
        if (object && jointId && JOINT_BY_ID[jointId]) {
          rotateDrag.jointId = jointId
          rotateDrag.start = [...poseAngles(stateRef.current.pose, jointId)]
          rotateDrag.last.copy(object.rotation)
        } else {
          rotateDrag.jointId = null
        }
        return
      }
      rotateDrag.jointId = null
      if (!object || !jointId || !JOINT_BY_ID[jointId]) return
      const angles = clampJointAngles(jointId, poseAngles(stateRef.current.pose, jointId))
      const [ex, ey, ez] = eulerForJoint(jointId, angles)
      object.rotation.set(ex, ey, ez)
      callbacksRef.current.onPoseChange({ ...stateRef.current.pose, [jointId]: angles })
    }
    transform.addEventListener('dragging-changed', onDraggingChanged as never)

    // ── 点选 / IK 拖拽 ───────────────────────────────────────────────────────
    const pointer = new THREE.Vector2()
    const dragPlane = new THREE.Plane()
    const hitPoint = new THREE.Vector3()
    let ikDrag: { effector: JointId; links: JointId[] } | null = null
    let downPos: { x: number; y: number } | null = null

    const setPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(
        ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
    }

    const pickJoint = (event: PointerEvent): JointId | null => {
      if (!showJointHandlesRef.current) return null
      setPointer(event)
      const pickables = toolRef.current === 'finger'
        ? [...fingerHandles.filter((handle) => handle.visible), ...handles]
        : handles
      const hits = raycaster.intersectObjects(pickables, false)
      const jointId = hits[0]?.object.userData.jointId
      return typeof jointId === 'string' ? (jointId as JointId) : null
    }

    const pickProp = (event: PointerEvent): string | null => {
      setPointer(event)
      const hits = raycaster.intersectObjects(propGroup.children, false)
      const propId = hits[0]?.object.userData.propId
      return typeof propId === 'string' ? propId : null
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      downPos = { x: event.clientX, y: event.clientY }
      const tool = toolRef.current
      if (tool !== 'ik' && tool !== 'finger') return
      const jointId = pickJoint(event)
      const chain = tool === 'finger'
        ? (jointId ? fingerIkChainFor(jointId) : undefined)
        : (jointId ? ikChainFor(jointId) : undefined)
      if (!chain) return
      ikDrag = chain
      orbit.enabled = false
      callbacksRef.current.onSelectJoint(jointId)
      // 拖拽平面：过把手、朝着相机 —— 鼠标在屏幕上怎么动，把手就在这个平面上怎么走
      const handleWorld = new THREE.Vector3()
      runtime.joints[chain.effector].getWorldPosition(handleWorld)
      dragPlane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()).negate(),
        handleWorld,
      )
      renderer.domElement.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!ikDrag) return
      setPointer(event)
      if (!raycaster.ray.intersectPlane(dragPlane, hitPoint)) return
      const target: Vec3 = [hitPoint.x, hitPoint.y, hitPoint.z]
      const result = solveIk({
        pose: stateRef.current.pose,
        effector: ikDrag.effector,
        links: ikDrag.links,
        target,
      })
      callbacksRef.current.onPoseChange(result.pose)
    }

    const endDrag = (event: PointerEvent) => {
      if (ikDrag) {
        ikDrag = null
        orbit.enabled = true
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId)
        }
      }
      if (!downPos) return
      const moved = Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y)
      downPos = null
      // 超过 4px 算拖动（转视角），不当点击 —— 否则转一下镜头就把选中项换了
      if (moved > 4) return
      const jointId = pickJoint(event)
      if (jointId) {
        callbacksRef.current.onSelectProp(null)
        callbacksRef.current.onSelectJoint(jointId)
        return
      }
      const propId = pickProp(event)
      if (propId) {
        callbacksRef.current.onSelectJoint(null)
        callbacksRef.current.onSelectProp(propId)
        return
      }
      callbacksRef.current.onSelectJoint(null)
      callbacksRef.current.onSelectProp(null)
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', endDrag)
    renderer.domElement.addEventListener('pointercancel', endDrag)

    const observer = new ResizeObserver(resize)
    observer.observe(host)

    const tick = () => {
      runtime.frameId = window.requestAnimationFrame(tick)
      orbit.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      window.cancelAnimationFrame(runtime.frameId)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', endDrag)
      renderer.domElement.removeEventListener('pointercancel', endDrag)
      orbit.removeEventListener('change', emitCamera)
      cameraLiveRef.current = false
      transform.removeEventListener('objectChange', emitTransform)
      transform.removeEventListener('dragging-changed', onDraggingChanged as never)
      transform.detach()
      transform.dispose()
      orbit.dispose()
      disposeObject(scene)
      renderer.dispose()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [])

  // ── 姿势 → 关节旋转 ────────────────────────────────────────────────────────
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || transformingRef.current) return
    for (const joint of DIRECTOR_JOINTS) {
      const [ex, ey, ez] = eulerForJoint(joint.id, poseAngles(state.pose, joint.id))
      runtime.joints[joint.id].rotation.set(ex, ey, ez)
    }
  }, [state.pose])

  // ── 相机状态 → three 相机 ─────────────────────────────────────────────────
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const { camera } = state
    applyingCameraRef.current = true
    const [x, y, z] = orbitToPosition(camera)
    runtime.camera.position.set(x, y, z)
    runtime.orbit.target.set(camera.target[0], camera.target[1], camera.target[2])
    runtime.camera.fov = focalToFovDeg(clampFocalMm(camera.focalMm))
    runtime.camera.updateProjectionMatrix()
    runtime.orbit.update()
    applyingCameraRef.current = false
    cameraLiveRef.current = true
  }, [state.camera])

  // ── 场景选项 → 地面 / 网格 / 背景板 / 出图底色 ─────────────────────────────
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const { scene } = state
    runtime.ground.visible = scene.groundVisible
    ;(runtime.ground.material as THREE.MeshStandardMaterial).color.set(scene.groundColor)
    runtime.grid.visible = scene.gridVisible
    runtime.backdrop.visible = scene.backdropVisible
    ;(runtime.backdrop.material as THREE.MeshStandardMaterial).color.set(scene.backdropColor)
    // 背景板关掉 = 透明底出图，方便当参考图抠用
    runtime.renderer.setClearColor(new THREE.Color(scene.backdropColor), scene.backdropVisible ? 1 : 0)
  }, [state.scene])

  // ── 道具列表 → 场景里的方块 / 圆柱 ────────────────────────────────────────
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const alive = new Set(state.props.map((prop) => prop.id))
    for (const [id, mesh] of runtime.propMeshes) {
      if (alive.has(id)) continue
      if (runtime.transform.object === mesh) runtime.transform.detach()
      runtime.propGroup.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      runtime.propMeshes.delete(id)
    }
    for (const prop of state.props) {
      let mesh = runtime.propMeshes.get(prop.id)
      // 换了形状要重建几何体，不能只改 scale
      if (mesh && mesh.userData.kind !== prop.kind) {
        mesh.geometry.dispose()
        mesh.geometry = propGeometry(prop.kind)
        mesh.userData.kind = prop.kind
      }
      if (!mesh) {
        mesh = new THREE.Mesh(
          propGeometry(prop.kind),
          new THREE.MeshStandardMaterial({ color: PROP_COLOR, roughness: 0.8, metalness: 0.05 }),
        )
        mesh.name = `prop:${prop.id}`
        mesh.userData.propId = prop.id
        mesh.userData.kind = prop.kind
        runtime.propGroup.add(mesh)
        runtime.propMeshes.set(prop.id, mesh)
      }
      mesh.position.set(prop.position[0], prop.position[1], prop.position[2])
      mesh.rotation.set(prop.rotation[0] * DEG, prop.rotation[1] * DEG, prop.rotation[2] * DEG)
      mesh.scale.set(prop.scale[0], prop.scale[1], prop.scale[2])
    }
  }, [state.props])

  // ── 选中项 → 手柄高亮 + gizmo 挂到谁身上 ──────────────────────────────────
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    for (const handle of runtime.handles) {
      const active = handle.userData.jointId === selectedJoint
      const material = handle.material as THREE.MeshBasicMaterial
      material.color.set(
        active ? HANDLE_ACTIVE_COLOR : ikChainFor(handle.userData.jointId as JointId) ? IK_HANDLE_COLOR : HANDLE_COLOR,
      )
      material.opacity = active ? 0.95 : 0.5
      handle.scale.setScalar(clampJointHandleScale(jointHandleScale) * (active ? 1.25 : 1))
      handle.visible = showJointHandles
    }

    for (const handle of runtime.fingerHandles) {
      const jointId = handle.userData.jointId as JointId
      const chain = fingerIkChainFor(jointId)
      const active = selectedJoint != null && (jointId === selectedJoint || chain?.effector === selectedJoint || chain?.links.includes(selectedJoint) === true)
      handle.visible = showJointHandles && tool === 'finger'
      const material = handle.material as THREE.MeshBasicMaterial
      material.color.set(active ? HANDLE_ACTIVE_COLOR : FINGER_HANDLE_COLOR)
      material.opacity = active ? 0.95 : 0.55
      handle.scale.setScalar(clampJointHandleScale(jointHandleScale) * (active ? 1.35 : 1))
    }

    // gizmo 只在需要时出现：滑杆和 IK 模式下它只会挡视线。
    // 道具优先：选了道具就挂道具的平移 / 旋转 / 缩放；没选道具才考虑关节旋转。
    // IK 必须走 detach —— TransformControls 默认 mode 是 translate，
    // 挂在绿色关节上就会出现图 1 那种 XYZ 平移轴（用户 2026-08-27）。
    if (tool !== 'ik' && tool !== 'finger' && selectedPropId) {
      const mesh = runtime.propMeshes.get(selectedPropId)
      if (mesh) {
        runtime.transform.attach(mesh)
        runtime.transform.setMode(propTool)
        runtime.transform.setSpace(propTool === 'rotate' ? 'local' : 'world')
        runtime.transform.showE = true
        runtime.transform.showXYZE = true
        runtime.transform.getHelper().visible = true
        return
      }
    }
    if (showJointHandles && tool === 'rotate' && selectedJoint && runtime.joints[selectedJoint]) {
      runtime.transform.attach(runtime.joints[selectedJoint])
      runtime.transform.setMode('rotate')
      runtime.transform.setSpace('local')
      // 彩色环 = 单轴，外圈 E / XYZE = 自由转。用户 2026-08-27 要多轴自由旋转。
      runtime.transform.showE = true
      runtime.transform.showXYZE = true
      runtime.transform.getHelper().visible = true
      return
    }
    runtime.transform.detach()
    runtime.transform.getHelper().visible = false
  }, [selectedJoint, selectedPropId, tool, propTool, state.props, showJointHandles, jointHandleScale])

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    // 画布右键要留给浏览器（见 lib/canvasContextMenu.ts），这里只挡住上游的节点菜单
    event.stopPropagation()
  }, [])

  return <div ref={hostRef} className="director-stage-viewport" onContextMenu={onContextMenu} />
})
