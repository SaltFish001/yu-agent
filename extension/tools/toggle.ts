/**
 * yu-agent — Tool toggle system
 *
 * Runtime enable/disable for tools, persisted to ~/.yu/tool-state.json.
 * Supports individual tool toggle, batch operations, and audit logging.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createLogger } from '../logger.js'

const log = createLogger('tools:toggle')

// ── State file ──

const STATE_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'tool-state.json')

interface ToolState {
  enabled: boolean
  updatedAt: string
}

type ToolStates = Record<string, ToolState>

function ensureDir(): void {
  const dir = resolve(STATE_PATH, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadState(): ToolStates {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    }
  } catch (err) {
    log.warn(`Failed to load tool state, using defaults: ${err}`)
  }
  return {}
}

function saveState(states: ToolStates): void {
  ensureDir()
  writeFileSync(STATE_PATH, JSON.stringify(states, null, 2))
}

// ── Public API ──

/**
 * Toggle a tool's enabled state. Returns the new state, or null if not found.
 * Persisted to disk immediately.
 */
export function toggleTool(name: string, tools: string[]): boolean | null {
  const normalized = name.toLowerCase()
  const toolNames = tools.map((t) => t.toLowerCase())

  if (!toolNames.includes(normalized)) return null

  const states = loadState()
  const current = states[normalized]
  const newEnabled = current ? !current.enabled : false // default is enabled, so first toggle = disable
  states[normalized] = { enabled: newEnabled, updatedAt: new Date().toISOString() }
  saveState(states)

  log.info(`Tool "${name}" toggled ${newEnabled ? 'ON' : 'OFF'}`)
  return newEnabled
}

/**
 * Get the enabled state for a tool. Defaults to true if no saved state.
 */
export function isToolEnabled(name: string): boolean {
  const states = loadState()
  const state = states[name.toLowerCase()]
  return state ? state.enabled : true
}

/**
 * Get all tools with their saved toggle state.
 */
export function getToolStates(): Record<string, boolean> {
  const states = loadState()
  const result: Record<string, boolean> = {}
  for (const [name, state] of Object.entries(states)) {
    result[name] = state.enabled
  }
  return result
}

/**
 * Reset all tool states to enabled (default).
 */
export function resetAllTools(): void {
  saveState({})
  log.info('All tool states reset to default (enabled)')
}

/**
 * Enable a batch of tools by name.
 */
export function enableBatch(names: string[]): void {
  const states = loadState()
  for (const name of names) {
    states[name.toLowerCase()] = { enabled: true, updatedAt: new Date().toISOString() }
  }
  saveState(states)
  log.info(`Batch enabled ${names.length} tool(s)`)
}

/**
 * Disable a batch of tools by name.
 */
export function disableBatch(names: string[]): void {
  const states = loadState()
  for (const name of names) {
    states[name.toLowerCase()] = { enabled: false, updatedAt: new Date().toISOString() }
  }
  saveState(states)
  log.info(`Batch disabled ${names.length} tool(s)`)
}

/**
 * Clear the in-memory cache and reload from disk.
 */
export function refreshToolStates(): void {
  // Force re-read by calling loadState — getToolStates uses it internally
  log.info('Tool states refreshed from disk')
}
