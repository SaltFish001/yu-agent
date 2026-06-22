/**
 * yu-agent — Agent type configuration.
 *
 * Defines the 7 custom sub-agent types.
 * Each type has a default model, thinking level, tool set, and system prompt.
 *
 * Phase 3: Pi SDK removed. Agent types are now registered in-memory
 * via bootstrap.ts instead of through pi-subagents.
 */

import { createLogger } from './logger.js'

const log = createLogger('config')

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'
import { MCP_CONFIG_PATH, PROMPTS_DIR, YU_HOME } from './paths.js'

// ── MCP config schema ─────────────────────────────────

const McpServerConfigSchema = z.object({
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const McpConfigSchema = z.object({
  servers: z.record(z.string(), McpServerConfigSchema),
})

export type McpConfig = z.infer<typeof McpConfigSchema>

/**
 * Validate ~/.yu/mcp.config.json at startup.
 * On failure, prints a clear error and exits the process.
 */
export function validateMcpConfig(): void {
  if (!existsSync(MCP_CONFIG_PATH)) {
    return // no config is fine
  }

  let raw: string
  try {
    raw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
  } catch (err) {
    log.error(`Failed to read ${MCP_CONFIG_PATH}`, err)
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.error(`${MCP_CONFIG_PATH} is not valid JSON`, err)
    process.exit(1)
  }

  const result = McpConfigSchema.safeParse(parsed)
  if (!result.success) {
    log.error(`${MCP_CONFIG_PATH} failed validation:`)
    for (const issue of result.error.issues) {
      log.error(`  - ${issue.path.join('.')}: ${issue.message}`)
    }
    process.exit(1)
  }
}

/**
 * Validate environment variables at startup.
 * Checks:
 *  - All env vars referenced by MCP server configs (mcp.config.json)
 *  - PI_PROVIDER (warn if not set)
 *
 * Returns errors (missing required vars) and warnings (missing optional vars).
 */
export function validateEnvVars(mcpConfig?: { servers?: Record<string, { env?: Record<string, string> }> }): {
  errors: string[]
  warnings: string[]
} {
  const needed = new Set<string>()
  const errors: string[] = []
  const warnings: string[] = []

  if (mcpConfig?.servers) {
    for (const [_name, cfg] of Object.entries(mcpConfig.servers)) {
      if (cfg.env) {
        for (const [key, val] of Object.entries(cfg.env)) {
          // If value is empty or a template reference like "${VAR}", mark the key as needed
          if (!val || val.startsWith('${')) {
            needed.add(key)
          }
        }
      }
    }
  }

  for (const key of needed) {
    if (!process.env[key]) {
      errors.push(`Required env var ${key} is not set (used by MCP server config)`)
    }
  }

  if (!process.env.PI_PROVIDER) {
    warnings.push('PI_PROVIDER not set — yu-agent will use Pi default provider')
  }

  // Check common API key conventions (keys containing KEY, TOKEN, SECRET, PASSWORD)
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase()
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(upper)) {
      const val = process.env[key]
      if (!val || val.trim() === '' || val === 'your-key-here' || val === 'sk-placeholder') {
        warnings.push(`${key} appears to be an API key but is empty or placeholder`)
      }
    }
  }

  return { errors, warnings }
}

// ── Resource limits ───────────────────────────────────

export interface ResourceLimits {
  maxConcurrentAgents?: number // default: 8
  maxPerPool?: number // default: 4
  defaultAgentTimeout?: number // default: 120000 (120s)
}

// ── General application config ─────────────────────────

/**
 * Full application configuration read from ~/.yu/config.json.
 */
export interface AppConfig {
  identity?: {
    /** @deprecated Personality is removed — yu-agent is a professional assistant. */
    personalityPath?: string
  }
  /**
   * Resource limits for agent execution.
   */
  resourceLimits?: ResourceLimits
}

const APP_CONFIG_PATH = resolve(YU_HOME, 'config.json')

let _appConfig: AppConfig | null = null

/**
 * Load ~/.yu/config.json (cached after first call).
 * Returns an empty object if the file doesn't exist or is invalid.
 */
export function loadAppConfig(): AppConfig {
  if (_appConfig) return _appConfig
  try {
    if (existsSync(APP_CONFIG_PATH)) {
      const raw = readFileSync(APP_CONFIG_PATH, 'utf-8')
      _appConfig = JSON.parse(raw) as AppConfig
      return _appConfig
    }
  } catch (err) {
    log.warn('Failed to load app config, using defaults', err)
  }
  _appConfig = {}
  return _appConfig
}

// ── Agent type definition ─────────────────────────────

export interface AgentTypeConfig {
  displayName: string
  description: string
  model: string
  thinking: 'max' | 'high' | 'medium' | 'low'
  maxTurns: number
  builtinToolNames: string[]
  systemPrompt: string
}

// ── Prompt loader ──────────────────────────────────────

function loadPrompt(name: string): string {
  try {
    const path = resolve(PROMPTS_DIR, `${name}.md`)
    const content = readFileSync(path, 'utf-8')
    return content
  } catch (err) {
    log.warn(`Prompt file not found for agent type "${name}", using fallback`, err)
    return `You are a ${name} agent. Complete the assigned task.`
  }
}

// ── Agent type definitions ─────────────────────────────

/**
 * 模型路由策略：
 *   v4-flash — 快/便宜，用于简单任务（review, search, doc, lsp, commit 等）
 *   v4-pro   — 强/贵，用于复杂任务（coding, plan, team）
 */
export const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  coding: {
    displayName: 'Coding Agent',
    description: '编写和修改代码',
    model: 'v4-pro',
    thinking: 'max',
    maxTurns: 50,
    builtinToolNames: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'],
    systemPrompt: loadPrompt('coding'),
  },

  review: {
    displayName: 'Review Agent',
    description: '审查代码，只读不改',
    model: 'v4-flash',
    thinking: 'max',
    maxTurns: 30,
    builtinToolNames: ['read', 'grep', 'find', 'ls'],
    systemPrompt: loadPrompt('review'),
  },

  plan: {
    displayName: 'Plan Agent',
    description: '出技术方案，只读不改',
    model: 'v4-pro',
    thinking: 'max',
    maxTurns: 30,
    builtinToolNames: ['read', 'grep', 'find', 'ls'],
    systemPrompt: loadPrompt('plan'),
  },

  lsp: {
    displayName: 'LSP Agent',
    description: 'LSP 诊断与自动修复',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 20,
    builtinToolNames: ['bash'],
    systemPrompt: loadPrompt('lsp'),
  },

  commit: {
    displayName: 'Commit Agent',
    description: 'git commit',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 10,
    builtinToolNames: ['bash'],
    systemPrompt: loadPrompt('commit'),
  },

  doc: {
    displayName: 'Doc Agent',
    description: '生成文档',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 20,
    builtinToolNames: ['read', 'edit'],
    systemPrompt: loadPrompt('doc'),
  },

  search: {
    displayName: 'Search Agent',
    description: '语义代码搜索 (CodeGraph) + 网页搜索',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 15,
    builtinToolNames: ['bash', 'read', 'grep'],
    systemPrompt: loadPrompt('search'),
  },

  chat: {
    displayName: 'Chat Agent',
    description: '非编程类对话与问答',
    model: 'v4-flash',
    thinking: 'max',
    maxTurns: 10,
    builtinToolNames: ['read', 'grep', 'find', 'bash'],
    systemPrompt: loadPrompt('chat'),
  },

  'general-purpose': {
    displayName: 'General Purpose Agent',
    description: '通用意图识别与任务分发',
    model: 'v4-flash',
    thinking: 'max',
    maxTurns: 3,
    builtinToolNames: [],
    systemPrompt: loadPrompt('scheduler'),
  },
}

/** Get all registered agent type names. */
export function getAgentTypeNames(): string[] {
  return Object.keys(AGENT_TYPES)
}

/** Get agent type config by name (case-insensitive displayName also supported). */
export function getAgentTypeConfig(name: string): AgentTypeConfig | undefined {
  // Try internal name first (case-insensitive)
  const key = Object.keys(AGENT_TYPES).find((k) => k.toLowerCase() === name.toLowerCase())
  if (key) return AGENT_TYPES[key]
  // Fall back to displayName search (first match)
  return Object.values(AGENT_TYPES).find((cfg) => cfg.displayName.toLowerCase() === name.toLowerCase())
}

/**
 * Register all agent types (in-memory, no Pi dependency).
 * Phase 3: Pi SDK removed — this is now a no-op placeholder.
 * Agent types are available via AGENT_TYPES export and bootstrap.registerTypes().
 */
export function registerAgents(): void {
  log.info(`Agent types available: ${Object.keys(AGENT_TYPES).join(', ')} (Pi-free)`)
}
