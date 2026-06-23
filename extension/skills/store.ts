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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

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
    writeFileSync(STORE_INDEX_PATH, JSON.stringify(skills, null, 2) + '\n', 'utf-8')
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
    resolve(YU_HOME, 'skills'),
    resolve(process.cwd(), '.yu', 'skills'),
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
