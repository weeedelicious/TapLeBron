/**
 * LLM service — OpenAI-compatible chat completions via llm-proxy.tapsvc.com
 * Supports streaming SSE, multimodal (image_url), gpt-5.5 quirks.
 */
import axios from 'axios'
import { config } from '../config'

const BASE_URL = config.llmBaseUrl || 'https://llm-proxy.tapsvc.com'
const API_KEY  = config.llmApiKey  || ''

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentItem[]
}

export interface ContentItem {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/**
 * Non-streaming chat completion — returns full response string.
 */
export async function chat(
  messages: ChatMessage[],
  model: string,
  maxTokens = 4096,
): Promise<string> {
  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
  }
  // gpt-5 series doesn't support temperature parameter
  if (!model.startsWith('gpt-5')) payload.temperature = 0.7

  const res = await axios.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 120_000,
  })
  const data = res.data
  if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error)}`)
  return data.choices?.[0]?.message?.content ?? ''
}

/**
 * Streaming chat completion — yields token deltas as they arrive.
 * Parses SSE `data:` lines from the response stream.
 */
export async function* chatStream(
  messages: ChatMessage[],
  model: string,
  signal?: AbortSignal,
  maxTokens = 4096,
): AsyncGenerator<string> {
  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
  }
  if (!model.startsWith('gpt-5')) payload.temperature = 0.7

  const res = await axios.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    responseType: 'stream',
    timeout: 300_000,
    signal,
  })

  let buf = ''
  for await (const chunk of res.data) {
    buf += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8')
    // Process complete SSE lines
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''   // keep incomplete last line in buffer
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const raw = trimmed.slice(5).trim()
      if (raw === '[DONE]') return
      try {
        const parsed = JSON.parse(raw)
        const delta: string = parsed.choices?.[0]?.delta?.content ?? ''
        if (delta) yield delta
      } catch {
        // malformed chunk — skip
      }
    }
  }
}
