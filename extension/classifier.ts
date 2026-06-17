/**
 * yu-agent — Intent classifier & scheduler plan types.
 *
 * Uses direct DeepSeek API call (not Pi SDK) for intent classification,
 * avoiding Pi SDK overhead and enabling response_format: json_object.
 */

import { createLogger } from './logger.js'

const log = createLogger('classifier')

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { callScheduler } from './deepseek.js'
import { PROMPTS_DIR } from './paths.js'
import { loadDecisions, trackAgent } from './tracker.js'

// ── Types ──────────────────────────────────────────────

export interface SchedulerPlan {
  pass_through?: boolean
  reasoning?: string
  intent?: string
  agents?: { type: string; model: string; id: string; files?: string[]; task?: string }[]
  parallel_groups?: string[][]
  dependencies?: Record<string, string[]>
}

// ── Prompt loader ──────────────────────────────────────

function loadSchedulerPrompt(): string {
  try {
    const path = resolve(PROMPTS_DIR, 'scheduler.md')
    if (!existsSync(path)) {
      log.warn('scheduler.md not found at', path)
      return ''
    }
    const content = readFileSync(path, 'utf-8')
    return content
  } catch (err) {
    log.warn('Failed to load scheduler prompt', err)
    return ''
  }
}

// ── Scheduler agent call ───────────────────────────────

export async function classifyIntent(userInput: string, _context: Record<string, unknown>): Promise<SchedulerPlan> {
  // Track the scheduler agent itself
  trackAgent('scheduler', 'running', {
    type: 'scheduler',
    model: 'v4-flash (direct)',
    goal: 'classify intent & generate plan',
  })

  // Fast path: full instructions pass through directly
  const trimmed = userInput.trim()
  if (trimmed.length > 200 || /^你是|^你是一个/.test(trimmed)) {
    trackAgent('scheduler', 'completed')
    log.info(`Scheduler: full instruction detected (${trimmed.length} chars), passing through`)
    return { pass_through: true, reasoning: 'input too long or role-play, no classification needed' }
  }

  // Load scheduler prompt
  const systemPrompt = loadSchedulerPrompt()
  if (!systemPrompt) {
    log.warn('Scheduler prompt empty, falling back to pass-through')
    trackAgent('scheduler', 'completed')
    return { pass_through: true, reasoning: 'scheduler prompt unavailable' }
  }

  // Add decisions context if available
  const decisions = loadDecisions()
  let enrichedInput = trimmed
  if (Array.isArray(decisions) && decisions.length > 0) {
    enrichedInput = `${trimmed}\n\nContext: ${JSON.stringify({ decisions })}`
  }

  // Call DeepSeek directly with response_format: json_object
  const result = await callScheduler(systemPrompt, enrichedInput)

  if (!result) {
    log.warn('DeepSeek scheduler returned no result, falling back to pass-through')
    trackAgent('scheduler', 'failed')
    return { pass_through: true, reasoning: 'DeepSeek API call failed' }
  }

  // Validate result
  const plan = result as SchedulerPlan
  if (plan.pass_through !== undefined || (plan.intent && plan.agents)) {
    trackAgent('scheduler', 'completed')
    return plan
  }

  log.warn('Scheduler returned invalid plan, falling back to pass-through', { result })
  trackAgent('scheduler', 'failed')
  return { pass_through: true, reasoning: 'scheduler returned invalid plan' }
}
