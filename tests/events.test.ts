/**
 * EventBus unit tests.
 *
 * Tests cover:
 * - Basic subscribe/emit/unsubscribe
 * - Once semantics
 * - Wildcard subscription
 * - Payload passing
 * - Error handling (handler throws)
 * - Subscription listing
 * - Clear all subscriptions
 * - Multiple subscribers
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { eventBus, type BusEvent } from '../extension/events.js'

describe('EventBus', () => {
  // Reset state before each test
  beforeEach(() => {
    eventBus.clear()
  })

  describe('on / emit', () => {
    it('should call handler when event is emitted', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.on('task.completed', handler)

      eventBus.emit('task.completed', { result: 'ok' })

      expect(handler).toHaveBeenCalledTimes(1)
      const event = handler.mock.calls[0][0]
      expect(event.type).toBe('task.completed')
      expect(event.payload).toEqual({ result: 'ok' })
      expect(typeof event.timestamp).toBe('number')
    })

    it('should pass topic to the event', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.on('task.started', handler)

      eventBus.emit('task.started', { taskId: 'abc' }, 'my-topic')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0][0].topic).toBe('my-topic')
    })

    it('should not call handler after unsubscribe', () => {
      const handler = mock<(e: BusEvent) => void>()
      const unsub = eventBus.on('task.completed', handler)

      eventBus.emit('task.completed', {})
      expect(handler).toHaveBeenCalledTimes(1)

      unsub()
      eventBus.emit('task.completed', {})
      expect(handler).toHaveBeenCalledTimes(1) // still 1
    })

    it('should support multiple subscribers', () => {
      const handler1 = mock<(e: BusEvent) => void>()
      const handler2 = mock<(e: BusEvent) => void>()

      eventBus.on('task.completed', handler1)
      eventBus.on('task.completed', handler2)

      eventBus.emit('task.completed', {})

      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it('should return the number of handlers called', () => {
      eventBus.on('task.completed', () => {})
      eventBus.on('task.completed', () => {})

      const count = eventBus.emit('task.completed', {})
      expect(count).toBe(2)
    })

    it('should return 0 when no handlers match', () => {
      const count = eventBus.emit('nonexistent.event', {})
      expect(count).toBe(0)
    })
  })

  describe('once', () => {
    it('should call handler only once', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.once('task.completed', handler)

      eventBus.emit('task.completed', {})
      eventBus.emit('task.completed', {})
      eventBus.emit('task.completed', {})

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should allow unsubscribe before event fires', () => {
      const handler = mock<(e: BusEvent) => void>()
      const unsub = eventBus.once('task.completed', handler)

      unsub()
      eventBus.emit('task.completed', {})

      expect(handler).toHaveBeenCalledTimes(0)
    })
  })

  describe('wildcard', () => {
    it('should catch all events with wildcard subscription', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.on('*', handler)

      eventBus.emit('task.completed', {})
      eventBus.emit('system.startup', {})
      eventBus.emit('agent.error', { msg: 'fail' })

      expect(handler).toHaveBeenCalledTimes(3)
    })

    it('should not double-dispatch wildcard when emitting *', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.on('*', handler)

      eventBus.emit('*', {})

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('error handling', () => {
    it('should not throw when a handler throws', () => {
      eventBus.on('task.completed', () => {
        throw new Error('handler error')
      })

      // Should not throw
      expect(() => eventBus.emit('task.completed', {})).not.toThrow()
    })

    it('should still call other handlers when one throws', () => {
      const goodHandler = mock<(e: BusEvent) => void>()

      eventBus.on('task.completed', () => {
        throw new Error('bad handler')
      })
      eventBus.on('task.completed', goodHandler)

      eventBus.emit('task.completed', {})

      expect(goodHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('subscriptions', () => {
    it('should list active subscriptions', () => {
      eventBus.on('task.completed', () => {})
      eventBus.on('task.completed', () => {})
      eventBus.on('system.startup', () => {})

      const subs = eventBus.subscriptions()
      expect(subs).toHaveLength(2)

      const taskSub = subs.find((s) => s.type === 'task.completed')
      expect(taskSub?.count).toBe(2)

      const sysSub = subs.find((s) => s.type === 'system.startup')
      expect(sysSub?.count).toBe(1)
    })

    it('should return empty array when no subscriptions', () => {
      expect(eventBus.subscriptions()).toEqual([])
    })
  })

  describe('clear', () => {
    it('should remove all subscriptions', () => {
      eventBus.on('task.completed', () => {})
      eventBus.on('system.startup', () => {})

      eventBus.clear()

      expect(eventBus.subscriptions()).toEqual([])
      expect(eventBus.emit('task.completed', {})).toBe(0)
    })
  })

  describe('payload', () => {
    it('should default payload to empty object', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.on('task.completed', handler)

      eventBus.emit('task.completed')

      expect(handler.mock.calls[0][0].payload).toEqual({})
    })

    it('should pass complex payload', () => {
      const handler = mock<(e: BusEvent) => void>()
      eventBus.on('task.completed', handler)

      const payload = {
        taskId: '123',
        result: { status: 'success', data: [1, 2, 3] },
        meta: { duration: 1500 },
      }
      eventBus.emit('task.completed', payload)

      expect(handler.mock.calls[0][0].payload).toEqual(payload)
    })
  })
})
