/**
 * yu-agent — MCP Streaming call support.
 *
 * Wraps tools/call with notification listening for progress events.
 * Uses the McpTransport onNotification callback to intercept
 * notifications/progress events during long-running tool operations.
 *
 * Usage:
 *   import { streamToolCall } from './mcp/mcp-stream.js'
 *   const result = await streamToolCall(transport, 'server_name', {
 *     name: 'some_tool',
 *     arguments: { ... }
 *   })
 */

import { createLogger } from '../logger.js'
import type { McpTransport } from './transport.js'

const _log = createLogger('mcp-stream')

export interface StreamEvent {
  type: 'progress' | 'result' | 'error'
  data: unknown
  timestamp: number
}

export interface StreamResult {
  result: unknown
  events: StreamEvent[]
  durationMs: number
}

/**
 * Execute a tools/call with streaming notification support.
 *
 * While the tool is running, the transport's onNotification callback
 * intercepts notifications/progress events and records them.
 * Returns the final result along with all intermediate events.
 */
export async function streamToolCall(
  transport: McpTransport,
  params: { name: string; arguments?: Record<string, unknown> },
  timeoutMs = 60_000,
): Promise<StreamResult> {
  const startTime = Date.now()
  const events: StreamEvent[] = []

  // Register notification listener for progress events
  const origOnNotification = transport.events?.onNotification
  transport.setEvents({
    onNotification: (notification) => {
      events.push({
        type: 'progress',
        data: notification.params,
        timestamp: Date.now(),
      })
      // Forward to original handler if set
      origOnNotification?.(notification)
    },
    onClose: transport.events?.onClose,
    onError: transport.events?.onError,
  })

  try {
    const result = await transport.request('tools/call', params, timeoutMs)
    return {
      result,
      events,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    events.push({
      type: 'error',
      data: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    })
    throw err
  } finally {
    // Restore original notification handler
    transport.setEvents({
      onNotification: origOnNotification || undefined,
      onClose: transport.events?.onClose,
      onError: transport.events?.onError,
    })
  }
}

/**
 * Execute a streaming resources/read call.
 * Returns a ReadableStream of resource contents for large resources.
 */
export async function streamResourceRead(transport: McpTransport, uri: string): Promise<ReadableStream<unknown>> {
  const result = await transport.request('resources/read', { uri })
  const contents = (result as { contents?: unknown[] })?.contents || []
  return new ReadableStream({
    start(controller) {
      for (const item of contents) {
        controller.enqueue(item)
      }
      controller.close()
    },
  })
}
