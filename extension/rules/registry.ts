/**
 * yu-agent — Rule registry
 *
 * 三作用域扫描：全局 /etc/yu/rules/ → 用户 ~/.yu/rules/ → 项目 .yu/rules/
 * 优先级：项目 > 用户 > 全局（同名覆盖）
 */

import { createLogger } from '../logger.js'
import type { RuleDef } from '../types.js'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { scanScopeFiles, ensureScopeDirs } from '../scope.js'

const log = createLogger('rules:registry')

// ── In-memory cache ────────────────────────────────────

const _rules = new Map<string, RuleDef>()

// ── Simple YAML parser (no external dep) ───────────────
// Stack-based approach to handle nested maps and lists.

function parseYamlRules(content: string): RuleDef[] {
  const results: RuleDef[] = []
  const docs = content.split(/^---\s*$/m).filter(Boolean)

  for (const doc of docs) {
    const lines = doc.split('\n')
    const root: Record<string, unknown> = {}

    const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: root, indent: -1 }]
    let pending: { parent: Record<string, unknown>; key: string; indent: number } | null = null

    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line.trim() || line.trim().startsWith('#')) continue

      const indent = line.search(/\S/)
      const trimmed = line.trim()

      if (trimmed.startsWith('- ')) {
        const itemVal = parseYamlValue(trimmed.slice(2).trim())
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop()
        }
        const currentObj = stack[stack.length - 1].obj
        if (pending && indent > pending.indent) {
          const existing = pending.parent[pending.key]
          if (Array.isArray(existing)) {
            existing.push(itemVal)
          } else {
            pending.parent[pending.key] = [itemVal]
            if (stack.length > 1) stack.pop()
          }
          pending = null
          continue
        }
        const keys = Object.keys(currentObj)
        for (let i = keys.length - 1; i >= 0; i--) {
          const val = currentObj[keys[i]]
          if (Array.isArray(val)) {
            val.push(itemVal)
            pending = null
            break
          }
        }
        continue
      }

      pending = null
      const colonIdx = trimmed.indexOf(':')
      if (colonIdx === -1) continue

      const key = trimmed.slice(0, colonIdx).trim()
      const val = trimmed.slice(colonIdx + 1).trim()

      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      const currentObj = stack[stack.length - 1].obj

      if (val) {
        currentObj[key] = parseYamlValue(val)
      } else {
        pending = { parent: currentObj, key, indent }
        const nested: Record<string, unknown> = {}
        currentObj[key] = nested
        stack.push({ obj: nested, indent })
      }
    }

    if (root.name) {
      const def = yamlToRuleDef(root)
      if (def) results.push(def)
    }
  }

  return results
}

function parseYamlValue(val: string): unknown {
  if (val === 'true') return true
  if (val === 'false') return false
  if (val === 'null' || val === '~') return null
  if (/^\d+$/.test(val)) return parseInt(val, 10)
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val)
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1)
  }
  return val
}

function yamlToRuleDef(raw: Record<string, unknown>): RuleDef | null {
  const name = String(raw.name ?? '')
  if (!name) return null

  const caps = raw.capabilities as Record<string, unknown> | undefined

  return {
    name,
    description: raw.description ? String(raw.description) : undefined,
    extend: raw.extend ? (raw.extend as string[]) : undefined,
    systemPrompt: raw.systemPrompt ? String(raw.systemPrompt) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    thinking: raw.thinking as RuleDef['thinking'] | undefined,
    maxTurns: raw.maxTurns ? Number(raw.maxTurns) : undefined,
    capabilities: caps
      ? {
          allowTools: caps.allowTools ? (caps.allowTools as string[]) : undefined,
          denyTools: caps.denyTools ? (caps.denyTools as string[]) : undefined,
          maxToolCalls: caps.maxToolCalls ? Number(caps.maxToolCalls) : undefined,
          allowMcpServers: caps.allowMcpServers ? (caps.allowMcpServers as string[]) : undefined,
          maxTokens: caps.maxTokens ? Number(caps.maxTokens) : undefined,
        }
      : undefined,
  }
}

// ── Loader ─────────────────────────────────────────────

async function loadRuleFromFile(filePath: string): Promise<RuleDef | null> {
  try {
    const ext = filePath.split('.').pop()?.toLowerCase()

    if (ext === 'ts' || ext === 'mts') {
      const mod = await import(filePath)
      const exported = mod.default || mod
      if (exported && typeof exported === 'object' && exported.name) {
        return exported as RuleDef
      }
      return null
    }

    if (ext === 'yaml' || ext === 'yml') {
      const content = readFileSync(filePath, 'utf-8')
      const rules = parseYamlRules(content)
      return rules[0] ?? null
    }

    if (ext === 'json') {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) return parsed[0] ?? null
      if (parsed.name) return parsed as RuleDef
      return null
    }

    log.warn(`Unsupported rule file format: ${filePath}`)
    return null
  } catch (err) {
    log.error(`Failed to load rule from ${filePath}:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Public API ─────────────────────────────────────────

/**
 * 从三作用域扫描并加载所有 rule 定义。
 * 项目级优先于用户级，用户级优先于全局级（同名覆盖）。
 */
export async function scanRules(): Promise<Map<string, RuleDef>> {
  ensureScopeDirs('rules')
  _rules.clear()

  const files = scanScopeFiles('rules', ['.yaml', '.yml', '.ts', '.mts', '.json'])

  for (const file of files) {
    const rule = await loadRuleFromFile(file.path)
    if (rule) {
      _rules.set(rule.name, rule)
      log.info(`Loaded rule: ${rule.name} (${file.scope}:${file.name})`)
    }
  }

  return _rules
}

/** Get a rule by name (lazy-loads cache on first call). */
export async function getRule(name: string): Promise<RuleDef | undefined> {
  if (_rules.size === 0) {
    await scanRules()
  }
  return _rules.get(name)
}

/** List all loaded rules. */
export async function listRules(): Promise<RuleDef[]> {
  if (_rules.size === 0) {
    await scanRules()
  }
  return Array.from(_rules.values())
}

/** Force re-scan all scope directories. */
export async function refreshRules(): Promise<void> {
  _rules.clear()
  await scanRules()
}
