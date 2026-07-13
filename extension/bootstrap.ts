/**
 * yu-agent — Bootstrap 模块
 *
 * 统一启动初始化。替代 extension/index.ts 中 Pi extension 的职责。
 * Phase 1b 从 index.ts 迁移至此。
 *
 * 调用顺序：
 *   1. injectApiKeys()   — 从 ~/.yu/config.json 注入 API key 到 env
 *   2. validateAll()     — 校验 MCP config + env vars
 *   3. registerTypes()   — 注册 agent type 定义
 *   4. startMCP()        — 启动 MCP server manager
 *   5. registerHooks()   — 注册 scheduler / 输入钩子
 */

import { createLogger } from './logger.js'

const log = createLogger('bootstrap')

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { AGENT_TYPES } from './config.js'
import { MCP_CONFIG_PATH } from './paths.js'
import { PROMPTS_DIR } from './paths.js'

// ── 1. API key 注入 ───────────────────────────────────────

/**
 * 从 ~/.yu/config.json 读取 API keys，注入到 process.env。
 * 不覆盖已有的环境变量。
 */
export function injectApiKeys(): void {
  try {
    const configPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'config.json')
    if (!existsSync(configPath)) {
      log.info('No ~/.yu/config.json found — skipping API key injection')
      return
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    const apiKeys = config.apiKeys as Record<string, string> | undefined
    if (!apiKeys) return

    for (const [key, value] of Object.entries(apiKeys)) {
      if (typeof value === 'string' && value.trim()) {
        const envKey = key.includes('_API_KEY')
          ? key.toUpperCase()
          : `${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`
        if (!process.env[envKey]) {
          process.env[envKey] = value.trim()
          log.info(`Injected API key: ${envKey}`)
        }
      }
    }

    // 特别处理 deepseek
    const dsKey = apiKeys.deepseek
    if (dsKey && typeof dsKey === 'string' && dsKey.trim() && !process.env.DEEPSEEK_API_KEY) {
      process.env.DEEPSEEK_API_KEY = dsKey.trim()
      log.info('DeepSeek API key loaded from ~/.yu/config.json')
    }
  } catch (err) {
    log.warn('API key injection failed (non-fatal)', err)
  }
}

// ── 2. 校验 ─────────────────────────────────────────────────

/**
 * MCP config 校验 + env var 校验。
 * 失败时打印错误但不退出（开机不因配置阻塞）。
 */
export function validateAll(): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  // 校验 MCP config（仅语法层面）
  if (existsSync(MCP_CONFIG_PATH)) {
    try {
      const raw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
      JSON.parse(raw) // 至少是合法 JSON
    } catch (err) {
      const msg = err instanceof SyntaxError ? 'Invalid JSON' : String(err)
      errors.push(`MCP config at ${MCP_CONFIG_PATH}: ${msg}`)
    }
  }

  // 校验必要的 API key 是否存在
  if (!process.env.DEEPSEEK_API_KEY) {
    warnings.push('DEEPSEEK_API_KEY not set. AgentLoop will fail at runtime.')
  }

  // 校验 MCP server 引用的 env vars
  if (existsSync(MCP_CONFIG_PATH)) {
    try {
      const mcpRaw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
      const mcpConfig = JSON.parse(mcpRaw) as {
        servers?: Record<string, { env?: Record<string, string> }>
      }
      if (mcpConfig?.servers) {
        for (const [name, cfg] of Object.entries(mcpConfig.servers)) {
          if (cfg.env) {
            for (const [key, val] of Object.entries(cfg.env)) {
              if (!val || val.startsWith('${')) {
                if (!process.env[key]) {
                  warnings.push(`MCP server "${name}" references env var "${key}" which is not set`)
                }
              }
            }
          }
        }
      }
    } catch {
      // 已在上一步校验
    }
  }

  if (errors.length > 0) {
    for (const err of errors) log.error(err)
  }
  if (warnings.length > 0) {
    for (const warn of warnings) log.warn(warn)
  }

  return { errors, warnings }
}

// ── 3. Agent type 注册 ─────────────────────────────────────

export interface AgentTypeRegistration {
  name: string
  displayName: string
  description: string
  model: string
  maxTurns: number
  builtinToolNames: string[]
  systemPrompt: string
}

/**
 * 注册所有 agent type 到内存注册表。
 * 返回注册列表供后续使用（Phase 3 传递给 Web UI / AgentLoop）。
 * 此函数不依赖 Pi SDK。
 */
export function registerTypes(): AgentTypeRegistration[] {
  const registrations: AgentTypeRegistration[] = []

  for (const [name, cfg] of Object.entries(AGENT_TYPES)) {
    registrations.push({
      name,
      displayName: cfg.displayName,
      description: cfg.description,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      builtinToolNames: cfg.builtinToolNames,
      systemPrompt: cfg.systemPrompt,
    })
  }

  log.info(`Registered ${registrations.length} agent types (Pi-free path)`)

  // Ensure prompts directory exists
  try {
    if (!existsSync(PROMPTS_DIR)) {
      mkdirSync(PROMPTS_DIR, { recursive: true })
      log.info(`Created prompts directory: ${PROMPTS_DIR}`)
    }
  } catch { /* non-critical */ }

  return registrations
}

// ── 4. MCP manager 启动 ────────────────────────────────────

let _mcpStarted = false

/**
 * 启动 MCP server manager（后台生命周期，独立于 chat）。
 * 幂等：多次调用只会启动一次。
 */
export async function startMCP(): Promise<void> {
  if (_mcpStarted) return
  _mcpStarted = true

  try {
    const { startMCPManager } = await import('./mcp-manager.js')
    await startMCPManager()
    log.info('MCP manager started')
  } catch (err) {
    log.warn('MCP manager start failed (non-fatal)', err)
  }
}

// ── 5. Scheduler hook 注册 ─────────────────────────────────

let _hooksRegistered = false

/**
 * 注册 scheduler 输入钩子。
 * 在独立模式下（非 Pi extension），直接注册到 yu run 流程。
 */
export function registerHooks(config?: { enabled?: boolean }): void {
  if (_hooksRegistered) return
  _hooksRegistered = true

  const hooksEnabled = config?.enabled ?? true
  if (!hooksEnabled) {
    log.info('Scheduler hooks disabled by config')
    return
  }

  // 钩子逻辑：通过 scheduler 执行计划
  // Phase 1b 暂为空注册 — Phase 3 连接 Web UI 时填充完整逻辑
  log.info('Scheduler hooks registered (placeholder — full wiring in Phase 3)')
}

// ── 6. Skills 加载 ──────────────────────────────────────

let _skillsLoaded = false

/**
 * 扫描并缓存所有可用技能（~/.yu/skills/ *.ts）。
 * 幂等：只会加载一次。
 */
export async function loadSkills(): Promise<string[]> {
  if (_skillsLoaded) return []
  _skillsLoaded = true

  try {
    const { scanSkills } = await import('./skills/registry.js')
    const skills = await scanSkills()
    const names = Array.from(skills.keys())
    log.info(`Loaded ${names.length} skills: ${names.join(', ') || '(none)'}`)
    return names
  } catch (err) {
    log.warn('Skill loading failed (non-fatal)', err)
    return []
  }
}

// ── 7. MCP 工具注册 ─────────────────────────────────────

let _mcpToolsRegistered = false

/**
 * 从已启动的 MCP server 注册工具到 ToolRegistry。
 * startMCP() 启动 manager 后调用此函数来注册工具。
 */
export async function registerMcpTools(): Promise<void> {
  if (_mcpToolsRegistered) return
  _mcpToolsRegistered = true

  try {
    const { startMcpToolRefresh } = await import('./tools/mcp-tools.js')
    startMcpToolRefresh()
    log.info('MCP tool refresh scheduled')
  } catch (err) {
    log.warn('MCP tool registration failed (non-fatal)', err)
  }
}

// ── 统一启动 ───────────────────────────────────────────────

export interface BootstrapResult {
  apiKeys: boolean
  validation: { errors: number; warnings: number }
  types: number
  mcp: boolean
  mcpTools: boolean
  skills: string[]
  hooks: boolean
}

/**
 * 一键启动所有初始化步骤。
 * 每一步独立失败不影响后续 — 最大弹性启动。
 */
export async function bootstrap(config?: {
  skipApiKeys?: boolean
  skipValidation?: boolean
  skipTypes?: boolean
  skipMCP?: boolean
  skipMcpTools?: boolean
  skipSkills?: boolean
  skipHooks?: boolean
}): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    apiKeys: false,
    validation: { errors: 0, warnings: 0 },
    types: 0,
    mcp: false,
    mcpTools: false,
    skills: [],
    hooks: false,
  }

  // 1. API key 注入
  if (!config?.skipApiKeys) {
    injectApiKeys()
    result.apiKeys = true
  }

  // 2. 校验
  if (!config?.skipValidation) {
    const v = validateAll()
    result.validation = { errors: v.errors.length, warnings: v.warnings.length }
  }

  // 3. Agent type 注册
  if (!config?.skipTypes) {
    const types = registerTypes()
    result.types = types.length
  }

  // 4. MCP manager（启动 server 进程）
  if (!config?.skipMCP) {
    await startMCP()
    result.mcp = true
  }

  // 5. MCP 工具注册（延迟 2s 让 server 初始化完）
  if (!config?.skipMcpTools) {
    await registerMcpTools()
    result.mcpTools = true
  }

  // 6. Skills 加载
  if (!config?.skipSkills) {
    const names = await loadSkills()
    result.skills = names
  }

  // 7. Hooks
  if (!config?.skipHooks) {
    registerHooks()
    result.hooks = true
  }

  log.info(
    `Bootstrap complete: ${result.types} types, ${result.skills.length} skills, ${result.validation.errors} errors, ${result.validation.warnings} warnings`,
  )
  return result
}
