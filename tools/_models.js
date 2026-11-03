const fs = require('fs')
const envText = fs.readFileSync('/data/wyx_root/tapflow-workbench/.env', 'utf8')
for (const line of envText.split(/\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m || process.env[m[1]]) continue
  process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}
const axios = require('/data/wyx_root/tapflow-workbench/node_modules/axios')
const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY
const base = (process.env.LLM_BASE_URL || 'https://llm-proxy.tapsvc.com').replace(/\/+$/, '')
;(async () => {
  try {
    await axios.post(base + '/v1/chat/completions', { model: 'nope', messages: [{ role: 'user', content: 'hi' }] }, { headers: { Authorization: 'Bearer ' + key }, timeout: 30000 })
  } catch (error) {
    const msg = error.response && error.response.data && error.response.data.error && error.response.data.error.message || ''
    const i = msg.indexOf('models=')
    console.log(i >= 0 ? msg.slice(i, i + 2500) : msg.slice(0, 1500))
  }
})()
