/**
 * yu-agent — Skill runtime types
 *
 * Re-exports SkillDef from types.ts and adds runtime-specific types
 * for skill execution within the AgentLoop.
 */

import type { SkillDef } from '../types.js'

// Re-export for convenience
export type { SkillDef }

/**
 * A skill that has been loaded into memory and is ready to be mounted.
 */
export interface LoadedSkill {
  /** The skill definition (from types.ts). */
  def: SkillDef
  /**
   * Optional runtime hook called before each AgentLoop iteration.
   * Can modify the system prompt or inject additional context.
   */
  beforeIteration?: (context: SkillExecutionContext) => Promise<void> | void
  /**
   * Optional runtime hook called after each AgentLoop iteration.
   * Can inspect tool results and decide next actions.
   */
  afterIteration?: (context: SkillExecutionContext) => Promise<void> | void
}

/**
 * Context passed to skill hooks during AgentLoop execution.
 */
export interface SkillExecutionContext {
  /** Messages accumulated so far in the conversation. */
  messages: Array<{ role: string; content: string }>
  /** Current system prompt (skill can modify this). */
  systemPrompt: string
  /** Session/run metadata. */
  sessionId?: string
  /** Tool results from the last iteration. */
  lastToolResults?: Array<{ name: string; success: boolean; output: string }>
  /** Mutable bag for skill-to-skill data sharing. */
  shared: Map<string, unknown>
}

/**
 * Result from a skill execution pipeline.
 */
export interface SkillRunResult {
  success: boolean
  output: string
  skillsUsed: string[]
}
