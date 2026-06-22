/**
 * yu-agent — In-memory EventBus (P3)
 *
 * Lightweight pub/sub for cross-module communication.
 * Sits on top of the SQLite events table (topic.ts) for persistence,
 * but adds in-memory subscriptions for real-time dispatch.
 *
 * Usage:
 *   import { eventBus } from './events.js'
 *
 *   // Subscribe
 *   const unsub = eventBus.on('task.completed', (event) => {
 *     console.log('Task done:', event.payload)
 *   })
 *
 *   // Emit (writes to DB + notifies subscribers)
 *   eventBus.emit('task.completed', { topic: 'fix-bug', result: 'ok' })
 *
 *   // Unsubscribe
 *   unsub()
 */

import { createLogger } from './logger.js'

const log = createLogger('event-bus')

// ── Types ───────────────────────────────────────────────

export type EventType =
  | 'task.completed'
  | 'task.failed'
  | 'task.started'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.error'
  | 'topic.switched'
  | 'topic.created'
  | 'topic.archived'
  | 'system.startup'
  | 'system.shutdown'

export interface BusEvent {
  type: EventType | string
  topic?: string
  payload: Record<string, unknown>
  timestamp: number
}

export type EventHandler = (event: BusEvent) => void

// ── Subscriber registry ────────────────────────────────

type SubEntry = { handler: EventHandler; once: boolean }

const subscribers = new Map<string, SubEntry[]>()
const WILDCARD = '*'

// ── EventBus ───────────────────────────────────────────

export const eventBus = {
  /**
   * Subscribe to an event type.
   * Returns an unsubscribe function.
   * Use '*' to subscribe to ALL events.
   */
  on(type: EventType | typeof WILDCARD, handler: EventHandler): () => void {
    const entries = subscribers.get(type) ?? []
    const entry: SubEntry = { handler, once: false }
    entries.push(entry)
    subscribers.set(type, entries)
    return () => {
      const list = subscribers.get(type)
      if (list) {
        const idx = list.indexOf(entry)
        if (idx !== -1) list.splice(idx, 1)
        if (list.length === 0) subscribers.delete(type)
      }
    }
  },

  /**
   * Subscribe to the NEXT event of a given type, then auto-unsubscribe.
   */
  once(type: EventType | typeof WILDCARD, handler: EventHandler): () => void {
    const entries = subscribers.get(type) ?? []
    const entry: SubEntry = { handler, once: true }
    entries.push(entry)
    subscribers.set(type, entries)
    return () => {
      const list = subscribers.get(type)
      if (list) {
        const idx = list.indexOf(entry)
        if (idx !== -1) list.splice(idx, 1)
        if (list.length === 0) subscribers.delete(type)
      }
    }
  },

  /**
   * Emit an event. Dispatches to matching subscribers (exact + wildcard).
   * Does NOT write to the DB by default — use persistToDb option or
   * call writeEvent() from the emitting module for persistence.
   *
   * Returns the number of handlers that were called.
   */
  emit(type: EventType | string, payload: Record<string, unknown> = {}, topic?: string): number {
    const event: BusEvent = { type, topic, payload, timestamp: Date.now() }
    let count = 0

    const dispatch = (entries: SubEntry[] | undefined) => {
      if (!entries) return
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        count++
        try {
          entry.handler(event)
        } catch (err) {
          log.warn(`EventBus handler error for ${type}:`, err)
        }
        if (entry.once) entries.splice(i, 1)
      }
    }

    // Exact match
    dispatch(subscribers.get(type))
    // Wildcard match
    if (type !== WILDCARD) dispatch(subscribers.get(WILDCARD))

    if (count > 0) {
      log.debug(`EventBus: ${type} → ${count} handler(s)`)
    }
    return count
  },

  /**
   * List active subscriptions (for debugging).
   */
  subscriptions(): Array<{ type: string; count: number }> {
    const result: Array<{ type: string; count: number }> = []
    for (const [type, entries] of subscribers) {
      result.push({ type, count: entries.length })
    }
    return result
  },

  /**
   * Remove all subscriptions (use during shutdown).
   */
  clear(): void {
    subscribers.clear()
    log.info('EventBus: all subscriptions cleared')
  },
}
