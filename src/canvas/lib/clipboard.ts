export async function writeTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // HTTP/local permission restrictions can reject the modern Clipboard API.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) throw new Error('copy failed')
}

function canvasToPngBlob(image: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return Promise.reject(new Error('no 2d context'))
  context.drawImage(image, 0, 0, width, height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

function pngBlobFromImageSync(image: HTMLImageElement) {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d context')
  context.drawImage(image, 0, 0)
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.split(',')[1] || ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: 'image/png' })
}

function blobToImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(blob)
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('image decode failed'))
    }
    image.src = objectUrl
  })
}

async function pngBlobFromDisplayedImage(image: HTMLImageElement | null, url: string) {
  if (image && image.naturalWidth > 0) {
    try {
      return pngBlobFromImageSync(image)
    } catch {
      try {
        return await canvasToPngBlob(image, image.naturalWidth, image.naturalHeight)
      } catch {
        // Tainted canvas or missing pixels; fall through to fetch.
      }
    }
  }

  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`fetch ${response.status}`)
  const blob = await response.blob()
  if (blob.type === 'image/png') return blob
  const decoded = await blobToImage(blob)
  return canvasToPngBlob(decoded, decoded.naturalWidth, decoded.naturalHeight)
}

export function copyDisplayedImageViaExecCommand(image: HTMLImageElement) {
  if (!(image instanceof HTMLImageElement) || image.naturalWidth <= 0) return false
  try {
    const blob = pngBlobFromImageSync(image)
    const file = new File([blob], 'image.png', { type: 'image/png' })
    let placed = false
    const onCopy = (event: ClipboardEvent) => {
      event.preventDefault()
      try {
        placed = Boolean(event.clipboardData?.items.add(file))
      } catch {
        placed = false
      }
    }
    document.addEventListener('copy', onCopy, true)
    try {
      if (document.execCommand('copy') && placed) return true
    } finally {
      document.removeEventListener('copy', onCopy, true)
    }
  } catch {
    // Canvas tainted / toDataURL blocked. Fall through to selecting the <img>.
  }

  const holder = document.createElement('div')
  holder.contentEditable = 'true'
  holder.setAttribute('contenteditable', 'true')
  holder.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden'
  const clone = document.createElement('img')
  clone.src = image.currentSrc || image.src
  clone.width = image.naturalWidth
  clone.height = image.naturalHeight
  holder.appendChild(clone)
  document.body.appendChild(holder)

  const selection = window.getSelection()
  if (!selection) {
    holder.remove()
    return false
  }
  const range = document.createRange()
  range.selectNode(clone)
  selection.removeAllRanges()
  selection.addRange(range)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    selection.removeAllRanges()
    holder.remove()
  }
  return copied
}

function canUseAsyncClipboard() {
  return Boolean(
    window.isSecureContext &&
    navigator.clipboard?.write &&
    typeof ClipboardItem === 'function',
  )
}

/**
 * Copy the current image onto the system clipboard.
 *
 * Chrome only keeps the click-gesture for clipboard.write if write() is called
 * in the same turn. Passing a Promise<Blob> into ClipboardItem lets us fetch /
 * transcode after that. Awaiting fetch before write() is why the viewer button
 * fell back to copying the URL.
 *
 * On HTTP (LAN Shotflow) clipboard.write is blocked; execCommand on the already
 * decoded <img> must run before any await.
 */
export async function writeImageToClipboard(
  url: string,
  image: HTMLImageElement | null = null,
): Promise<'image' | 'url'> {
  let writePromise: Promise<void> | null = null

  if (canUseAsyncClipboard()) {
    try {
      const pngPromise = pngBlobFromDisplayedImage(image, url)
      writePromise = navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })])
    } catch {
      writePromise = null
    }
  }

  const execCopied = image ? copyDisplayedImageViaExecCommand(image) : false
  if (execCopied) return 'image'

  if (writePromise) {
    try {
      await writePromise
      return 'image'
    } catch {
      // Fall through to URL copy.
    }
  }

  await writeTextToClipboard(url)
  return 'url'
}