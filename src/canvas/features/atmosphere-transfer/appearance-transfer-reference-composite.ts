// Client-side deterministic reference-background compositor for the
// "直接使用参考图背景 · 原样保留" (reference-pixels / keep) path.
//
// Ported from the Dexis person-background-fusion skill snapshot. This path
// mattes the source subject with the current basic subject mask and lays it
// over the reference image's own pixels (centered cover-crop to the source
// dimensions). It NEVER calls an image model, never chains a continuation and
// never mutates the reference background outside the composite — so it cannot
// run away or explode nodes. Edge/hair fidelity is limited by the basic mask.
//
// - computeReferenceCoverCrop: pure cover-fit crop math (also used by the
//   reference thumbnail).
// - renderReferenceBackgroundCompositeFromUrls: the keep composite.
// - renderReferenceCleanupMaskFile: only the disabled remove/换Pose paths use
//   it; it still throws until those experimental flows are wired.

export interface ReferenceCoverCrop {
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
}

// Cover-fit: crop the largest centered region of (srcW×srcH) matching the
// target aspect (dstW×dstH), so the reference fills the target without distortion.
export function computeReferenceCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ReferenceCoverCrop {
  const sw = Math.max(1, sourceWidth)
  const sh = Math.max(1, sourceHeight)
  const tw = Math.max(1, targetWidth)
  const th = Math.max(1, targetHeight)
  const targetAspect = tw / th
  const sourceAspect = sw / sh
  let cropWidth = sw
  let cropHeight = sh
  if (sourceAspect > targetAspect) {
    // source wider than target → crop width
    cropWidth = Math.round(sh * targetAspect)
    cropHeight = sh
  } else {
    // source taller than target → crop height
    cropWidth = sw
    cropHeight = Math.round(sw / targetAspect)
  }
  return {
    sourceX: Math.max(0, Math.round((sw - cropWidth) / 2)),
    sourceY: Math.max(0, Math.round((sh - cropHeight) / 2)),
    sourceWidth: Math.min(sw, cropWidth),
    sourceHeight: Math.min(sh, cropHeight),
  }
}

function loadImage(url: string) {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.decoding = 'async'
  return new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`无法加载氛围迁移图片：${url}`))
    image.src = url
  })
}

function canvasToPngFile(canvas: HTMLCanvasElement, name: string) {
  return new Promise<File>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('浏览器无法编码合成 PNG。'))
        return
      }
      resolve(new File([blob], name, { type: 'image/png' }))
    }, 'image/png')
  })
}

// Deterministic composite: source subject (via basic mask alpha·luminance) laid
// over the reference background, at exactly width×height (the source dimensions).
export async function renderReferenceBackgroundCompositeFromUrls(options: {
  foregroundUrl: string
  backgroundUrl: string
  subjectMaskUrl: string
  width: number
  height: number
}) {
  const { foregroundUrl, backgroundUrl, subjectMaskUrl, width, height } = options
  if (width <= 0 || height <= 0) {
    throw new Error('合成尺寸必须为正数。')
  }
  const [foregroundImage, backgroundImage, subjectMaskImage] = await Promise.all([
    loadImage(foregroundUrl),
    loadImage(backgroundUrl),
    loadImage(subjectMaskUrl),
  ])

  // 1. Draw the source foreground at the exact target size.
  const foregroundCanvas = document.createElement('canvas')
  foregroundCanvas.width = width
  foregroundCanvas.height = height
  const foregroundContext = foregroundCanvas.getContext('2d', { willReadFrequently: true })
  if (!foregroundContext) throw new Error('浏览器无法创建前景画布。')
  foregroundContext.drawImage(foregroundImage, 0, 0, width, height)
  const foreground = foregroundContext.getImageData(0, 0, width, height)

  // 2. Multiply the foreground alpha by the subject mask (alpha·luminance) so
  //    only the detected subject survives; the edge stays soft for a natural cut.
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = width
  maskCanvas.height = height
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskContext) throw new Error('浏览器无法创建主体蒙版画布。')
  maskContext.drawImage(subjectMaskImage, 0, 0, width, height)
  const subjectMask = maskContext.getImageData(0, 0, width, height)
  for (let offset = 0; offset < foreground.data.length; offset += 4) {
    const maskAlpha = subjectMask.data[offset + 3] / 255
    const maskLuminance = (
      subjectMask.data[offset] +
      subjectMask.data[offset + 1] +
      subjectMask.data[offset + 2]
    ) / (3 * 255)
    foreground.data[offset + 3] = Math.round(
      foreground.data[offset + 3] * maskAlpha * maskLuminance,
    )
  }
  foregroundContext.clearRect(0, 0, width, height)
  foregroundContext.putImageData(foreground, 0, 0)

  // 3. Draw the reference background (centered cover-crop) then the masked
  //    subject on top. The reference pixels are preserved as-is.
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建合成画布。')
  const crop = computeReferenceCoverCrop(
    backgroundImage.naturalWidth,
    backgroundImage.naturalHeight,
    width,
    height,
  )
  context.drawImage(
    backgroundImage,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    width,
    height,
  )
  context.drawImage(foregroundCanvas, 0, 0, width, height)
  return canvasToPngFile(
    canvas,
    `appearance-reference-background-${width}x${height}.png`,
  )
}

// ---------------------------------------------------------------------------
// Experimental reference-pixels remove / replace-pose helpers
// (ported verbatim from the Dexis appearance-transfer skill snapshot).
// ---------------------------------------------------------------------------

function assertRgbaPixels(pixels: Uint8ClampedArray) {
  if (pixels.length % 4 !== 0) {
    throw new Error('Reference mask pixel data must contain complete RGBA pixels.')
  }
}

/**
 * Converts the existing basic subject mask into the mask convention used by
 * image-edit providers: transparent pixels may be regenerated, opaque pixels
 * must be preserved. The conversion deliberately remains soft at the detected
 * subject edge so the provider can reconstruct a natural boundary.
 */
export function createReferenceCleanupMaskPixels(
  subjectMaskPixels: Uint8ClampedArray,
) {
  assertRgbaPixels(subjectMaskPixels)
  const output = new Uint8ClampedArray(subjectMaskPixels.length)
  for (let offset = 0; offset < subjectMaskPixels.length; offset += 4) {
    const maskAlpha = subjectMaskPixels[offset + 3] / 255
    const maskLuminance = (
      subjectMaskPixels[offset] +
      subjectMaskPixels[offset + 1] +
      subjectMaskPixels[offset + 2]
    ) / 3
    const subjectStrength = maskAlpha * maskLuminance
    output[offset] = 255
    output[offset + 1] = 255
    output[offset + 2] = 255
    output[offset + 3] = Math.round(255 - subjectStrength)
  }
  return output
}

// Reference-subject cleanup mask (remove / replace-pose paths). Transparent =
// editable subject region, opaque = protected background — the exact contract
// the tapflow repaint route (normalizeRepaintConfig / hardCompositeRepaintBuffers)
// expects. Rendered at the reference image's own dimensions.
export async function renderReferenceCleanupMaskFile(
  referenceSubjectMaskUrl: string,
  width: number,
  height: number,
) {
  if (width <= 0 || height <= 0) {
    throw new Error('清理蒙版尺寸必须为正数。')
  }
  const maskImage = await loadImage(referenceSubjectMaskUrl)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建参考图清理蒙版。')
  context.drawImage(maskImage, 0, 0, width, height)
  const mask = context.getImageData(0, 0, width, height)
  const output = new ImageData(
    createReferenceCleanupMaskPixels(mask.data),
    width,
    height,
  )
  context.putImageData(output, 0, 0)
  return canvasToPngFile(
    canvas,
    `appearance-reference-cleanup-mask-${width}x${height}.png`,
  )
}

/**
 * Normalizes a generated reference-pose result back to the immutable source
 * dimensions. This is a deterministic center-cover crop; it never submits a
 * second model request and therefore cannot accumulate another generation pass.
 */
export async function renderImageCoverFileFromUrl(options: {
  imageUrl: string
  width: number
  height: number
  fileName?: string
}) {
  const { imageUrl, width, height, fileName } = options
  if (width <= 0 || height <= 0) {
    throw new Error('输出尺寸必须为正数。')
  }
  const image = await loadImage(imageUrl)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建结果尺寸回收画布。')
  const crop = computeReferenceCoverCrop(
    image.naturalWidth,
    image.naturalHeight,
    width,
    height,
  )
  context.drawImage(
    image,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    width,
    height,
  )
  return canvasToPngFile(
    canvas,
    fileName ?? `appearance-reference-pose-${width}x${height}.png`,
  )
}
