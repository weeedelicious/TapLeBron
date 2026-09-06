const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024
const TARGET_IMAGE_UPLOAD_BYTES = 9 * 1024 * 1024
const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4096
const MIN_IMAGE_DIMENSION = 960
const QUALITY_STEPS = [0.92, 0.86, 0.8, 0.74, 0.68, 0.6, 0.52, 0.44]

function isVideoFile(file: File) {
  return String(file.type || '').startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name)
}

function replaceFileExtension(fileName: string, extension: string) {
  const trimmed = String(fileName || '').trim() || 'image'
  const dotIndex = trimmed.lastIndexOf('.')
  const baseName = dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed
  return `${baseName}${extension}`
}

function outputMimeType(file: File) {
  const type = String(file.type || '').toLowerCase()
  return type === 'image/jpeg' || type === 'image/jpg' ? 'image/jpeg' : 'image/webp'
}

function outputExtension(mimeType: string) {
  return mimeType === 'image/jpeg' ? '.jpg' : '.webp'
}

function canAutoCompressImage(file: File) {
  const type = String(file.type || '').toLowerCase()
  return type.startsWith('image/') && type !== 'image/gif' && type !== 'image/svg+xml'
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('图片加载失败'))
    }
    image.src = objectUrl
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('图片压缩失败'))
          return
        }
        resolve(blob)
      },
      mimeType,
      quality
    )
  })
}

async function compressOversizedImage(file: File) {
  const image = await loadImage(file)
  const outputType = outputMimeType(file)
  const targetName = replaceFileExtension(file.name, outputExtension(outputType))
  const maxSide = Math.max(image.naturalWidth || 1, image.naturalHeight || 1)
  const initialScale = Math.min(1, MAX_IMAGE_DIMENSION / maxSide)
  const minScale = Math.min(1, Math.max(MIN_IMAGE_DIMENSION / maxSide, 0.22))
  const scales: number[] = []

  let nextScale = initialScale
  for (let i = 0; i < 6; i += 1) {
    const normalizedScale = Number(nextScale.toFixed(4))
    if (!scales.includes(normalizedScale)) scales.push(normalizedScale)
    if (normalizedScale <= minScale) break
    nextScale = Math.max(minScale, nextScale * 0.84)
  }

  if (scales[scales.length - 1] !== minScale) {
    scales.push(Number(minScale.toFixed(4)))
  }

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { alpha: outputType !== 'image/jpeg' })
  if (!context) {
    throw new Error('浏览器当前无法处理图片压缩')
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  let bestBlob: Blob | null = null

  for (const scale of scales) {
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.width = width
    canvas.height = height

    if (outputType === 'image/jpeg') {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
    } else {
      context.clearRect(0, 0, width, height)
    }

    context.drawImage(image, 0, 0, width, height)

    for (const quality of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, outputType, quality)
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob
      if (blob.size <= TARGET_IMAGE_UPLOAD_BYTES) {
        return new File([blob], targetName, {
          type: blob.type || outputType,
          lastModified: file.lastModified || Date.now(),
        })
      }
    }
  }

  if (!bestBlob) {
    throw new Error('图片压缩失败')
  }

  return new File([bestBlob], targetName, {
    type: bestBlob.type || outputType,
    lastModified: file.lastModified || Date.now(),
  })
}

export async function prepareAssetForUpload(file: File) {
  if (isVideoFile(file) && file.size > MAX_VIDEO_UPLOAD_BYTES) {
    throw new Error('视频文件不能超过 100MB')
  }

  if (!canAutoCompressImage(file) || file.size <= MAX_IMAGE_UPLOAD_BYTES) {
    return file
  }

  const compressedFile = await compressOversizedImage(file)
  if (compressedFile.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error('图片压缩后仍超过 10MB，请先缩小尺寸后再上传')
  }

  return compressedFile
}
