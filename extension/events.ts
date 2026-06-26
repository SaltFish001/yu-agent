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

/**
 * Known event types used across the system.
 * Extend this union type when adding new event types.
 */
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
  | 'skill.activated'
  | 'skill.deactivated'
  | 'skill.executed'
  | 'team.started'
  | 'team.phase'
  | 'team.completed'

/**
 * A structured event object passed to handlers.
 *
 * @property type - The event type identifier (may be a custom string not in EventType union).
 * @property topic - Optional topic/scope the event belongs to.
 * @property payload - Arbitrary serialisable data associated with the event.
 * @property timestamp - Monotonic timestamp (ms since epoch) when the event was created.
 */
export interface BusEvent {
  type: EventType | string
  topic?: string
  payload: Record<string, unknown>
  timestamp: number
}

/**
 * Event handler function signature.
 * Handlers should be synchronous or return quickly — the EventBus does not await promises.
 */
export type EventHandler = (event: BusEvent) => void

// ── Subscriber registry ────────────────────────────────

/** Internal subscriber entry with handler and once-flag. */
type SubEntry = { handler: EventHandler; once: boolean }

/** Map of event type → list of subscriber entries. */
const subscribers = new Map<string, SubEntry[]>()

/** Wildcard key used to subscribe to ALL events. */
const WILDCARD = '*'

// ── Internal helpers ───────────────────────────────────

/**
 * Create a subscription entry and register it.
 * Returns an unsubscribe function.
 */
function addSubscription(
  type: EventType | typeof WILDCARD,
  handler: EventHandler,
  once: boolean,
): () => void {
  const entries = subscribers.get(type) ?? []
  const entry: SubEntry = { handler, once }
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
}

// ── EventBus ───────────────────────────────────────────

export const eventBus = {
  /**
   * Subscribe to an event type.
   *
   * @param type - Event type to subscribe to, or '*' to subscribe to ALL events.
   * @param handler - Callback invoked when an event of the given type is emitted.
   * @returns An unsubscribe function — call it to remove the subscription.
   *
   * @example
   * const unsub = eventBus.on('task.completed', (event) => {
   *   console.log('Task done:', event.payload)
   * })
   * // Later:
   * unsub()
   */
  on(type: EventType | typeof WILDCARD, handler: EventHandler): () => void {
    return addSubscription(type, handler, false)
  },

  /**
   * Subscribe to the NEXT event of a given type, then auto-unsubscribe.
   *
   * @param type - Event type to subscribe to, or '*' to catch the next event of any type.
   * @param handler - Callback invoked once when an event of the given type is emitted.
   * @returns An unsubscribe function — call it to cancel the one-shot subscription early.
   *
   * @example
   * eventBus.once('system.startup', () => {
   *   console.log('System started — this runs only once')
   * })
   */
  once(type: EventType | typeof WILDCARD, handler: EventHandler): () => void {
    return addSubscription(type, handler, true)
  },

  /**
   * Emit an event. Dispatches to matching subscribers (exact + wildcard).
   * Does NOT write to the DB by default — use persistToDb option or
   * call writeEvent() from the emitting module for persistence.
   *
   * @param type - Event type to emit.
   * @param payload - Arbitrary data to pass to handlers (default: `{}`).
   * @param topic - Optional topic/scope the event belongs to.
   * @returns The number of handlers that were called.
   *
   * @example
   * const count = eventBus.emit('task.completed', { result: 'ok' }, 'fix-bug')
   * console.log(`Dispatched to ${count} handler(s)`)
   */
  emit(
    type: EventType | string,
    payload: Record<string, unknown> = {},
    topic?: string,
  ): number {
    const event: BusEvent = { type, topic, payload, timestamp: Date.now() }
    let count = 0

    /**
     * Dispatch an event to a list of subscriber entries.
     * Iterates in reverse to allow safe removal of 'once' entries during iteration.
     */
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
    // Wildcard match (avoid double-dispatch if type is already '*')
    if (type !== WILDCARD) dispatch(subscribers.get(WILDCARD))

    if (count > 0) {
      log.debug(`EventBus: ${type} → ${count} handler(s)`)
    }
    return count
  },

  /**
   * List active subscriptions (for debugging/monitoring).
   *
   * @returns An array of objects with `type` and `count` for each event type that has subscribers.
   *
   * @example
   * const subs = eventBus.subscriptions()
   * // => [{ type: 'task.completed', count: 2 }, { type: '*', count: 1 }]
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
   *
   * @example
   * eventBus.clear()
   * console.log(eventBus.subscriptions()) // => []
   */
  clear(): void {
    subscribers.clear()
    log.info('EventBus: all subscriptions cleared')
  },
}
