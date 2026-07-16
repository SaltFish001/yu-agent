/**
 * yu-agent — Direct DeepSeek API client.
 *
 * Used by the scheduler to avoid Pi SDK overhead.
 * DeepSeek chat completions with built-in response_format support.
 */

import { createLogger } from './logger.js'

const log = createLogger('deepseek')

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
const MODEL = 'deepseek-v4-flash'

// ── Types ───────────────────────────────────────────────

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface DeepSeekRequest {
  model: string
  messages: DeepSeekMessage[]
  response_format?: { type: 'json_object' }
  max_tokens?: number
  temperature?: number
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'high' | 'max'
}

export interface DeepSeekResponse {
  id: string
  choices: {
    index: number
    message: {
      role: 'assistant'
      content: string | null
      reasoning_content?: string | null
    }
    finish_reason: string
  }[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ── Config loading ──────────────────────────────────────

function loadConfig(): DeepSeekConfig | null {
  // 优先从 ~/.yu/config.json 读取，再 fallback 到环境变量
  try {
    const configPath = resolve(process.env.HOME || process.env.USERPROFILE || '/home/saltfish', '.yu', 'config.json')
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(raw)

      const apiKey = config?.apiKeys?.deepseek
      if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
        return {
          apiKey: apiKey.trim(),
          baseUrl: config?.deepseek?.baseUrl || DEEPSEEK_BASE,
          model: config?.deepseek?.model || MODEL,
        }
      }
      log.warn('apiKeys.deepseek is not configured in ~/.yu/config.json')
    }
  } catch (err) {
    log.warn('Failed to load DeepSeek config from ~/.yu/config.json', err)
  }

  // Fallback: 环境变量
  const envKey = process.env.DEEPSEEK_API_KEY
  if (envKey && typeof envKey === 'string' && envKey.trim()) {
    return {
      apiKey: envKey.trim(),
      baseUrl: process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE,
      model: process.env.DEEPSEEK_MODEL || MODEL,
    }
  }

  log.warn('DEEPSEEK_API_KEY not found in ~/.yu/config.json or environment')
  return null
}

// ── API call ────────────────────────────────────────────

export async function chatCompletion(request: DeepSeekRequest): Promise<DeepSeekResponse | null> {
  const cfg = loadConfig()
  if (!cfg) return null

  try {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      response_format: request.response_format,
      max_tokens: request.max_tokens ?? 1024,
      temperature: request.temperature ?? 0,
    }
    if (request.thinking?.type === 'enabled') {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = 'high'
      // thinking mode doesn't support temperature
      delete body.temperature
    }

    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      log.error(`DeepSeek API error: ${response.status}`, { body: text.slice(0, 500) })
      return null
    }

    const data = (await response.json()) as DeepSeekResponse
    return data
  } catch (err) {
    log.error('DeepSeek API call failed', err)
    return null
  }
}

/**
 * Convenience: call scheduler (system prompt + user input), get parsed JSON.
 * Uses response_format: json_object + prompt must contain "json".
 */
export async function callScheduler(systemPrompt: string, userInput: string): Promise<Record<string, unknown> | null> {
  const result = await chatCompletion({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userInput,
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1024,
    temperature: 0,
  })

  if (!result) return null

  const content = result.choices?.[0]?.message?.content
  if (!content) {
    log.warn('DeepSeek returned empty content (known JSON mode issue)')
    return null
  }

  try {
    return JSON.parse(content) as Record<string, unknown>
  } catch (_err) {
    log.warn('Failed to parse DeepSeek response as JSON', { content: content.slice(0, 500) })
    return null
  }
}
