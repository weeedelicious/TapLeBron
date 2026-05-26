import crypto from 'crypto'
import fs from 'fs'

export function sha1File(filePath: string): string {
  const hash = crypto.createHash('sha1')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

export function sha1Buffer(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex')
}
