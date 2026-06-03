import fs from 'fs'
import path from 'path'

interface Config {
  mivoBaseUrl: string
  mivoApiKey: string
  mivoUserId?: string
  llmBaseUrl?: string
  llmApiKey?: string
  port: number
  projectsDir: string
}

function loadConfig(): Config {
  const configPath = path.resolve(__dirname, '../../server/config.json')
  const examplePath = path.resolve(__dirname, '../../server/config.example.json')
  const p = fs.existsSync(configPath) ? configPath : examplePath
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

export const config = loadConfig()
export const PROJECTS_DIR = path.resolve(__dirname, '..', config.projectsDir ?? '../projects')
