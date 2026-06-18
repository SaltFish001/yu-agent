/**
 * yu-agent — Skill registry
 *
 * Scans ~/.yu/skills/*.ts for skill files and loads them into
 * memory. Skills are TypeScript modules that export a LoadedSkill
 * (or a SkillDef) as their default export.
 *
 * Each skill file should export:
 *   export default { def: SkillDef, beforeIteration?, afterIteration? }
 * or just:
 *   export default SkillDef
 */

import { createLogger } from '../logger.js'
import type { SkillDef } from '../types.js'
import type { LoadedSkill } from './types.js'
import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const log = createLogger('skills:registry')

// ── Constants ──────────────────────────────────────────

const SKILLS_DIR = resolve(homedir(), '.yu', 'skills')

// ── In-memory cache ────────────────────────────────────

const _skills = new Map<string, LoadedSkill>()

// ── Loader ─────────────────────────────────────────────

function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) {
    try {
      const { mkdirSync } = require('fs')
      mkdirSync(SKILLS_DIR, { recursive: true })
    } catch {
      // Best-effort
    }
  }
}

async function loadSkillFromFile(filePath: string): Promise<LoadedSkill | null> {
  try {
    const mod = await import(filePath)
    const exported = mod.default || mod

    if (!exported) return null

    // Case 1: exported is a LoadedSkill (has def property)
    if (exported.def && typeof exported.def === 'object' && exported.def.name) {
      return exported as LoadedSkill
    }

    // Case 2: exported is a SkillDef directly
    if (exported.name && exported.version && exported.description) {
      return { def: exported as SkillDef }
    }

    log.warn(`Skill file ${filePath} has unrecognized export format. Expected SkillDef or LoadedSkill.`)
    return null
  } catch (err) {
    log.error(`Failed to load skill from ${filePath}:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Public API ─────────────────────────────────────────

/**
 * Scan the skills directory and load all skill definitions.
 * Caches results; call refreshSkills() to re-scan.
 */
export async function scanSkills(): Promise<Map<string, LoadedSkill>> {
  ensureSkillsDir()
  _skills.clear()

  if (!existsSync(SKILLS_DIR)) {
    log.warn(`Skills directory not found: ${SKILLS_DIR}`)
    return _skills
  }

  const files = readdirSync(SKILLS_DIR).filter(
    (f) => f.endsWith('.ts') || f.endsWith('.mts'),
  )

  for (const file of files) {
    const filePath = resolve(SKILLS_DIR, file)
    const skill = await loadSkillFromFile(filePath)
    if (skill) {
      if (_skills.has(skill.def.name)) {
        log.warn(`Duplicate skill name "${skill.def.name}" from ${file}, overwriting.`)
      }
      _skills.set(skill.def.name, skill)
      log.info(`Loaded skill: ${skill.def.name} v${skill.def.version} from ${file}`)
    }
  }

  return _skills
}

/** Get a skill by name (lazy-loads cache on first call). */
export async function getSkill(name: string): Promise<LoadedSkill | undefined> {
  if (_skills.size === 0) {
    await scanSkills()
  }
  return _skills.get(name)
}

/** List all loaded skills. */
export async function listSkills(): Promise<LoadedSkill[]> {
  if (_skills.size === 0) {
    await scanSkills()
  }
  return Array.from(_skills.values())
}

/** Force re-scan the skills directory. */
export async function refreshSkills(): Promise<void> {
  _skills.clear()
  await scanSkills()
}
