/**
 * yu-agent — Skill CLI command handler
 *
 * Handles `yu skill` subcommands:
 *   yu skill list                    List all loaded skills
 *   yu skill get <name>              Show skill details
 *   yu skill activate <name>         Activate a skill
 *   yu skill deactivate <name>       Deactivate a skill
 *   yu skill active                  Show active skills
 *   yu skill refresh                 Re-scan skills directory
 */

import { scanSkills, listSkills, getSkill, refreshSkills } from './registry.js'
import { SkillRunner } from './runner.js'

// ── Global singleton runner (for CLI-driven activation) ──

let _runner: SkillRunner | null = null

function getRunner(): SkillRunner {
  if (!_runner) {
    _runner = new SkillRunner()
  }
  return _runner
}

export async function skillCommand(sub: string, args: string[]): Promise<string> {
  switch (sub) {
    case 'list': {
      const skills = await listSkills()
      if (skills.length === 0) return 'No skills loaded.\nPlace .ts skill files in ~/.yu/skills/'

      const lines = skills.map(
        (s) => `  ${s.def.name} v${s.def.version} — ${s.def.description}`,
      )
      return `Loaded skills (${skills.length}):\n${lines.join('\n')}`
    }

    case 'get': {
      const name = args[0]
      if (!name) return 'Usage: yu skill get <name>'

      const skill = await getSkill(name)
      if (!skill) return `Skill not found: ${name}`

      const lines: string[] = [
        `  Name:        ${skill.def.name}`,
        `  Version:     ${skill.def.version}`,
        `  Description: ${skill.def.description}`,
      ]
      if (skill.def.systemPrompt) {
        lines.push(`  System prompt: ${skill.def.systemPrompt.slice(0, 200)}${skill.def.systemPrompt.length > 200 ? '...' : ''}`)
      }
      if (skill.def.requiresTools?.length) {
        lines.push(`  Requires tools: ${skill.def.requiresTools.join(', ')}`)
      }
      if (skill.def.providesTools?.length) {
        lines.push(`  Provides tools: ${skill.def.providesTools.join(', ')}`)
      }
      if (skill.beforeIteration) lines.push('  Has beforeIteration hook: yes')
      if (skill.afterIteration) lines.push('  Has afterIteration hook: yes')

      return lines.join('\n')
    }

    case 'activate': {
      const name = args[0]
      if (!name) return 'Usage: yu skill activate <name>'

      const runner = getRunner()
      await runner.activateSkills([name])
      return `Skill activated: ${name}`
    }

    case 'deactivate': {
      const name = args[0]
      if (!name) return 'Usage: yu skill deactivate <name>'

      const runner = getRunner()
      runner.deactivateSkill(name)
      return `Skill deactivated: ${name}`
    }

    case 'active': {
      const runner = getRunner()
      const active = runner.getActiveSkills()
      if (active.length === 0) return 'No skills currently active.'
      const lines = active.map((s) => `  ${s.def.name} v${s.def.version}`)
      return `Active skills (${active.length}):\n${lines.join('\n')}`
    }

    case 'refresh': {
      await refreshSkills()
      const skills = await listSkills()
      return `Skills refreshed. ${skills.length} skill(s) loaded.`
    }

    case 'help':
    default:
      return `yu skill — Skill management

Usage:
  yu skill list                    List all loaded skills
  yu skill get <name>              Show skill details
  yu skill activate <name>         Activate a skill (for current session)
  yu skill deactivate <name>       Deactivate a skill
  yu skill active                  Show currently active skills
  yu skill refresh                 Re-scan skills directory

Skill files: ~/.yu/skills/*.ts`
  }
}
