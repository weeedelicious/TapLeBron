/**
 * 裁剪弹窗的 2K / 4K 等比输出。
 *
 * 做法对齐 Cropper.js getCroppedCanvas 的官方示例：按裁剪框长边缩放到目标边长，
 * 宽高一起乘同一个系数，比例不变。这是画布重采样，不是 AI 超分。
 *
 * 2K = 长边 2048，4K = 长边 4096（与上传压缩上限 MAX_IMAGE_DIMENSION 一致）。
 */

export type CropOutputScale = 'original' | '2k' | '4k'

export const CROP_OUTPUT_MAX_EDGE = 4096

export const CROP_OUTPUT_SCALE_OPTIONS: Array<{
  key: CropOutputScale
  label: string
  longEdge: number
}> = [
  { key: 'original', label: '原尺寸', longEdge: 0 },
  { key: '2k', label: '2K', longEdge: 2048 },
  { key: '4k', label: '4K', longEdge: 4096 },
]

const LONG_EDGE_BY_SCALE: Record<Exclude<CropOutputScale, 'original'>, number> = {
  '2k': 2048,
  '4k': 4096,
}

export function cropOutputScaleLabel(scale: CropOutputScale) {
  return CROP_OUTPUT_SCALE_OPTIONS.find((option) => option.key === scale)?.label ?? '原尺寸'
}

export function cropOutputSize(
  cropWidth: number,
  cropHeight: number,
  scale: CropOutputScale,
) {
  const width = Math.max(1, Math.round(Number(cropWidth) || 0))
  const height = Math.max(1, Math.round(Number(cropHeight) || 0))
  const currentLongEdge = Math.max(width, height)
  if (scale === 'original' || currentLongEdge <= 0) {
    return {
      width,
      height,
      longEdge: currentLongEdge,
      scaled: false,
    }
  }

  const targetLongEdge = Math.min(LONG_EDGE_BY_SCALE[scale], CROP_OUTPUT_MAX_EDGE)
  const ratio = targetLongEdge / currentLongEdge
  let nextWidth = Math.max(1, Math.round(width * ratio))
  let nextHeight = Math.max(1, Math.round(height * ratio))
  const nextLongEdge = Math.max(nextWidth, nextHeight)
  if (nextLongEdge > CROP_OUTPUT_MAX_EDGE) {
    const cap = CROP_OUTPUT_MAX_EDGE / nextLongEdge
    nextWidth = Math.max(1, Math.round(nextWidth * cap))
    nextHeight = Math.max(1, Math.round(nextHeight * cap))
  }

  return {
    width: nextWidth,
    height: nextHeight,
    longEdge: Math.max(nextWidth, nextHeight),
    scaled: nextWidth !== width || nextHeight !== height,
  }
}

export function cropperCanvasOptions(
  size: { width: number; height: number },
  mimeType: string,
) {
  return {
    width: size.width,
    height: size.height,
    minWidth: 1,
    minHeight: 1,
    maxWidth: CROP_OUTPUT_MAX_EDGE,
    maxHeight: CROP_OUTPUT_MAX_EDGE,
    fillColor: mimeType === 'image/jpeg' ? '#fff' : undefined,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high' as const,
  }
}
