/**
 * yu-agent — 三作用域层（Global / User / Project）
 *
 * 定义 STMR 配置文件/技能/工具/角色的作用域层级与合并策略。
 *
 * 优先级: 项目级 > 用户级 > 全局级
 *   项目级  $PWD/.yu/      项目特有，随 git 提交
 *   用户级  ~/.yu/         当前实现，各用户私有
 *   全局级  /etc/yu/       系统预置，多用户共享
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { parse, resolve } from 'path'
import { createLogger } from './logger.js'

const log = createLogger('scope')

// ── 类型 ────────────────────────────────────────────────

export type ScopeLevel = 'global' | 'user' | 'project'

/** 优先级降序（高优先在前，用于查找/去重） */
export const SCOPE_PRIORITY: ScopeLevel[] = ['project', 'user', 'global']

/** 优先级升序（低优先在前，用于合并——后加载覆盖先加载） */
export const SCOPE_ASCENDING: ScopeLevel[] = ['global', 'user', 'project']

export interface ScopedFile {
  /** 文件绝对路径 */
  path: string
  /** 来源作用域 */
  scope: ScopeLevel
  /** 纯文件名（不含目录） */
  name: string
  /** 不含后缀的文件名（用于去重匹配） */
  stem: string
}

// ── 路径解析 ────────────────────────────────────────────

/** 获取三作用域基目录 */
export function getScopeDirs(): Record<ScopeLevel, string> {
  return {
    global: '/etc/yu',
    user: resolve(homedir(), '.yu'),
    project: resolve(process.cwd(), '.yu'),
  }
}

/** 获取某作用域下的子目录路径 */
export function scopeSubdir(scope: ScopeLevel, sub: string): string {
  return resolve(getScopeDirs()[scope], sub)
}

// ── 文件扫描 ────────────────────────────────────────────

/**
 * 按优先级扫描三作用域下的文件。
 *
 * @param sub       子目录名（'skills' / 'tools' / 'roles'）
 * @param exts      允许的后缀名列表（如 ['.ts', '.yaml']）
 * @returns         已按优先级去重的文件列表（项目级优先，同名覆盖）
 */
export function scanScopeFiles(sub: string, exts: string[]): ScopedFile[] {
  const seen = new Set<string>()
  const result: ScopedFile[] = []

  for (const scope of SCOPE_PRIORITY) {
    const dir = scopeSubdir(scope, sub)
    if (!existsSync(dir)) continue

    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }

    for (const name of files) {
      const ext = extnameLower(name)
      if (!exts.includes(ext)) continue

      const stem = parse(name).name
      if (seen.has(stem)) continue // 更高优先级已命中

      seen.add(stem)
      result.push({ path: resolve(dir, name), scope, name, stem })
    }
  }

  return result
}

/**
 * 从三作用域查找第一个匹配的文件（按优先级）。
 * 用于配置查找：找到即返回，不合并。
 */
export function findInScope(sub: string, name: string): string | null {
  for (const scope of SCOPE_PRIORITY) {
    const dir = scopeSubdir(scope, sub)
    const filePath = resolve(dir, name)
    if (existsSync(filePath)) return filePath
  }
  return null
}

// ── JSON 配置合并 ───────────────────────────────────────

/**
 * 从三作用域加载并合并 JSON 配置文件。
 * 合并策略：全局基础 → 用户覆盖 → 项目覆盖（深层合并）。
 *
 * @param fileName   配置文件名（如 'mcp.config.json'）
 * @returns          合并后的对象
 */
export function mergeJsonConfig<T extends Record<string, unknown>>(fileName: string): Partial<T> {
  let merged: Record<string, unknown> = {}

  // 从低优先到高优先迭代，后加载覆盖先加载
  for (const scope of SCOPE_ASCENDING) {
    const dir = getScopeDirs()[scope]
    const filePath = resolve(dir, fileName)
    if (!existsSync(filePath)) continue

    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        merged = deepMerge(merged, parsed as Record<string, unknown>)
        log.debug(`Merged config from ${scope} scope: ${filePath}`)
      }
    } catch (err) {
      log.warn(`Failed to parse config from ${filePath}:`, err)
    }
  }

  return merged as Partial<T>
}

// ── 目录创建（按需） ────────────────────────────────────

/**
 * 确保三作用域下的子目录都存在。
 * 常用于启动时初始化技能/工具/角色目录。
 */
export function ensureScopeDirs(sub: string): void {
  for (const scope of SCOPE_PRIORITY) {
    const dir = scopeSubdir(scope, sub)
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        // best-effort
      }
    }
  }
}

// ── 辅助函数 ────────────────────────────────────────────

function extnameLower(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx).toLowerCase()
}

/** 深层合并：b 的字段覆盖 a 的同名字段，对象则递归合并 */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result = { ...a }
  for (const [key, val] of Object.entries(b)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      key in result &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>)
    } else {
      result[key] = val
    }
  }
  return result
}
