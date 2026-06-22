/**
 * yu-agent — Skill registry
 *
 * 三作用域扫描：全局 /etc/yu/skills/ → 用户 ~/.yu/skills/ → 项目 .yu/skills/
 * 优先级：项目 > 用户 > 全局（同名覆盖）
 */

import { createLogger } from '../logger.js'
import type { SkillDef } from '../types.js'
import type { LoadedSkill } from './types.js'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { scanScopeFiles, ensureScopeDirs } from '../scope.js'

const log = createLogger('skills:registry')

// ── In-memory cache with mtime tracking ─────────────────

interface CacheEntry {
  skill: LoadedSkill
  mtimeMs: number
  filePath: string
}

const _cache = new Map<string, CacheEntry>()
let _cacheStats = { files: 0, fromCache: 0, fromDisk: 0 }

// 独立于文件缓存的最新扫描结果
let _loadedSkills: Map<string, LoadedSkill> | null = null

// ── Loader ─────────────────────────────────────────────

async function loadSkillFromFile(filePath: string): Promise<LoadedSkill | null> {
  // Check mtime cache — skip reload if file unchanged
  try {
    const stat = statSync(filePath)
    const cached = _cache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      _cacheStats.fromCache++
      return cached.skill
    }
  } catch { /* stat failed — will reload */ }

  try {
    const mod = await import(filePath)
    const exported = mod.default || mod

    if (!exported) return null

    let loaded: LoadedSkill | null = null

    // Case 1: exported is a LoadedSkill (has def property)
    if (exported.def && typeof exported.def === 'object' && exported.def.name) {
      loaded = exported as LoadedSkill
    }

    // Case 2: exported is a SkillDef directly
    if (!loaded && exported.name && exported.version && exported.description) {
      loaded = { def: exported as SkillDef }
    }

    if (!loaded) {
      log.warn(`Skill file ${filePath} has unrecognized export format. Expected SkillDef or LoadedSkill.`)
      return null
    }

    // Update cache with mtime
    _cacheStats.fromDisk++
    try {
      const stat = statSync(filePath)
      _cache.set(filePath, { skill: loaded, mtimeMs: stat.mtimeMs, filePath })
    } catch { /* stat failed — don't cache */ }

    return loaded
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

  const files = scanScopeFiles('skills', ['.ts', '.mts'])
  const result = new Map<string, LoadedSkill>()

  for (const file of files) {
    const skill = await loadSkillFromFile(file.path)
    if (skill) {
      result.set(skill.def.name, skill)
      log.info(`Loaded skill: ${skill.def.name} v${skill.def.version} (${file.scope}:${file.name})`)
    }
  }

  _cacheStats.files = result.size
  _loadedSkills = result
  return result
}

/** Get a skill by name (lazy-loads cache on first call). */
export async function getSkill(name: string): Promise<LoadedSkill | undefined> {
  const byName = await listSkills()
  return byName.find((s) => s.def.name === name)
}

/** List all loaded skills. */
export async function listSkills(): Promise<LoadedSkill[]> {
  if (!_loadedSkills) {
    await scanSkills()
  }
  return Array.from(_loadedSkills!.values())
}

/** Force re-scan all scope directories. */
export async function refreshSkills(): Promise<void> {
  _loadedSkills = null
  _cache.clear()
  _cacheStats = { files: 0, fromCache: 0, fromDisk: 0 }
  await scanSkills()
}

/** Get cache statistics for yu doctor. */
export function getSkillCacheStats(): { files: number; fromCache: number; fromDisk: number } {
  return { ..._cacheStats }
}
