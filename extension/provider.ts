/**
 * yu-agent — Provider 抽象层
 *
 * 封装 DeepSeek API 调用，提供统一的 Provider 接口。
 * Phase 1-2 仅 non-streaming，Phase 3 Web UI 做 streaming。
 */

import { createLogger } from './logger.js'

const _log = createLogger('provider')

import { AGENT_TYPES } from './config.js'
import { chatCompletion as dsChat } from './deepseek.js'

// ── Types ───────────────────────────────────────────────

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

export interface ProviderRequest {
  messages: ProviderMessage[]
  max_tokens?: number
  temperature?: number
}

export interface ProviderResponse {
  content: string | null
  finish_reason: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ApiClient {
  chatCompletion(req: ProviderRequest): Promise<ProviderResponse | null>
}

// ── Config ──────────────────────────────────────────────

export async function getApiKey(): Promise<string | null> {
  // 环境变量优先
  const envKey = process.env.DEEPSEEK_API_KEY
  if (envKey?.trim()) return envKey.trim()

  try {
    const home = process.env.HOME || process.env.USERPROFILE || '/home/saltfish'
    const configPath = `${home}/.yu/config.json`
    const configFile = Bun.file(configPath)
    const exists = await configFile.exists()
    if (exists) {
      const raw = await configFile.text()
      const config = JSON.parse(raw)
      const key = config?.apiKeys?.deepseek
      if (key && typeof key === 'string' && key.trim()) return key.trim()
    }
  } catch {
    // 静默失败
  }

  return null
}

export function getModel(agentType: string): string {
  const cfg = AGENT_TYPES[agentType]
  if (cfg?.model) return cfg.model
  return 'deepseek-chat'
}

// ── Provider ────────────────────────────────────────────

export async function chatCompletion(request: ProviderRequest): Promise<ProviderResponse | null> {
  const result = await dsChat({
    model: 'deepseek-chat',
    messages: request.messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : (m.role as 'system' | 'user' | 'assistant'),
      content: m.content,
    })),
    max_tokens: request.max_tokens ?? 4096,
    temperature: request.temperature ?? 0,
  })

  if (!result) return null

  return {
    content: result.choices?.[0]?.message?.content ?? null,
    finish_reason: result.choices?.[0]?.finish_reason ?? 'stop',
    usage: result.usage,
  }
}

// ── MockApiClient（用于测试）──────────────────────────────

export function createMockClient(responses: Map<string, string>): ApiClient {
  return {
    async chatCompletion(req: ProviderRequest): Promise<ProviderResponse | null> {
      const lastMsg = req.messages[req.messages.length - 1]
      for (const [pattern, response] of responses) {
        if ((lastMsg?.content ?? '').includes(pattern)) {
          return { content: response, finish_reason: 'stop' }
        }
      }
      return { content: 'Mock fallback response', finish_reason: 'stop' }
    },
  }
}
