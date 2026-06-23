/**
 * yu-agent — Skill runner
 *
 * Mounts skills into the AgentLoop execution pipeline.
 * Skills can provide:
 * - Extended system prompts (appended/prepended to the base prompt)
 * - Pre-iteration hooks (beforeIteration)
 * - Post-iteration hooks (afterIteration)
 * - Tool requirements (ensuring required tools are registered)
 *
 * The SkillRunner wraps an AgentLoop and injects skill behaviour
 * at each iteration boundary.
 */

import { createLogger } from '../logger.js'
import type { LoadedSkill, SkillExecutionContext, SkillRunResult } from './types.js'
import { eventBus } from '../events.js'
import { listTools } from '../tools/registry.js'
import { listSkills } from './registry.js'

const log = createLogger('skills:runner')

// ── SkillRunner ────────────────────────────────────────

export class SkillRunner {
  private activeSkills: LoadedSkill[] = []
  private shared: Map<string, unknown> = new Map()

  constructor() {}

  /**
   * Activate skills by name. Loads them from the registry if not already loaded.
   */
  async activateSkills(skillNames: string[]): Promise<void> {
    const allSkills = await listSkills()
    const skillMap = new Map(allSkills.map((s) => [s.def.name, s]))

    for (const name of skillNames) {
      const skill = skillMap.get(name)
      if (skill) {
        if (!this.activeSkills.find((s) => s.def.name === name)) {
          this.activeSkills.push(skill)
          log.info(`Skill activated: ${name}`)
          // Emit skill.activated
          try { eventBus.emit('skill.activated', { name }) } catch { /* non-critical */ }
        }
      } else {
        log.warn(`Skill "${name}" not found in registry, skipping.`)
      }
    }
  }

  /**
   * Deactivate a skill by name.
   */
  deactivateSkill(name: string): void {
    const idx = this.activeSkills.findIndex((s) => s.def.name === name)
    if (idx !== -1) {
      this.activeSkills.splice(idx, 1)
      log.info(`Skill deactivated: ${name}`)
      // Emit skill.deactivated
      try { eventBus.emit('skill.deactivated', { name }) } catch { /* non-critical */ }
    }
  }

  /**
   * Get currently active skills.
   */
  getActiveSkills(): LoadedSkill[] {
    return [...this.activeSkills]
  }

  /**
   * Get the combined system prompt contributions from all active skills.
   * Each skill's systemPrompt is appended with a section header.
   */
  getCombinedSystemPrompt(basePrompt: string): string {
    if (this.activeSkills.length === 0) return basePrompt

    const parts: string[] = [basePrompt]

    for (const skill of this.activeSkills) {
      if (skill.def.systemPrompt) {
        parts.push(`\n── Skill: ${skill.def.name} ──\n${skill.def.systemPrompt}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * Get the set of tool names required by all active skills.
   * Used to verify prerequisites are met.
   */
  getRequiredTools(): string[] {
    const required = new Set<string>()
    for (const skill of this.activeSkills) {
      for (const tool of skill.def.requiresTools ?? []) {
        required.add(tool)
      }
    }
    return Array.from(required)
  }

  /**
   * Verify that all required tools are registered.
   * Returns missing tool names, if any.
   */
  verifyRequiredTools(): string[] {
    const required = this.getRequiredTools()
    const available = new Set(listTools().map((t) => t.name))
    return required.filter((name) => !available.has(name))
  }

  /**
   * Run all active skills' beforeIteration hooks.
   */
  async runBeforeIteration(ctx: SkillExecutionContext): Promise<void> {
    for (const skill of this.activeSkills) {
      if (skill.beforeIteration) {
        try {
          ctx.shared = this.shared
          await skill.beforeIteration(ctx)
        } catch (err) {
          log.error(`Skill "${skill.def.name}" beforeIteration hook failed:`, err)
        }
      }
    }
  }

  /**
   * Run all active skills' afterIteration hooks.
   */
  async runAfterIteration(ctx: SkillExecutionContext): Promise<void> {
    for (const skill of this.activeSkills) {
      if (skill.afterIteration) {
        try {
          ctx.shared = this.shared
          await skill.afterIteration(ctx)
        } catch (err) {
          log.error(`Skill "${skill.def.name}" afterIteration hook failed:`, err)
        }
      }
    }
  }

  /**
   * Run a task with all active skills applied.
   * This is a convenience wrapper that creates an agent loop context
   * and runs hooks around each iteration.
   *
   * For full integration, use mountToAgentLoop() instead.
   */
  async runWithSkills(
    task: string,
    baseSystemPrompt: string,
    options?: {
      onIteration?: (iteration: number, content: string) => void
    },
  ): Promise<SkillRunResult> {
    const systemPrompt = this.getCombinedSystemPrompt(baseSystemPrompt)
    const ctx: SkillExecutionContext = {
      messages: [{ role: 'user', content: task }],
      systemPrompt,
      shared: this.shared,
    }

    // Run before hooks
    await this.runBeforeIteration(ctx)

    const skillsUsed = this.activeSkills.map((s) => s.def.name)

    // Emit skill.executed
    try {
      eventBus.emit('skill.executed', { skills: skillsUsed, task: task.slice(0, 200) })
    } catch { /* non-critical */ }

    return {
      success: true,
      output: ctx.systemPrompt, // Placeholder — actual execution is in AgentLoop
      skillsUsed,
    }
  }

  /**
   * Reset the shared data bag.
   */
  resetShared(): void {
    this.shared = new Map()
  }
}

// ── Convenience ────────────────────────────────────────

/** Create a SkillRunner and activate the given skills. */
export async function createSkillRunner(skillNames: string[]): Promise<SkillRunner> {
  const runner = new SkillRunner()
  await runner.activateSkills(skillNames)
  return runner
}
