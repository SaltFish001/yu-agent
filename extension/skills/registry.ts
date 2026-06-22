/**
 * yu-agent — Skill registry
 *
 * 三作用域扫描：全局 /etc/yu/skills/ → 用户 ~/.yu/skills/ → 项目 .yu/skills/
 * 优先级：项目 > 用户 > 全局（同名覆盖）
 */

import { createLogger } from '../logger.js'
import type { SkillDef } from '../types.js'
import type { LoadedSkill } from './types.js'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { scanScopeFiles, ensureScopeDirs } from '../scope.js'

const log = createLogger('skills:registry')

// ── In-memory cache ────────────────────────────────────

const _skills = new Map<string, LoadedSkill>()

// ── Loader ─────────────────────────────────────────────

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
 * 从三作用域扫描并加载所有 skill 定义。
 * 项目级优先于用户级，用户级优先于全局级（同名覆盖）。
 */
export async function scanSkills(): Promise<Map<string, LoadedSkill>> {
  ensureScopeDirs('skills')
  _skills.clear()

  const files = scanScopeFiles('skills', ['.ts', '.mts'])

  for (const file of files) {
    const skill = await loadSkillFromFile(file.path)
    if (skill) {
      _skills.set(skill.def.name, skill)
      log.info(`Loaded skill: ${skill.def.name} v${skill.def.version} (${file.scope}:${file.name})`)
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

/** Force re-scan all scope directories. */
export async function refreshSkills(): Promise<void> {
  _skills.clear()
  await scanSkills()
}
