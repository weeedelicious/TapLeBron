/**
 * Word 节点用的文档读取与原文件句柄。
 *
 * - 拖进画布的 .docx / .doc 在浏览器本地解析正文，不上传原文件。
 * - 浏览器支持 File System Access 时，拖入那一刻顺手拿到文件句柄并按节点 id 存进
 *   IndexedDB（shotflow-word-files），之后节点会每 2 秒对比修改时间，原文件改了就自动同步正文。
 *
 * .docx 是 zip：只取 word/document.xml，用浏览器自带的 deflate-raw 解压，不引第三方库。
 * .doc 是 OLE 复合文档：按 [MS-DOC] 的 piece table 读出正文。
 */

export type WordFileHandle = {
  kind?: string
  getFile: () => Promise<File>
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>
}

/** 拖入时拿到的句柄，按「文件名|大小|修改时间」临时记着，等建好节点再按节点 id 落库。 */
export const wordDropHandles = new Map<string, WordFileHandle>()
/** 节点 id → 原文件句柄（本次打开页面期间的缓存）。 */
export const wordNodeHandles = new Map<string, WordFileHandle>()
/** 节点 id → 上次同步时原文件的「修改时间:大小」，没变就不重复解析。 */
export const wordNodeStamps = new Map<string, string>()

export function isWordFile(file: File) {
  return /\.(docx|doc)$/i.test(file.name) || /wordprocessingml|msword/i.test(file.type || '')
}

export function wordDropKey(file: File) {
  return file.name + '|' + file.size + '|' + file.lastModified
}

async function inflateRaw(bytes: Uint8Array) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

/** 读 OLE 复合文档里的全部流，返回「流名 → 字节」。 */
function readOleStreams(bytes: Uint8Array): Record<string, Uint8Array> {
  if (u32(bytes, 0) !== 0xE011CFD0) throw new Error('这不是 Word 二进制文档')
  const sectorSize = 1 << u16(bytes, 0x1E)
  const miniSize = 1 << u16(bytes, 0x20)
  const dirStart = u32(bytes, 0x30)
  const miniCutoff = u32(bytes, 0x38)
  const miniFatStart = u32(bytes, 0x3C)
  const miniFatCount = u32(bytes, 0x40)
  const difatStart = u32(bytes, 0x44)
  const difatCount = u32(bytes, 0x48)

  const difat: number[] = []
  for (let i = 0; i < 109; i++) {
    const sid = u32(bytes, 0x4C + i * 4)
    if (sid === 0xFFFFFFFF) break
    difat.push(sid)
  }
  let next = difatStart
  let guard = 0
  while (next < 0xFFFFFFF0 && guard++ < difatCount + 2) {
    const offset = (next + 1) * sectorSize
    const entries = sectorSize / 4 - 1
    for (let i = 0; i < entries; i++) {
      const sid = u32(bytes, offset + i * 4)
      if (sid === 0xFFFFFFFF) break
      difat.push(sid)
    }
    next = u32(bytes, offset + entries * 4)
  }

  const fat: number[] = []
  for (const sid of difat) {
    const offset = (sid + 1) * sectorSize
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(bytes, offset + i * 4))
  }

  const readChain = (start: number, size: number) => {
    const out = new Uint8Array(size)
    let sid = start
    let written = 0
    let g = 0
    while (sid < 0xFFFFFFF0 && written < size && g++ < 100000) {
      const offset = (sid + 1) * sectorSize
      const n = Math.min(sectorSize, size - written)
      out.set(bytes.subarray(offset, offset + n), written)
      written += n
      sid = fat[sid]
    }
    return out
  }

  const sectors: Uint8Array[] = []
  let sid = dirStart
  let g = 0
  while (sid < 0xFFFFFFF0 && g++ < 100000) {
    const offset = (sid + 1) * sectorSize
    sectors.push(bytes.subarray(offset, offset + sectorSize))
    sid = fat[sid]
  }
  const dir = new Uint8Array(sectors.length * sectorSize)
  sectors.forEach((sector, i) => dir.set(sector, i * sectorSize))

  const entries: Array<{ name: string; type: number; start: number; size: number }> = []
  for (let i = 0; i < dir.length / 128; i++) {
    const o = i * 128
    const nameLen = u16(dir, o + 64)
    const type = dir[o + 66]
    if (!type) continue
    let name = ''
    const chars = Math.max(0, nameLen / 2 - 1)
    for (let c = 0; c < chars; c++) name += String.fromCharCode(u16(dir, o + c * 2))
    entries.push({ name, type, start: u32(dir, o + 116), size: u32(dir, o + 120) })
  }

  const root = entries[0]
  const miniFat: number[] = []
  sid = miniFatStart
  g = 0
  while (miniFatCount && sid < 0xFFFFFFF0 && g++ < miniFatCount + 5) {
    const offset = (sid + 1) * sectorSize
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(bytes, offset + i * 4))
    sid = fat[sid]
  }
  const miniStream = root && root.size ? readChain(root.start, root.size) : new Uint8Array(0)

  const readStream = (entry: { start: number; size: number }) => {
    if (entry.size < miniCutoff) {
      const out = new Uint8Array(entry.size)
      let s = entry.start
      let w = 0
      let gg = 0
      while (s < 0xFFFFFFF0 && w < entry.size && gg++ < 100000) {
        const offset = s * miniSize
        const n = Math.min(miniSize, entry.size - w)
        out.set(miniStream.subarray(offset, offset + n), w)
        w += n
        s = miniFat[s]
      }
      return out
    }
    return readChain(entry.start, entry.size)
  }

  const map: Record<string, Uint8Array> = {}
  for (const entry of entries) if (entry.type === 2) map[entry.name] = readStream(entry)
  return map
}

/** 去掉 .doc 正文里的域代码、表格单元标记等控制字符。 */
function cleanOleDocText(raw: string) {
  let text = raw.replace(/\r/g, '\n')
  text = text.replace(/[\u0002\u0005\u0008]/g, '')
  text = text.replace(/\u0007/g, '\t')
  text = text.replace(/[\u000b\u000c]/g, '\n')
  let previous
  do {
    previous = text
    text = text.replace(/\u0013[^\u0013\u0014\u0015]*\u0014?([^\u0013\u0014\u0015]*)\u0015/g, '$1')
  } while (text !== previous)
  return text.replace(/[\u0000-\u0008]/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

function extractOleDocText(bytes: Uint8Array) {
  const streams = readOleStreams(bytes)
  const word = streams.WordDocument
  if (!word || word.length < 0x1A8 || u16(word, 0) !== 0xA5EC) throw new Error('这份 .doc 缺少正文')
  const flags = u16(word, 0x0A)
  if (flags & 0x0100 || flags & 0x8000) throw new Error('这份 Word 有密码，读不到正文')
  const table = streams[(flags & 0x0200) ? '1Table' : '0Table']
  if (!table) throw new Error('这份 .doc 缺少正文')
  const ccpText = u32(word, 0x004c)
  if (!ccpText) return ''

  let pos = u32(word, 0x01a2)
  let guard = 0
  if (pos >= table.length) throw new Error('这份 .doc 缺少正文')
  while (guard++ < 1000 && pos < table.length) {
    const flag = table[pos]
    if (flag !== 1) break
    pos += 1
    if (pos + 2 > table.length) break
    const skip = u16(table, pos)
    pos += 2 + skip
  }
  if (pos >= table.length || table[pos] !== 2) throw new Error('这份 .doc 缺少正文')
  pos += 1
  if (pos + 4 > table.length) throw new Error('这份 .doc 缺少正文')
  const pieceTableSize = u32(table, pos)
  pos += 4
  const pieces = (pieceTableSize - 4) / 12
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 100000) throw new Error('这份 .doc 缺少正文')

  const lid = u16(word, 0x0006)
  const texts: string[] = []
  for (let x = 0; x < pieces; x++) {
    const offset = pos + ((pieces + 1) * 4) + (x * 8) + 2
    if (offset + 4 > table.length) throw new Error('这份 .doc 缺少正文')
    let start = u32(table, offset)
    let unicode = false
    if ((start & 0x40000000) === 0) unicode = true
    else start = (start & ~0x40000000) / 2
    const cpStart = u32(table, pos + x * 4)
    const cpEnd = u32(table, pos + (x + 1) * 4)
    const chars = cpEnd - cpStart
    const size = (unicode ? 2 : 1) * chars
    if (chars < 0 || start < 0 || start + size > word.length) throw new Error('这份 .doc 缺少正文')
    const slice = word.subarray(start, start + size)
    texts.push(unicode
      ? new TextDecoder('utf-16le').decode(slice)
      : lid === 0x404
        ? new TextDecoder('big5').decode(slice)
        : (lid === 0x804 || lid === 0x4 || flags & 0x4000)
          ? new TextDecoder('gbk').decode(slice)
          : new TextDecoder('windows-1252').decode(slice))
  }
  return cleanOleDocText(texts.join('').slice(0, ccpText))
}

async function extractDocxZipText(bytes: Uint8Array) {
  const decoder = new TextDecoder('utf-8')
  let eocd = -1
  const min = Math.max(0, bytes.length - (22 + 65535))
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('读不到 Word 正文，请使用 .docx')
  const count = u16(bytes, eocd + 10)
  let pos = u32(bytes, eocd + 16)
  let found: { method: number; comp: number; localOff: number } | null = null
  for (let i = 0; i < count && pos + 46 <= bytes.length; i++) {
    if (u32(bytes, pos) !== 0x02014b50) break
    const method = u16(bytes, pos + 10)
    const comp = u32(bytes, pos + 20)
    const nameLen = u16(bytes, pos + 28)
    const extraLen = u16(bytes, pos + 30)
    const commentLen = u16(bytes, pos + 32)
    const localOff = u32(bytes, pos + 42)
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)).split('\\').join('/')
    if (name === 'word/document.xml' || name.endsWith('/word/document.xml')) found = { method, comp, localOff }
    pos += 46 + nameLen + extraLen + commentLen
    if (found) break
  }
  if (!found) throw new Error('读不到 Word 正文，请使用 .docx')
  const local = found.localOff
  if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new Error('读不到 Word 正文，请使用 .docx')
  const localNameLen = u16(bytes, local + 26)
  const localExtraLen = u16(bytes, local + 28)
  const startAt = local + 30 + localNameLen + localExtraLen
  const endAt = startAt + found.comp
  if (endAt > bytes.length) throw new Error('读不到 Word 正文，请使用 .docx')
  const body = bytes.subarray(startAt, endAt)
  const xml = decoder.decode(found.method === 0 ? body : await inflateRaw(body))

  const parts: string[] = []
  const pattern = /<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g
  const decodeEntities = (value: string) => value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    if (match[1] != null) parts.push(decodeEntities(match[1]))
    else if (match[0] === '<w:tab/>') parts.push('\t')
    else parts.push('\n')
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

/** 读出 Word 正文；.docx 和老式 .doc 都认，按文件头判断格式。 */
export async function extractWordText(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75) return extractDocxZipText(bytes)
  if (bytes.length >= 8 && bytes[0] === 208 && bytes[1] === 207 && bytes[2] === 17 && bytes[3] === 224) return extractOleDocText(bytes)
  throw new Error('读不到 Word 正文')
}

function wordDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('shotflow-word-files', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('handles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function saveWordHandle(nodeId: string, handle: WordFileHandle) {
  wordDb()
    .then((db) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite')
      tx.objectStore('handles').put(handle, nodeId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }))
    .catch(() => {})
}

export function loadWordHandle(nodeId: string) {
  return wordDb()
    .then((db) => new Promise<WordFileHandle | null>((resolve, reject) => {
      const request = db.transaction('handles', 'readonly').objectStore('handles').get(nodeId)
      request.onsuccess = () => resolve((request.result as WordFileHandle | undefined) || null)
      request.onerror = () => reject(request.error)
    }))
    .catch(() => null)
}

/** 拖放事件里拿 Word 文件的句柄。必须在 drop 回调里同步阶段之后立刻调用，DataTransfer 过后就失效。 */
export async function captureWordDropHandles(dataTransfer: DataTransfer | null | undefined) {
  const items = [...(dataTransfer?.items || [])]
  for (const item of items) {
    const file = item.getAsFile?.()
    if (!file || !/\.docx?$/i.test(file.name)) continue
    try {
      const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<WordFileHandle | null> }).getAsFileSystemHandle
      const handle = getHandle ? await getHandle.call(item) : null
      if (handle && handle.kind === 'file') wordDropHandles.set(wordDropKey(file), handle)
    } catch {
      // 浏览器不支持或用户拒绝：节点退回「仅当前副本」，不影响导入。
    }
  }
}
