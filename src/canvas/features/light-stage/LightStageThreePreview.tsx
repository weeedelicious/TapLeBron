import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { RectAreaLight } from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import {
  LIGHT_STAGE_PERSPECTIVE_FOV,
  LIGHT_STAGE_SPHERE_RADIUS,
  lightStageOrthoHalfHeight,
  lightStagePerspectiveDistance,
  lightStagePlaneLayout,
  lightStageViewScale,
} from './light-stage-layout'
import { LIGHT_STAGE_ANCHOR_BY_ID, LIGHT_STAGE_ANCHOR_DEFINITIONS, lightAttenuationRatio as lightAttenuationRatioValue, lightPosition, nearestAnchor, rotateVector } from './lightMath'
import type { LightStageAnchor, LightStageGeometryAssets, LightStageLightConfig, LightStageState } from './types'

const LIGHT_GIZMO_VISUAL_SCALE = 0.56
const LIGHT_LABEL_VISUAL_SCALE = 0.7
const LIGHT_PICK_RADIUS_SCALE = 0.5

interface LightStageThreePreviewProps {
  sourceUrl: string
  state: LightStageState
  geometry?: LightStageGeometryAssets
  onLightDirectionChange: (light: 'main' | 'fill', anchor: LightStageAnchor, rotation: LightStageLightConfig['rotation']) => void
  onStageRotationChange: (rotation: LightStageState['stageRotation']) => void
  onViewModeChange: (viewMode: LightStageState['viewMode']) => void
}

interface Runtime {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  perspectiveCamera: THREE.PerspectiveCamera
  frontCamera: THREE.OrthographicCamera
  stageGroup: THREE.Group
  subjectGroup: THREE.Group
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  lightGroup: THREE.Group
  orbitGuideGroup: THREE.Group
  mainGizmo?: THREE.Object3D
  fillGizmo?: THREE.Object3D
  frameId: number
  sourceTexture?: THREE.Texture
  depthTexture?: THREE.Texture
  normalTexture?: THREE.Texture
  reliefScale: number
}

function makeArc(rotation: [number, number, number], radius = 2.72, opacity = 0.18) {
  const points = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2).getPoints(128)
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(point.x, point.y, 0)))
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xa7a1ad, transparent: true, opacity }),
  )
  line.rotation.set(...rotation)
  return line
}

function makeSphereShell(radius: number, opacity: number) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 32),
    new THREE.MeshBasicMaterial({
      color: 0xb8b8b0,
      transparent: true,
      opacity,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  )
}

function loadTexture(loader: THREE.TextureLoader, url?: string, color = false) {
  if (!url) return undefined
  const texture = loader.load(url)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  return texture
}

function disposeTexture(texture?: THREE.Texture) {
  texture?.dispose()
}

function reliefSegments(width: number, height: number) {
  const longest = 168
  if (width >= height) {
    return {
      width: longest,
      height: Math.max(72, Math.round(longest * height / width)),
    }
  }
  return {
    width: Math.max(72, Math.round(longest * width / height)),
    height: longest,
  }
}

function labelSpriteFor(label: string, color: THREE.Color) {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = '700 28px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(10, 10, 12, 0.86)'
    ctx.lineWidth = 8
    ctx.strokeText(label, canvas.width / 2, canvas.height / 2)
    ctx.fillStyle = `#${color.getHexString()}`
    ctx.fillText(label, canvas.width / 2, canvas.height / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }))
  sprite.renderOrder = 9
  sprite.position.set(0, -0.22, 0)
  sprite.scale.set(0.68 * LIGHT_LABEL_VISUAL_SCALE, 0.27 * LIGHT_LABEL_VISUAL_SCALE, 1)
  return sprite
}

function roundedPanelShape(width: number, height: number, radius: number) {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const r = Math.max(0.001, Math.min(radius, halfWidth, halfHeight))
  const shape = new THREE.Shape()
  shape.moveTo(-halfWidth + r, -halfHeight)
  shape.lineTo(halfWidth - r, -halfHeight)
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + r)
  shape.lineTo(halfWidth, halfHeight - r)
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - r, halfHeight)
  shape.lineTo(-halfWidth + r, halfHeight)
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - r)
  shape.lineTo(-halfWidth, -halfHeight + r)
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + r, -halfHeight)
  return shape
}

function gizmoFor(
  light: LightStageLightConfig,
  label: string,
  role: 'main' | 'fill' = 'main',
) {
  const root = new THREE.Group()
  const color = new THREE.Color(light.color)
  const position = lightPosition(light.anchor, light.offset, 2.92, light.rotation, light.direction)
  const positionVector = new THREE.Vector3(position.x, position.y, position.z)
  root.position.copy(positionVector)
  root.rotation.z = THREE.MathUtils.degToRad(light.roll)

  let geometry: THREE.BufferGeometry
  if (light.type === 'area') {
    const panelWidth = (0.42 + light.width / 170) * LIGHT_GIZMO_VISUAL_SCALE
    const panelHeight = (0.28 + light.height / 210) * LIGHT_GIZMO_VISUAL_SCALE
    const panelRadius = Math.min(panelWidth, panelHeight) * 0.24
    geometry = new THREE.ShapeGeometry(roundedPanelShape(panelWidth, panelHeight, panelRadius))
  } else if (light.type === 'spot') {
    geometry = new THREE.RingGeometry(0.12 * LIGHT_GIZMO_VISUAL_SCALE, 0.23 * LIGHT_GIZMO_VISUAL_SCALE, 36)
  } else if (light.type === 'directional') {
    geometry = new THREE.OctahedronGeometry(0.24 * LIGHT_GIZMO_VISUAL_SCALE, 0)
  } else {
    geometry = new THREE.RingGeometry(0.08 * LIGHT_GIZMO_VISUAL_SCALE, 0.2 * LIGHT_GIZMO_VISUAL_SCALE, 36)
  }

  const handle = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: light.enabled ? 0.98 : 0.26,
      wireframe: false,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  )
  handle.renderOrder = 8
  root.add(handle)

  if (light.type === 'area') {
    const outlinePoints = roundedPanelShape(
      (0.42 + light.width / 170) * LIGHT_GIZMO_VISUAL_SCALE,
      (0.28 + light.height / 210) * LIGHT_GIZMO_VISUAL_SCALE,
      Math.min(
        (0.42 + light.width / 170) * LIGHT_GIZMO_VISUAL_SCALE,
        (0.28 + light.height / 210) * LIGHT_GIZMO_VISUAL_SCALE,
      ) * 0.24,
    ).getPoints(24)
    const outlineGeometry = new THREE.BufferGeometry().setFromPoints(outlinePoints.map((point) => new THREE.Vector3(point.x, point.y, 0)))
    const outline = new THREE.LineLoop(
      outlineGeometry,
      new THREE.LineBasicMaterial({
        color: color.clone().lerp(new THREE.Color(0xffffff), role === 'fill' ? 0.34 : 0.22),
        transparent: true,
        opacity: light.enabled ? 0.72 : 0.18,
      }),
    )
    outline.renderOrder = 9
    root.add(outline)

    const core = new THREE.Mesh(
      new THREE.CircleGeometry(Math.min(0.12, Math.min(
        (0.42 + light.width / 170) * LIGHT_GIZMO_VISUAL_SCALE,
        (0.28 + light.height / 210) * LIGHT_GIZMO_VISUAL_SCALE,
      ) * 0.16), 28),
      new THREE.MeshBasicMaterial({
        color: color.clone().lerp(new THREE.Color(0xffffff), 0.48),
        transparent: true,
        opacity: light.enabled ? 0.32 : 0.08,
        depthTest: false,
      }),
    )
    core.renderOrder = 9
    root.add(core)
  }

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.31 * LIGHT_GIZMO_VISUAL_SCALE, 24, 16),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: light.enabled ? 0.17 : 0.03, depthWrite: false }),
  )
  root.add(halo)
  root.add(labelSpriteFor(label, color))

  const pickRadius = (light.type === 'area'
    ? 0.82
    : light.type === 'directional'
      ? 0.72
      : 0.62) * LIGHT_PICK_RADIUS_SCALE
  const pick = new THREE.Mesh(
    new THREE.SphereGeometry(pickRadius, 18, 14),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  )
  pick.userData.isLightPickTarget = true
  pick.renderOrder = -1
  root.add(pick)

  if (light.enabled) {
    const attenuation = lightAttenuationRatioValue(light.attenuation, light.type === 'directional' ? 22 : 48)
    const length = positionVector.length()
    const coneRadius = light.type === 'spot'
      ? (0.28 + light.coneAngle / 150) * LIGHT_GIZMO_VISUAL_SCALE
      : light.type === 'area'
        ? (0.48 + light.width / 180) * LIGHT_GIZMO_VISUAL_SCALE
        : (0.42 - attenuation * 0.16) * LIGHT_GIZMO_VISUAL_SCALE
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(coneRadius, length, 40, 1, true),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: light.type === 'directional' ? 0.075 - attenuation * 0.04 : 0.075,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    beam.position.copy(positionVector).multiplyScalar(-0.5)
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), positionVector.clone().normalize())
    root.add(beam)
  }
  return root
}

function isLightPickTarget(object: THREE.Object3D | null) {
  return object?.userData?.isLightPickTarget === true
}

function lightAttenuationRatio(light: LightStageLightConfig) {
  return lightAttenuationRatioValue(light.attenuation, light.type === 'directional' ? 22 : 48)
}

function addConfiguredLight(group: THREE.Group, config: LightStageLightConfig) {
  if (!config.enabled || config.intensity <= 0) return
  const color = new THREE.Color(config.color)
  const strength = config.intensity / 34
  const position = lightPosition(config.anchor, config.offset, 3.1, config.rotation, config.direction)
  const attenuation = lightAttenuationRatio(config)
  let light: THREE.Light

  if (config.type === 'directional') {
    const directional = new THREE.DirectionalLight(color, strength * (1.12 - attenuation * 0.42))
    directional.position.set(position.x, position.y, position.z)
    directional.target.position.set(0, 0, 0)
    group.add(directional.target)
    light = directional
  } else if (config.type === 'spot') {
    const spot = new THREE.SpotLight(color, strength * 3.3, 10, THREE.MathUtils.degToRad(config.coneAngle), config.softness / 100, 0.7 + config.attenuation / 45)
    spot.position.set(position.x, position.y, position.z)
    spot.target.position.set(0, 0, 0)
    group.add(spot.target)
    light = spot
  } else if (config.type === 'area') {
    const reachScale = 1.18 - attenuation * 0.5
    const area = new RectAreaLight(
      color,
      strength * (2.55 - attenuation * 0.95),
      (0.8 + config.width / 28) * reachScale,
      (0.8 + config.height / 28) * reachScale,
    )
    area.position.set(position.x, position.y, position.z)
    area.lookAt(0, 0, 0)
    area.rotateZ(THREE.MathUtils.degToRad(config.roll))
    light = area
  } else {
    const point = new THREE.PointLight(color, strength * 2.7, 4 + config.distance / 9, 0.8 + config.attenuation / 45)
    point.position.set(position.x, position.y, position.z)
    light = point
  }
  group.add(light)
}

function normalizeAngle(value: number) {
  let angle = Number.isFinite(value) ? value : 0
  angle = ((angle + 180) % 360 + 360) % 360 - 180
  return Number(angle.toFixed(2))
}

function clampStageRotation(rotation: LightStageState['stageRotation']): LightStageState['stageRotation'] {
  return {
    x: THREE.MathUtils.clamp(Number(rotation.x) || 0, -78, 78),
    y: normalizeAngle(Number(rotation.y) || 0),
  }
}

function stageRotationQuaternion(rotation: LightStageState['stageRotation']) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rotation.x),
    THREE.MathUtils.degToRad(rotation.y),
    0,
    'YXZ',
  ))
}

const VIEW_PRESETS: Array<{ key: string; label: string; rotation: LightStageState['stageRotation'] }> = [
  { key: 'front', label: 'FRONT', rotation: { x: 0, y: 0 } },
  { key: 'back', label: 'BACK', rotation: { x: 0, y: 180 } },
  { key: 'left', label: 'LEFT', rotation: { x: 0, y: 90 } },
  { key: 'right', label: 'RIGHT', rotation: { x: 0, y: -90 } },
  { key: 'top', label: 'TOP', rotation: { x: 72, y: 0 } },
  { key: 'bottom', label: 'BOTTOM', rotation: { x: -72, y: 0 } },
]

function unitDirection(vector: THREE.Vector3) {
  const length = vector.length()
  return length > 0.001 ? vector.clone().multiplyScalar(1 / length) : new THREE.Vector3(0, 0, 1)
}

function frontRotationFromDirection(direction: THREE.Vector3): LightStageLightConfig['rotation'] {
  const target = unitDirection(direction)
  return {
    x: normalizeAngle(-THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(target.y, -1, 1)))),
    y: normalizeAngle(THREE.MathUtils.radToDeg(Math.atan2(target.x, target.z))),
    z: 0,
  }
}

function rotationFromAnchorDirection(anchor: LightStageAnchor, direction: THREE.Vector3): LightStageLightConfig['rotation'] {
  const base = LIGHT_STAGE_ANCHOR_BY_ID[anchor]?.vector ?? LIGHT_STAGE_ANCHOR_BY_ID.front.vector
  const baseVector = new THREE.Vector3(base.x, base.y, base.z).normalize()
  const target = unitDirection(direction)
  const euler = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(baseVector, target),
    'XYZ',
  )
  const rotation = {
    x: normalizeAngle(THREE.MathUtils.radToDeg(euler.x)),
    y: normalizeAngle(THREE.MathUtils.radToDeg(euler.y)),
    z: normalizeAngle(THREE.MathUtils.radToDeg(euler.z)),
  }
  const resolved = rotateVector(base, rotation)
  const score = resolved.x * target.x + resolved.y * target.y + resolved.z * target.z
  return score > 0.998 ? rotation : frontRotationFromDirection(target)
}

function lightTransformFromDirection(direction: THREE.Vector3): { anchor: LightStageAnchor; rotation: LightStageLightConfig['rotation'] } {
  const target = unitDirection(direction)
  const anchor = nearestAnchor({ x: target.x, y: target.y, z: target.z })
  return {
    anchor: anchor.value,
    rotation: rotationFromAnchorDirection(anchor.value, target),
  }
}

function findLightKey(object: THREE.Object3D | null): 'main' | 'fill' | null {
  let current: THREE.Object3D | null = object
  while (current) {
    const key = current.userData?.lightKey
    if (key === 'main' || key === 'fill') return key
    current = current.parent
  }
  return null
}

function clearGroup(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children.pop()
    if (!child) continue
    child.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose?.()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else {
        const materialWithMap = material as (THREE.Material & { map?: THREE.Texture }) | undefined
        materialWithMap?.map?.dispose?.()
        material?.dispose?.()
      }
    })
  }
}

export function LightStageThreePreview({
  sourceUrl,
  state,
  geometry,
  onLightDirectionChange,
  onStageRotationChange,
  onViewModeChange,
}: LightStageThreePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<Runtime | null>(null)
  const stateRef = useRef(state)
  const onLightDirectionChangeRef = useRef(onLightDirectionChange)
  const onStageRotationChangeRef = useRef(onStageRotationChange)
  const onViewModeChangeRef = useRef(onViewModeChange)
  stateRef.current = state
  onLightDirectionChangeRef.current = onLightDirectionChange
  onStageRotationChangeRef.current = onStageRotationChange
  onViewModeChangeRef.current = onViewModeChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.18
    renderer.domElement.className = 'light-stage-three-canvas'
    host.appendChild(renderer.domElement)
    RectAreaLightUniformsLib.init()

    const scene = new THREE.Scene()
    const perspectiveCamera = new THREE.PerspectiveCamera(LIGHT_STAGE_PERSPECTIVE_FOV, 1, 0.1, 100)
    const frontCamera = new THREE.OrthographicCamera(-3.1, 3.1, 2.5, -2.5, 0.1, 100)
    frontCamera.position.set(0, 0, 8)
    frontCamera.lookAt(0, 0, 0)

    const stageGroup = new THREE.Group()
    stageGroup.rotation.order = 'YXZ'
    scene.add(stageGroup)

    stageGroup.add(
      makeSphereShell(LIGHT_STAGE_SPHERE_RADIUS, 0.055),
      makeSphereShell(LIGHT_STAGE_SPHERE_RADIUS * 0.83, 0.047),
      makeSphereShell(LIGHT_STAGE_SPHERE_RADIUS * 0.66, 0.037),
    )
    const orbitGuideGroup = new THREE.Group()
    orbitGuideGroup.add(
      makeArc([0, 0, 0], LIGHT_STAGE_SPHERE_RADIUS * 0.99),
      makeArc([Math.PI / 2, 0, 0], LIGHT_STAGE_SPHERE_RADIUS * 0.99),
      makeArc([0, Math.PI / 2, 0], LIGHT_STAGE_SPHERE_RADIUS * 0.99),
    )
    orbitGuideGroup.visible = false
    stageGroup.add(orbitGuideGroup)

    const anchorMaterial = new THREE.MeshBasicMaterial({ color: 0xe5e1eb, transparent: true, opacity: 0.27 })
    for (const anchor of LIGHT_STAGE_ANCHOR_DEFINITIONS) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.027, 12, 8), anchorMaterial)
      dot.position.set(
        anchor.vector.x * LIGHT_STAGE_SPHERE_RADIUS,
        anchor.vector.y * LIGHT_STAGE_SPHERE_RADIUS,
        anchor.vector.z * LIGHT_STAGE_SPHERE_RADIUS,
      )
      stageGroup.add(dot)
    }

    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('use-credentials')
    const sourceTexture = loadTexture(loader, geometry?.diffuseUrl || sourceUrl, true)
    const depthTexture = loadTexture(loader, geometry?.depthUrl)
    const normalTexture = loadTexture(loader, geometry?.normalUrl)
    const planeSize = lightStagePlaneLayout(geometry?.width, geometry?.height)
    const segments = reliefSegments(planeSize.width, planeSize.height)
    const reliefScale = planeSize.reliefDepth
    perspectiveCamera.position.set(0, 0.08, lightStagePerspectiveDistance(1))
    perspectiveCamera.lookAt(0, 0, 0)
    const planeGeometry = new THREE.PlaneGeometry(planeSize.width, planeSize.height, segments.width, segments.height)
    const planeMaterial = new THREE.MeshStandardMaterial({
      map: sourceTexture,
      ...(normalTexture
        ? {
            normalMap: normalTexture,
            normalMapType: THREE.ObjectSpaceNormalMap,
          }
        : {}),
      ...(depthTexture
        ? {
            displacementMap: depthTexture,
            displacementScale: reliefScale,
            displacementBias: -reliefScale * 0.5,
          }
        : {}),
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
      color: 0xffffff,
      dithering: true,
    })
    const plane = new THREE.Mesh(planeGeometry, planeMaterial)
    const subjectGroup = new THREE.Group()
    subjectGroup.add(plane)
    stageGroup.add(subjectGroup)

    const lightGroup = new THREE.Group()
    stageGroup.add(lightGroup)
    const runtime: Runtime = {
      renderer,
      scene,
      perspectiveCamera,
      frontCamera,
      stageGroup,
      subjectGroup,
      plane,
      lightGroup,
      orbitGuideGroup,
      frameId: 0,
      sourceTexture,
      depthTexture,
      normalTexture,
      reliefScale,
    }
    runtimeRef.current = runtime

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      const viewportAspect = width / height
      perspectiveCamera.aspect = viewportAspect
      perspectiveCamera.position.set(0, 0.08, lightStagePerspectiveDistance(viewportAspect))
      perspectiveCamera.lookAt(0, 0, 0)
      perspectiveCamera.updateProjectionMatrix()
      const orthoHalfHeight = lightStageOrthoHalfHeight(viewportAspect)
      frontCamera.left = -orthoHalfHeight * viewportAspect
      frontCamera.right = orthoHalfHeight * viewportAspect
      frontCamera.top = orthoHalfHeight
      frontCamera.bottom = -orthoHalfHeight
      frontCamera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const render = () => {
      runtime.frameId = requestAnimationFrame(render)
      renderer.render(scene, stateRef.current.viewMode === 'front' ? frontCamera : perspectiveCamera)
    }
    render()

    type DragState =
      | { kind: 'light'; light: 'main' | 'fill'; object: THREE.Object3D }
      | { kind: 'subject'; startX: number; startY: number; rotationX: number; rotationY: number }
    let drag: DragState | null = null
    const pointerPosition = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const pointerNdc = (point: { x: number; y: number }) => {
      const rect = renderer.domElement.getBoundingClientRect()
      return new THREE.Vector2(
        (point.x / Math.max(1, rect.width)) * 2 - 1,
        -(point.y / Math.max(1, rect.height)) * 2 + 1,
      )
    }
    const spherePoint = (x: number, y: number) => {
      const camera = stateRef.current.viewMode === 'front' ? frontCamera : perspectiveCamera
      const ndc = pointerNdc({ x, y })
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(ndc, camera)
      const origin = raycaster.ray.origin
      const direction = raycaster.ray.direction
      const b = 2 * origin.dot(direction)
      const c = origin.lengthSq() - LIGHT_STAGE_SPHERE_RADIUS * LIGHT_STAGE_SPHERE_RADIUS
      const discriminant = b * b - 4 * c
      if (discriminant >= 0) {
        const t = (-b - Math.sqrt(discriminant)) / 2
        return origin.clone().add(direction.clone().multiplyScalar(Math.max(0, t)))
      }
      return new THREE.Vector3(ndc.x, ndc.y, 0.65).normalize().multiplyScalar(LIGHT_STAGE_SPHERE_RADIUS)
    }
    const onPointerDown = (event: PointerEvent) => {
      const point = pointerPosition(event)
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(pointerNdc(point), stateRef.current.viewMode === 'front' ? frontCamera : perspectiveCamera)
      const lightTargets = [
        runtime.mainGizmo && { light: 'main' as const, object: runtime.mainGizmo },
        runtime.fillGizmo && { light: 'fill' as const, object: runtime.fillGizmo },
      ].filter(Boolean) as Array<{ light: 'main' | 'fill'; object: THREE.Object3D }>
      const intersections = raycaster.intersectObjects(lightTargets.map((item) => item.object), true)
      const hit = intersections.find((intersection) => isLightPickTarget(intersection.object))
      const hitLight = hit ? findLightKey(hit.object) : null
      const hitObject = hitLight ? lightTargets.find((item) => item.light === hitLight)?.object : null
      if (hitLight && hitObject) {
        drag = { kind: 'light', light: hitLight, object: hitObject }
      } else {
        if (stateRef.current.viewMode === 'front') onViewModeChangeRef.current('perspective')
        drag = {
          kind: 'subject',
          startX: point.x,
          startY: point.y,
          rotationX: stateRef.current.stageRotation.x,
          rotationY: stateRef.current.stageRotation.y,
        }
      }
      orbitGuideGroup.visible = true
      renderer.domElement.setPointerCapture(event.pointerId)
      event.preventDefault()
      event.stopPropagation()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return
      const point = pointerPosition(event)
      if (drag.kind === 'subject') {
        onStageRotationChangeRef.current(clampStageRotation({
          x: drag.rotationX - (point.y - drag.startY) * 0.18,
          y: drag.rotationY + (point.x - drag.startX) * 0.28,
        }))
      } else {
        const pointOnSphere = spherePoint(point.x, point.y)
        const stageRotation = stateRef.current.viewMode === 'front'
          ? { x: 0, y: 0 }
          : clampStageRotation(stateRef.current.stageRotation)
        const logicalPoint = pointOnSphere
          .clone()
          .applyQuaternion(stageRotationQuaternion(stageRotation).invert())
        drag.object.position.copy(logicalPoint)
        const finalDirection = logicalPoint.clone().normalize()
        const transform = lightTransformFromDirection(finalDirection)
        onLightDirectionChangeRef.current(
          drag.light,
          transform.anchor,
          transform.rotation,
        )
      }
      event.preventDefault()
    }
    const endDrag = (event: PointerEvent) => {
      if (!drag) return
      drag = null
      orbitGuideGroup.visible = false
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
    }
    const clearDrag = () => {
      drag = null
      orbitGuideGroup.visible = false
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', endDrag)
    renderer.domElement.addEventListener('pointercancel', endDrag)
    window.addEventListener('pointerup', clearDrag)
    window.addEventListener('mouseup', clearDrag)
    window.addEventListener('blur', clearDrag)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(runtime.frameId)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', endDrag)
      renderer.domElement.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('pointerup', clearDrag)
      window.removeEventListener('mouseup', clearDrag)
      window.removeEventListener('blur', clearDrag)
      clearGroup(lightGroup)
      planeGeometry.dispose()
      planeMaterial.dispose()
      disposeTexture(sourceTexture)
      disposeTexture(depthTexture)
      disposeTexture(normalTexture)
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh !== plane) mesh.geometry?.dispose?.()
        if (mesh !== plane && mesh.material) {
          if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose())
          else mesh.material.dispose()
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [geometry?.depthUrl, geometry?.diffuseUrl, geometry?.height, geometry?.normalUrl, geometry?.width, sourceUrl])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    clearGroup(runtime.lightGroup)
    const stageRotation = state.viewMode === 'front' ? { x: 0, y: 0 } : clampStageRotation(state.stageRotation)
    runtime.stageGroup.rotation.order = 'YXZ'
    runtime.stageGroup.rotation.x = THREE.MathUtils.degToRad(stageRotation.x)
    runtime.stageGroup.rotation.y = THREE.MathUtils.degToRad(stageRotation.y)
    runtime.subjectGroup.rotation.set(0, 0, 0)
    runtime.subjectGroup.scale.setScalar(lightStageViewScale(state.viewMode))
    runtime.plane.material.map = state.subjectMode === 'color' ? runtime.sourceTexture ?? null : null
    runtime.plane.material.color.set(state.subjectMode === 'color' ? 0xffffff : 0xbeb8ae)
    runtime.plane.material.roughness = state.subjectMode === 'color' ? 0.78 : 0.9
    runtime.plane.material.displacementScale = runtime.reliefScale
    runtime.plane.material.displacementBias = -runtime.reliefScale * 0.5
    runtime.plane.material.needsUpdate = true

    if (state.ambient.enabled && state.ambient.intensity > 0) runtime.lightGroup.add(new THREE.AmbientLight(state.ambient.color, state.ambient.intensity / 68))
    addConfiguredLight(runtime.lightGroup, state.main)
    addConfiguredLight(runtime.lightGroup, state.fill)
    if (state.rimLight) {
      const rim = new THREE.DirectionalLight(0xdde9ff, 0.72)
      rim.position.set(0.8, 1.2, -3.5)
      runtime.lightGroup.add(rim)
    }
    runtime.mainGizmo = gizmoFor(state.main, '主光', 'main')
    runtime.mainGizmo.userData.lightKey = 'main'
    runtime.fillGizmo = gizmoFor(state.fill, '辅光', 'fill')
    runtime.fillGizmo.userData.lightKey = 'fill'
    runtime.lightGroup.add(runtime.mainGizmo, runtime.fillGizmo)
  }, [
    geometry?.depthUrl,
    geometry?.diffuseUrl,
    geometry?.height,
    geometry?.normalUrl,
    geometry?.width,
    sourceUrl,
    state.ambient,
    state.fill,
    state.main,
    state.rimLight,
    state.stageRotation,
    state.subjectMode,
    state.viewMode,
  ])

  const visibleStageRotation = state.viewMode === 'front' ? { x: 0, y: 0 } : clampStageRotation(state.stageRotation)
  const viewCubeTransform = `rotateX(${visibleStageRotation.x - 18}deg) rotateY(${visibleStageRotation.y - 34}deg)`
  const selectViewPreset = (rotation: LightStageState['stageRotation']) => {
    onViewModeChange('perspective')
    onStageRotationChange(clampStageRotation(rotation))
  }

  return (
    <div ref={hostRef} className="light-stage-three-host">
      <div className="light-stage-view-cube" aria-label="View direction">
        <div className="light-stage-view-cube-scene" style={{ transform: viewCubeTransform }}>
          {VIEW_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={`light-stage-view-cube-face is-${preset.key}`}
              onClick={() => selectViewPreset(preset.rotation)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      <span className="light-stage-cardinal light-stage-cardinal-top">上</span>
      <span className="light-stage-cardinal light-stage-cardinal-bottom">下</span>
      <span className="light-stage-cardinal light-stage-cardinal-left">左</span>
      <span className="light-stage-cardinal light-stage-cardinal-right">右</span>
      <span className="light-stage-cardinal light-stage-cardinal-front">前</span>
      <span className="light-stage-cardinal light-stage-cardinal-back">后</span>
      <span className="light-stage-drag-hint">拖动空白处旋转 2.5D 主体 · 拖动灯体调整灯位</span>
    </div>
  )
}
