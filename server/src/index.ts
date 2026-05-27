import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { config, PROJECTS_DIR } from './config'
import projectsRouter from './routes/projects'
import assetsRouter from './routes/assets'
import generateRouter from './routes/generate'
import toolboxRouter from './routes/toolbox'

const app = express()
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json({ limit: '50mb' }))

// Static file serving for assets
app.use('/assets', (req, res, next) => {
  // Strip leading slash and split into projectUuid / filename
  const parts = req.path.replace(/^\//, '').split('/')
  if (parts.length < 2) return next()
  const [projectUuid, ...rest] = parts
  const filePath = path.join(PROJECTS_DIR, projectUuid, 'assets', ...rest)
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    next()
  }
})

app.get('/api/health', (_req, res) => {
  const keyOk = !!config.mivoApiKey && !config.mivoApiKey.includes('YOUR_MIVO')
  res.json({ ok: true, apiKeyConfigured: keyOk })
})

app.use('/api/projects', projectsRouter)
app.use('/api/assets', assetsRouter)
app.use('/api/generate', generateRouter)
app.use('/api/tasks', generateRouter)  // poll endpoint is on generateRouter
app.use('/api/toolbox', toolboxRouter)

// Ensure projects dir exists
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true })
const tmpDir = path.join(PROJECTS_DIR, '_tmp')
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

app.listen(PORT, () => {
  console.log(`LibTV server running on http://localhost:${PORT}`)
  console.log(`Projects dir: ${PROJECTS_DIR}`)
})
