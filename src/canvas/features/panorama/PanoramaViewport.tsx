import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import * as THREE from 'three'
import { clampPanoramaFov, clampPanoramaPitch, normalizePanoramaYaw } from './panorama'

export interface PanoramaView {
  yaw: number
  pitch: number
  fov: number
}

export interface PanoramaCaptureRequest {
  width: number
  height: number
}

export interface PanoramaCaptureResult {
  blob: Blob
  width: number
  height: number
  view: PanoramaView
  exposure: number
}

export interface PanoramaViewportHandle {
  capture: (request: PanoramaCaptureRequest) => Promise<PanoramaCaptureResult>
  ready: () => boolean
}

export const DEFAULT_PANORAMA_VIEW: PanoramaView = { yaw: 0, pitch: 0, fov: 72 }
export const DEFAULT_PANORAMA_EXPOSURE = 1
export const MIN_PANORAMA_EXPOSURE = 0.75
export const MAX_PANORAMA_EXPOSURE = 1.5

interface PanoramaViewportProps {
  url: string
  view?: PanoramaView
  exposure?: number
  flat?: boolean
  grid?: boolean
  onViewChange?: (view: PanoramaView) => void
  className?: string
  help?: string
  emptyMessage?: string
}

interface RendererRuntime {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  material: THREE.ShaderMaterial
  textureReady: boolean
  resize: () => void
}

export function normalizePanoramaView(view: PanoramaView): PanoramaView {
  return {
    yaw: normalizePanoramaYaw(view.yaw),
    pitch: clampPanoramaPitch(view.pitch),
    fov: clampPanoramaFov(view.fov),
  }
}

export function clampPanoramaExposure(value: number) {
  const safe = Number.isFinite(value) ? value : DEFAULT_PANORAMA_EXPOSURE
  return Math.max(MIN_PANORAMA_EXPOSURE, Math.min(MAX_PANORAMA_EXPOSURE, safe))
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('当前浏览器无法导出机位截图'))
    }, 'image/png')
  })
}

const PANORAMA_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const PANORAMA_FRAGMENT_SHADER = `
  uniform sampler2D panoramaMap;
  uniform float exposure;
  varying vec2 vUv;
  void main() {
    vec4 sampled = texture2D(panoramaMap, vUv);
    gl_FragColor = vec4(sampled.rgb * exposure, sampled.a);
  }
`

export const PanoramaViewport = forwardRef<PanoramaViewportHandle, PanoramaViewportProps>(function PanoramaViewport({
  url,
  view,
  exposure = DEFAULT_PANORAMA_EXPOSURE,
  flat = false,
  grid = false,
  onViewChange,
  className = '',
  help = '拖拽环视 · 滚轮缩放',
  emptyMessage = '连接一张 2:1 HDR 全景图片',
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<RendererRuntime | null>(null)
  const viewRef = useRef<PanoramaView>(normalizePanoramaView(view ?? DEFAULT_PANORAMA_VIEW))
  const exposureRef = useRef(clampPanoramaExposure(exposure))
  const [loading, setLoading] = useState(Boolean(url && !flat))
  const [error, setError] = useState('')

  useEffect(() => {
    viewRef.current = normalizePanoramaView(view ?? DEFAULT_PANORAMA_VIEW)
  }, [view])

  useEffect(() => {
    exposureRef.current = clampPanoramaExposure(exposure)
  }, [exposure])

  const updateView = useCallback((next: PanoramaView) => {
    const normalized = normalizePanoramaView(next)
    viewRef.current = normalized
    onViewChange?.(normalized)
  }, [onViewChange])

  useImperativeHandle(forwardedRef, () => ({
    ready: () => Boolean(runtimeRef.current?.textureReady && !flat),
    capture: async ({ width, height }) => {
      const runtime = runtimeRef.current
      if (!runtime?.textureReady || flat) throw new Error(flat ? '请先返回球面查看再截取机位' : '全景纹理尚未加载完成')
      const captureWidth = Math.max(16, Math.round(Number(width) || 0))
      const captureHeight = Math.max(16, Math.round(Number(height) || 0))
      const currentView = normalizePanoramaView(viewRef.current)
      const currentExposure = clampPanoramaExposure(exposureRef.current)
      const previousAspect = runtime.camera.aspect
      const previousPixelRatio = runtime.renderer.getPixelRatio()
      try {
        runtime.renderer.setPixelRatio(1)
        runtime.renderer.setSize(captureWidth, captureHeight, false)
        runtime.camera.aspect = captureWidth / captureHeight
        runtime.camera.fov = currentView.fov
        runtime.camera.updateProjectionMatrix()
        runtime.material.uniforms.exposure.value = currentExposure
        runtime.renderer.render(runtime.scene, runtime.camera)
        runtime.renderer.getContext().finish()
        return {
          blob: await canvasToBlob(runtime.renderer.domElement),
          width: captureWidth,
          height: captureHeight,
          view: currentView,
          exposure: currentExposure,
        }
      } finally {
        runtime.renderer.setPixelRatio(previousPixelRatio)
        runtime.camera.aspect = previousAspect
        runtime.camera.updateProjectionMatrix()
        runtime.resize()
      }
    },
  }), [flat])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !url || flat) {
      runtimeRef.current = null
      setLoading(false)
      setError('')
      return
    }
    setLoading(true)
    setError('')

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(viewRef.current.fov, 1, 0.1, 1100)
    camera.position.set(0, 0, 0.01)
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.NoToneMapping
    renderer.toneMappingExposure = 1
    renderer.domElement.className = 'panorama-viewer-canvas'
    renderer.domElement.setAttribute('aria-label', '360度全景查看器')
    host.appendChild(renderer.domElement)

    const geometry = new THREE.SphereGeometry(100, 64, 40)
    geometry.scale(-1, 1, 1)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        panoramaMap: { value: null },
        exposure: { value: exposureRef.current },
      },
      vertexShader: PANORAMA_VERTEX_SHADER,
      fragmentShader: PANORAMA_FRAGMENT_SHADER,
      side: THREE.FrontSide,
      toneMapped: false,
    })
    const sphere = new THREE.Mesh(geometry, material)
    scene.add(sphere)

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const runtime: RendererRuntime = { renderer, scene, camera, material, textureReady: false, resize }
    runtimeRef.current = runtime

    let disposed = false
    let texture: THREE.Texture | undefined
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    loader.load(
      url,
      (loadedTexture) => {
        if (disposed) {
          loadedTexture.dispose()
          return
        }
        texture = loadedTexture
        texture.colorSpace = THREE.NoColorSpace
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        material.uniforms.panoramaMap.value = texture
        material.needsUpdate = true
        runtime.textureReady = true
        setLoading(false)
      },
      undefined,
      () => {
        if (disposed) return
        setLoading(false)
        setError('全景图片加载失败，请确认资源仍然可访问')
      },
    )

    resize()
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
    resizeObserver?.observe(host)
    window.addEventListener('resize', resize)

    let frameId = 0
    const target = new THREE.Vector3()
    const render = () => {
      frameId = requestAnimationFrame(render)
      const current = viewRef.current
      camera.fov = current.fov
      camera.updateProjectionMatrix()
      const phi = THREE.MathUtils.degToRad(90 - current.pitch)
      const theta = THREE.MathUtils.degToRad(current.yaw)
      target.setFromSphericalCoords(1, phi, theta)
      camera.lookAt(target)
      material.uniforms.exposure.value = exposureRef.current
      renderer.render(scene, camera)
    }
    render()

    let dragging = false
    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    let startYaw = 0
    let startPitch = 0
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      event.stopPropagation()
      dragging = true
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      startYaw = viewRef.current.yaw
      startPitch = viewRef.current.pitch
      renderer.domElement.classList.add('is-dragging')
      renderer.domElement.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || pointerId !== event.pointerId) return
      event.stopPropagation()
      updateView({
        ...viewRef.current,
        yaw: startYaw - (event.clientX - startX) * 0.18,
        pitch: startPitch + (event.clientY - startY) * 0.14,
      })
    }
    const endDrag = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return
      event.stopPropagation()
      dragging = false
      pointerId = null
      renderer.domElement.classList.remove('is-dragging')
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      updateView({ ...viewRef.current, fov: viewRef.current.fov + event.deltaY * 0.025 })
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', endDrag)
    renderer.domElement.addEventListener('pointercancel', endDrag)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      disposed = true
      runtimeRef.current = null
      cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', endDrag)
      renderer.domElement.removeEventListener('pointercancel', endDrag)
      renderer.domElement.removeEventListener('wheel', onWheel)
      texture?.dispose()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [flat, updateView, url])

  return (
    <div ref={hostRef} className={`panorama-viewer-host${flat ? ' is-flat' : ''} ${className}`.trim()}>
      {!url && <div className="panorama-viewer-state"><span>{emptyMessage}</span></div>}
      {url && flat && (
        <img
          className="panorama-viewer-flat-image"
          src={url}
          alt="2:1 ERP 全景平铺原图"
          draggable={false}
          onLoad={() => { setLoading(false); setError('') }}
          onError={() => { setLoading(false); setError('全景图片加载失败，请确认资源仍然可访问') }}
        />
      )}
      {loading && <div className="panorama-viewer-state"><Loader2 size={22} className="is-spinning" /><span>正在加载全景原图</span></div>}
      {error && <div className="panorama-viewer-state is-error">{error}</div>}
      {url && grid && !flat && <div className="panorama-viewer-grid" aria-hidden="true" />}
      {url && help && <div className="panorama-viewer-help">{flat ? '2:1 ERP 平铺原图 · 切回球面继续环视' : help}</div>}
    </div>
  )
})
