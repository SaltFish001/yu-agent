/**
 * Unit tests — Skills subsystem (types, registry, runner)
 *
 * Tests skill loading, registry scanning, and the SkillRunner.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

const SKILLS_DIR = resolve(homedir(), '.yu', 'skills')

// ── Helpers ────────────────────────────────────────────

async function cleanSkillsDir(): Promise<void> {
  if (existsSync(SKILLS_DIR)) {
    rmSync(SKILLS_DIR, { recursive: true, force: true })
  }
  mkdirSync(SKILLS_DIR, { recursive: true })
}

async function writeSkillFile(name: string, content: string): Promise<void> {
  writeFileSync(resolve(SKILLS_DIR, name), content, 'utf-8')
}

// ── Tests ──────────────────────────────────────────────

describe('Skill types', () => {
  it('exports SkillDef type (structural check)', async () => {
    const types = await import('../extension/skills/types.js')
    expect(types).toBeDefined()
  })
})

describe('Skill Registry', () => {
  beforeEach(async () => {
    await cleanSkillsDir()
  })

  afterEach(async () => {
    await cleanSkillsDir()
  })

  it('scanSkills returns empty map when no skill files exist', async () => {
    const { scanSkills } = await import('../extension/skills/registry.js')
    const skills = await scanSkills()
    expect(skills.size).toBe(0)
  })

  it('loads a skill from a .ts file exporting a SkillDef', async () => {
    await writeSkillFile(
      'hello-skill.ts',
      `export default {
  name: 'hello-skill',
  version: '1.0.0',
  description: 'A hello world skill',
  systemPrompt: 'You say hello to the user.',
  requiresTools: ['read'],
  source: 'file',
  filePath: __filename,
}`,
    )

    const { scanSkills, getSkill } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skill = await getSkill('hello-skill')
    expect(skill).toBeDefined()
    expect(skill!.def.name).toBe('hello-skill')
    expect(skill!.def.version).toBe('1.0.0')
    expect(skill!.def.description).toBe('A hello world skill')
    expect(skill!.def.systemPrompt).toContain('hello')
    expect(skill!.def.requiresTools).toEqual(['read'])
  })

  it('loads a skill exporting a LoadedSkill (with hooks)', async () => {
    await writeSkillFile(
      'hooked-skill.ts',
      `export default {
  def: {
    name: 'hooked-skill',
    version: '2.0.0',
    description: 'A skill with lifecycle hooks',
    systemPrompt: 'I have hooks.',
    requiresTools: ['bash'],
    source: 'file',
  },
  beforeIteration: async (ctx) => {
    ctx.messages.push({ role: 'system', content: 'before hook ran' })
  },
  afterIteration: async (ctx) => {
    // inspect results
  },
}`,
    )

    const { scanSkills, getSkill } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skill = await getSkill('hooked-skill')
    expect(skill).toBeDefined()
    expect(skill!.def.name).toBe('hooked-skill')
    expect(skill!.def.version).toBe('2.0.0')
    expect(skill!.beforeIteration).toBeDefined()
    expect(skill!.afterIteration).toBeDefined()
  })

  it('loads multiple skills from multiple files', async () => {
    await writeSkillFile(
      'skill-a.ts',
      `export default { name: 'skill-a', version: '1.0.0', description: 'A', systemPrompt: '', source: 'file' }`,
    )
    await writeSkillFile(
      'skill-b.ts',
      `export default { name: 'skill-b', version: '1.0.0', description: 'B', systemPrompt: '', source: 'file' }`,
    )

    const { scanSkills, listSkills } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skills = await listSkills()
    expect(skills.length).toBe(2)
    const names = skills.map((s) => s.def.name).sort()
    expect(names).toEqual(['skill-a', 'skill-b'])
  })

  it('refreshSkills clears and reloads', async () => {
    await writeSkillFile(
      's1.ts',
      `export default { name: 's1', version: '1.0.0', description: 'S1', systemPrompt: '', source: 'file' }`,
    )
    const { scanSkills, listSkills, refreshSkills } = await import('../extension/skills/registry.js')
    await scanSkills()
    expect((await listSkills()).length).toBe(1)

    await writeSkillFile(
      's2.ts',
      `export default { name: 's2', version: '1.0.0', description: 'S2', systemPrompt: '', source: 'file' }`,
    )
    await refreshSkills()
    expect((await listSkills()).length).toBe(2)
  })
})

describe('Skill Runner', () => {
  beforeEach(async () => {
    await cleanSkillsDir()
  })

  afterEach(async () => {
    await cleanSkillsDir()
  })

  it('SkillRunner activates and deactivates skills', async () => {
    await writeSkillFile(
      'test-skill.ts',
      `export default { name: 'test-skill', version: '1.0.0', description: 'Test', systemPrompt: 'Be testy.', source: 'file' }`,
    )
    const { SkillRunner } = await import('../extension/skills/runner.js')
    const { scanSkills } = await import('../extension/skills/registry.js')
    await scanSkills()

    const runner = new SkillRunner()
    expect(runner.getActiveSkills()).toHaveLength(0)

    await runner.activateSkills(['test-skill'])
    expect(runner.getActiveSkills()).toHaveLength(1)
    expect(runner.getActiveSkills()[0].def.name).toBe('test-skill')

    runner.deactivateSkill('test-skill')
    expect(runner.getActiveSkills()).toHaveLength(0)
  })

  it('getCombinedSystemPrompt appends skill prompts', async () => {
    await writeSkillFile(
      'skill-x.ts',
      `export default { name: 'skill-x', version: '1.0.0', description: 'X', systemPrompt: 'Skill X prompt.', source: 'file' }`,
    )
    const { SkillRunner } = await import('../extension/skills/runner.js')
    const { scanSkills } = await import('../extension/skills/registry.js')
    await scanSkills()

    const runner = new SkillRunner()
    await runner.activateSkills(['skill-x'])

    const combined = runner.getCombinedSystemPrompt('Base prompt')
    expect(combined).toContain('Base prompt')
    expect(combined).toContain('Skill X prompt')
    expect(combined).toContain('── Skill: skill-x ──')
  })

  it('getCombinedSystemPrompt returns base prompt when no skills active', async () => {
    const { SkillRunner } = await import('../extension/skills/runner.js')
    const runner = new SkillRunner()
    const combined = runner.getCombinedSystemPrompt('Just base')
    expect(combined).toBe('Just base')
  })

  it('verifyRequiredTools reports missing tools', async () => {
    await writeSkillFile(
      'needy.ts',
      `export default { name: 'needy', version: '1.0.0', description: 'Needy', systemPrompt: '', requiresTools: ['read', 'nonexistent-tool-xyz'], source: 'file' }`,
    )
    const { SkillRunner } = await import('../extension/skills/runner.js')
    const { scanSkills } = await import('../extension/skills/registry.js')
    await scanSkills()

    const runner = new SkillRunner()
    await runner.activateSkills(['needy'])

    const missing = runner.verifyRequiredTools()
    expect(missing).toContain('nonexistent-tool-xyz')
    // 'read' should be registered (from previous test registrations or by tools/loader)
    // This test only checks that missing tools are reported properly
  })

  it('runWithSkills produces correct result shape', async () => {
    await writeSkillFile(
      'simple.ts',
      `export default { name: 'simple', version: '1.0.0', description: 'Simple', systemPrompt: 'Simple prompt.', source: 'file' }`,
    )
    const { SkillRunner } = await import('../extension/skills/runner.js')
    const { scanSkills } = await import('../extension/skills/registry.js')
    await scanSkills()

    const runner = new SkillRunner()
    await runner.activateSkills(['simple'])

    const result = await runner.runWithSkills('Do something', 'Base system prompt')
    expect(result.success).toBe(true)
    expect(result.skillsUsed).toContain('simple')
  })

  it('handles skill activation failure gracefully (skill not found)', async () => {
    const { SkillRunner } = await import('../extension/skills/runner.js')
    const runner = new SkillRunner()
    // Activate a skill that doesn't exist — should log warning, not throw
    await runner.activateSkills(['nonexistent-skill'])
    expect(runner.getActiveSkills()).toHaveLength(0)
  })
})
