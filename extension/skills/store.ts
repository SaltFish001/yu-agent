/**
 * yu-agent — Skill store (local index + remote source)
 *
 * Provides a simple skill discovery mechanism:
 * - list available skills from store index
 * - install skills from remote sources (future)
 * - manage locally installed skills
 *
 * Currently supports local skills in ~/.yu/skills/ and project .yu/skills/.
 */

import { createLogger } from '../logger.js'

const log = createLogger('skills:store')

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

// ── Types ───────────────────────────────────────────────

export interface StoreSkillRef {
  name: string
  version: string
  description: string
  source: 'local' | 'remote'
  path?: string
}

// ── Paths ───────────────────────────────────────────────

const YU_HOME = resolve(homedir(), '.yu')
const STORE_INDEX_PATH = resolve(YU_HOME, 'skills', '.store-index.json')

// ── Local index ─────────────────────────────────────────

export function readStoreIndex(): StoreSkillRef[] {
  if (!existsSync(STORE_INDEX_PATH)) return []
  try {
    const raw = readFileSync(STORE_INDEX_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    log.warn(`Failed to read skill store index: ${STORE_INDEX_PATH}`)
    return []
  }
}

export function writeStoreIndex(skills: StoreSkillRef[]): void {
  try {
    writeFileSync(STORE_INDEX_PATH, `${JSON.stringify(skills, null, 2)}\n`, 'utf-8')
  } catch (err) {
    log.error('Failed to write skill store index', err)
  }
}

/**
 * Scan local scope directories for installed skill files and
 * update the store index with what's found on disk.
 */
export function scanInstalledSkills(): StoreSkillRef[] {
  const scopes = [
    resolve('/etc', 'yu', 'skills'), // 全局 (root 配置)
    resolve(YU_HOME, 'skills'), // 用户作用域
    resolve(process.cwd(), '.yu', 'skills'), // 项目作用域
  ]

  const installed: StoreSkillRef[] = []

  for (const scopeDir of scopes) {
    if (!existsSync(scopeDir)) continue
    try {
      const entries = readdirSync(scopeDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue

        const filePath = resolve(scopeDir, entry.name)
        try {
          const content = readFileSync(filePath, 'utf-8')
          const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/)
          const versionMatch = content.match(/version:\s*['"]([^'"]+)['"]/)
          const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/)

          installed.push({
            name: nameMatch?.[1] || entry.name.replace(/\.ts$/, ''),
            version: versionMatch?.[1] || '0.0.0',
            description: descMatch?.[1] || '',
            source: 'local',
            path: filePath,
          })
        } catch {
          installed.push({
            name: entry.name.replace(/\.ts$/, ''),
            version: '0.0.0',
            description: '',
            source: 'local',
            path: filePath,
          })
        }
      }
    } catch {
      /* skip unreadable dir */
    }
  }

  // Deduplicate by name (project scope wins over user scope)
  const byName = new Map<string, StoreSkillRef>()
  for (const s of installed) {
    byName.set(s.name, s)
  }

  return Array.from(byName.values())
}

/**
 * Get all available skills (installed + store index).
 */
export function listAllSkills(): StoreSkillRef[] {
  const indexed = readStoreIndex()
  const installed = scanInstalledSkills()

  // Merge: installed overrides indexed entries with same name
  const byName = new Map<string, StoreSkillRef>()
  for (const s of indexed) byName.set(s.name, s)
  for (const s of installed) byName.set(s.name, s)

  return Array.from(byName.values())
}

// ── Remote source ───────────────────────────────────────

export interface RemoteSkillSource {
  name: string
  url: string
  /** 最后同步时间戳 */
  lastSync?: number
}

/** 远程源索引路径 */
const REMOTE_SOURCE_PATH = resolve(YU_HOME, 'skills', '.remote-sources.json')

export function readRemoteSources(): RemoteSkillSource[] {
  if (!existsSync(REMOTE_SOURCE_PATH)) return []
  try {
    return JSON.parse(readFileSync(REMOTE_SOURCE_PATH, 'utf-8'))
  } catch {
    log.warn('Failed to read remote skill sources')
    return []
  }
}

export function writeRemoteSources(sources: RemoteSkillSource[]): void {
  try {
    writeFileSync(REMOTE_SOURCE_PATH, `${JSON.stringify(sources, null, 2)}\n`, 'utf-8')
  } catch (err) {
    log.error('Failed to write remote skill sources', err)
  }
}

export async function fetchRemoteIndex(source: RemoteSkillSource): Promise<StoreSkillRef[]> {
  try {
    const res = await fetch(source.url)
    if (!res.ok) {
      log.warn(`Remote source ${source.name} returned ${res.status}`)
      return []
    }
    const data = (await res.json()) as { skills: StoreSkillRef[] }
    if (!Array.isArray(data.skills)) return []
    return data.skills.map((s) => ({ ...s, source: 'remote' as const }))
  } catch (err) {
    log.error(`Failed to fetch remote source: ${source.name}`, err)
    return []
  }
}

export async function syncRemoteSources(): Promise<number> {
  const sources = readRemoteSources()
  let total = 0
  for (const source of sources) {
    const skills = await fetchRemoteIndex(source)
    if (skills.length > 0) {
      const existing = readStoreIndex()
      const byName = new Map<string, StoreSkillRef>()
      for (const s of existing) byName.set(s.name, s)
      for (const s of skills) byName.set(s.name, s)
      writeStoreIndex(Array.from(byName.values()))
      source.lastSync = Date.now()
      total += skills.length
    }
  }
  writeRemoteSources(sources)
  log.info(`Synced ${total} skills from ${sources.length} remote sources`)
  return total
}
