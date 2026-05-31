import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { PROJECTS_DIR } from '../config'

const router = Router()
const execAsync = promisify(exec)
const upload = multer({ dest: path.join(PROJECTS_DIR, '_tmp') })

// ── Export all projects as a zip (uses PowerShell Compress-Archive) ────────
router.get('/export', async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const zipName = `sate-tv-backup-${timestamp}.zip`
  const zipPath = path.join(PROJECTS_DIR, '_tmp', zipName)

  try {
    // Ensure _tmp dir exists
    fs.mkdirSync(path.join(PROJECTS_DIR, '_tmp'), { recursive: true })

    // Use PowerShell Compress-Archive (Windows built-in)
    const src = PROJECTS_DIR.replace(/\\/g, '\\\\')
    const dst = zipPath.replace(/\\/g, '\\\\')
    await execAsync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${src}\\*' -DestinationPath '${dst}' -Force"`,
      { timeout: 120_000 }
    )

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`)

    const stream = fs.createReadStream(zipPath)
    stream.pipe(res)
    stream.on('end', () => {
      try { fs.unlinkSync(zipPath) } catch {}
    })
    stream.on('error', () => {
      try { fs.unlinkSync(zipPath) } catch {}
      if (!res.headersSent) res.status(500).json({ error: '读取压缩文件失败' })
    })
  } catch (e) {
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath) } catch {}
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: `导出失败: ${msg}` })
  }
})

// ── Import / restore from a zip (uses PowerShell Expand-Archive) ──────────
router.post('/import', upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' })

  // Rename to .zip so PowerShell recognizes it
  const zipPath = req.file.path + '.zip'
  fs.renameSync(req.file.path, zipPath)

  try {
    const dst = PROJECTS_DIR.replace(/\\/g, '\\\\')
    const src = zipPath.replace(/\\/g, '\\\\')
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${src}' -DestinationPath '${dst}' -Force"`,
      { timeout: 300_000 }
    )

    fs.unlinkSync(zipPath)

    // Count restored projects
    const count = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_')).length

    res.json({ ok: true, message: `已恢复，当前共 ${count} 个项目` })
  } catch (e) {
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath) } catch {}
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: `导入失败: ${msg}` })
  }
})

// ── Info ──────────────────────────────────────────────────────────────────
router.get('/info', (_req, res) => {
  try {
    let projectCount = 0, assetBytes = 0
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue
        projectCount++
        const assetsDir = path.join(PROJECTS_DIR, entry.name, 'assets')
        if (fs.existsSync(assetsDir)) {
          for (const f of fs.readdirSync(assetsDir)) {
            try { assetBytes += fs.statSync(path.join(assetsDir, f)).size } catch {}
          }
        }
      }
    }
    res.json({
      projectsDir: PROJECTS_DIR,
      projectCount,
      assetSizeMB: Math.round(assetBytes / 1024 / 1024 * 10) / 10,
    })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

export default router
