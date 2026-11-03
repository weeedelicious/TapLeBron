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
function dataUrl(file) {
  return 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64')
}
;(async () => {
  const content = [
    { type: 'text', text: 'Describe each image separately in Chinese, concretely. Image A first, Image B second. Cover subject, age, pose, outfit, colors, line and render style, background, composition, visible text. Do not invent.' },
    { type: 'image_url', image_url: { url: dataUrl('/tmp/_ref_a.jpg') } },
    { type: 'image_url', image_url: { url: dataUrl('/tmp/_ref_b.jpg') } },
  ]
  const res = await axios.post(base + '/v1/chat/completions', {
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content }],
    max_tokens: 900,
  }, { headers: { Authorization: 'Bearer ' + key }, timeout: 90000 })
  const text = res.data.choices[0].message.content
  console.log(text)
})().catch((error) => {
  const msg = error.response && error.response.data ? JSON.stringify(error.response.data).slice(0, 500) : error.message
  console.log('FAIL ' + (error.response && error.response.status) + ' ' + msg)
  process.exit(1)
})
