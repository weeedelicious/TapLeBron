import { useEffect, useRef } from 'react'
import { directionalLightFootprint, lightDirection } from './lightMath'
import type { LightStageLightConfig, LightStageState } from './types'

interface LightStageMaskPreviewProps {
  normalUrl?: string
  state: LightStageState
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function colorLuminance(color: string) {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff'
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return clamp01(r * 0.2126 + g * 0.7152 + b * 0.0722)
}

function attenuationRatio(light: LightStageLightConfig) {
  const value = Number(light.attenuation)
  return clamp01((Number.isFinite(value) ? value : 48) / 100)
}

function footprint(light: LightStageLightConfig, u: number, v: number) {
  if (light.type === 'directional') return directionalLightFootprint(light, u, v)
  const anchor = lightDirection(light.anchor, light.rotation, light.direction)
  const centerX = clamp01(0.5 + anchor.x * 0.18 + light.offset.x / 250)
  const centerY = clamp01(0.5 - anchor.y * 0.18 - light.offset.y / 250)
  const dx = u - centerX
  const dy = v - centerY
  const attenuation = attenuationRatio(light)
  if (light.type === 'area') {
    const reachScale = 1.22 - attenuation * 0.64
    const halfWidth = (0.12 + light.width / 150) * reachScale
    const halfHeight = (0.12 + light.height / 150) * reachScale
    const edge = Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight)
    const edgeLimit = 1.44 - attenuation * 0.58
    const feather = Math.max(0.045, (0.15 + light.softness / 125) * (1.12 - attenuation * 0.42))
    return clamp01((edgeLimit - edge) / feather)
  }
  const distance = Math.hypot(dx, dy)
  if (light.type === 'spot') {
    const radius = (0.12 + light.coneAngle / 150) * (1.22 - attenuation * 0.62)
    const feather = Math.max(0.025, (0.03 + light.softness / 180) * (1.1 - attenuation * 0.35))
    return clamp01((radius - distance) / feather)
  }
  const radius = 0.2 + (100 - light.attenuation) / 120
  return clamp01(1 - distance / radius)
}

function contribution(light: LightStageLightConfig, nx: number, ny: number, nz: number, u: number, v: number) {
  if (!light.enabled || light.intensity <= 0) return 0
  const vector = lightDirection(light.anchor, light.rotation, light.direction)
  const dot = Math.max(0, nx * vector.x + ny * vector.y + nz * vector.z)
  const base = dot * (light.intensity / 100) * (0.55 + colorLuminance(light.color) * 0.45)
  return base * footprint(light, u, v)
}

export function LightStageMaskPreview({ normalUrl, state }: LightStageMaskPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    const paintBlack = () => {
      const context = canvas.getContext('2d')
      if (!context) return
      context.fillStyle = '#000'
      context.fillRect(0, 0, Math.max(1, canvas.width), Math.max(1, canvas.height))
    }
    if (!normalUrl) {
      canvas.width = 2
      canvas.height = 2
      paintBlack()
      return
    }

    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled) return
      const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.max(2, Math.round(image.naturalWidth * scale))
      const height = Math.max(2, Math.round(image.naturalHeight * scale))
      const source = document.createElement('canvas')
      source.width = width
      source.height = height
      const sourceContext = source.getContext('2d', { willReadFrequently: true })
      canvas.width = width
      canvas.height = height
      const outputContext = canvas.getContext('2d')
      if (!sourceContext || !outputContext) return
      sourceContext.drawImage(image, 0, 0, width, height)
      const normals = sourceContext.getImageData(0, 0, width, height)
      const output = outputContext.createImageData(width, height)
      const ambient = state.ambient.enabled
        ? (state.ambient.intensity / 100) * (0.55 + colorLuminance(state.ambient.color) * 0.45)
        : 0
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4
          const nx = normals.data[index] / 127.5 - 1
          const ny = normals.data[index + 1] / 127.5 - 1
          const nz = normals.data[index + 2] / 127.5 - 1
          const u = x / Math.max(1, width - 1)
          const v = y / Math.max(1, height - 1)
          let value = ambient
          value += contribution(state.main, nx, ny, nz, u, v)
          value += contribution(state.fill, nx, ny, nz, u, v)
          if (state.rimLight && (state.main.enabled || state.fill.enabled)) value += (1 - Math.abs(nz)) * 0.22
          const channel = Math.round(clamp01(value) * 255)
          output.data[index] = channel
          output.data[index + 1] = channel
          output.data[index + 2] = channel
          output.data[index + 3] = 255
        }
      }
      outputContext.putImageData(output, 0, 0)
    }
    image.onerror = () => {
      canvas.width = 2
      canvas.height = 2
      paintBlack()
    }
    image.src = normalUrl
    return () => { cancelled = true }
  }, [normalUrl, state.ambient, state.fill, state.main, state.rimLight])

  return <canvas ref={canvasRef} className="light-stage-mask-preview" aria-label="Dynamic light range mask" />
}
