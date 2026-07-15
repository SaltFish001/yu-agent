import { type ChatTransport, type UIMessageChunk, type UIMessage } from 'ai'
import { useStore } from './store'

let _id = 0
const uid = () => `yu_${++_id}_${Date.now().toString(36)}`

/**
 * Custom ChatTransport that bridges yu-agent backend SSE → AI SDK UIMessageChunk stream.
 *
 * Backend: POST /api/chat/stream { message } → SSE events:
 *   event: thinking     → reasoning-start / reasoning-delta / reasoning-end
 *   event: tool_call    → tool-call-start / tool-call-end
 *   event: tool_result  → tool-result
 *   event: text         → text-start / text-delta / text-end
 *   event: error        → error
 *   data: [DONE]        → stream end
 */
// Init budget from localStorage
try { (window as any).__yu_budget = parseInt(localStorage.getItem('yu-budget') || '', 10) || 0 } catch {}

export class YuTransport implements ChatTransport<UIMessage> {
  async sendMessages({
    messages,
    abortSignal,
  }: {
    messages: any[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const text = lastUser
      ? lastUser.parts
          ?.filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') ?? lastUser.content ?? ''
      : ''

    if (!text) {
      return new ReadableStream({ start(c) { c.close() } })
    }

    const budget = (window as any).__yu_budget ?? 0
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, budget }),
      signal: abortSignal,
    })

    if (!response.ok) throw new Error(`Backend error: ${response.status}`)

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const id = uid()

    // State machine per message ID
    let textStarted = false
    let textEnded = false
    let reasoningStarted = false

    return new ReadableStream({
      async start(controller) {
        let buffer = ''

        try {
          while (true) {
            let streamDone = false
            if (abortSignal?.aborted) {
              // Clean close on abort
              if (!textEnded && textStarted) controller.enqueue({ type: 'text-end', id })
              streamDone = true
            }

            if (!streamDone) {
              const { done, value } = await reader.read()
              if (done) streamDone = true
              else {
                buffer += decoder.decode(value, { stream: true })
              }
            }

            // Parse complete lines
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            let currentEvent = ''
            for (const line of lines) {
              const t = line.trim()
              if (!t || t.startsWith(':')) continue

              if (t.startsWith('event: ')) {
                currentEvent = t.slice(7).trim()
                continue
              }

              if (!t.startsWith('data: ')) continue

              const payload = t.slice(6).trim()
              if (payload === '[DONE]') {
                // End all open sequences
                if (!textEnded && textStarted) { controller.enqueue({ type: 'text-end', id }); textEnded = true }
                continue
              }

              try {
                const parsed = JSON.parse(payload)
                const ev = currentEvent

                // Extract iteration & token info from every event and update store
                if (typeof parsed._iteration === 'number') {
                  useStore.getState().setAgentIterations(parsed._iteration)
                }
                if (typeof parsed._totalTokens === 'number') {
                  useStore.getState().setTokenUsage(parsed._totalTokens)
                }

                if (ev === 'goal_check') {
                  // goal_check: render as a text chunk with goal status
                  const met: boolean = parsed.met ?? false
                  const reason: string = parsed.reason ?? ''
                  const statusText = met
                    ? `✅ 目标达成: ${reason}`
                    : `🔄 目标评估: ${reason}`
                  if (!textStarted) {
                    controller.enqueue({ type: 'text-start', id })
                    textStarted = true
                  }
                  const CHUNK_SIZE = 80
                  for (let i = 0; i < statusText.length; i += CHUNK_SIZE) {
                    const chunk = statusText.slice(i, i + CHUNK_SIZE)
                    controller.enqueue({ type: 'text-delta', delta: chunk, id })
                  }
                } else if (ev === 'thinking') {
                  // Emit reasoning-start / delta / end
                  const content: string = parsed.content ?? ''
                  if (content) {
                    if (!reasoningStarted) {
                      controller.enqueue({ type: 'reasoning-start', id } as any)
                      reasoningStarted = true
                    }
                    // Send in chunks for streaming feel
                    const CHUNK_SIZE = 50
                    for (let i = 0; i < content.length; i += CHUNK_SIZE) {
                      const chunk = content.slice(i, i + CHUNK_SIZE)
                      controller.enqueue({ type: 'reasoning-delta', delta: chunk, id } as any)
                    }
                  }
                } else if (ev === 'tool_call') {
                  // Emit tool-input-available (SDK v4 UIMessageChunk type)
                  const toolCallId: string = (parsed.id as string) ?? `tc_${Date.now()}`
                  const name: string = (parsed.name as string) ?? 'tool'
                  let args: unknown = (parsed.args as string) ?? '{}'
                  try { args = JSON.parse(args as string) } catch { /* keep raw */ }

                  controller.enqueue({
                    type: 'tool-input-available',
                    toolCallId,
                    toolName: name,
                    input: args,
                    dynamic: true,
                  } as any)

                } else if (ev === 'tool_result') {
                  // Emit tool-output-available (SDK v4 UIMessageChunk type)
                  const toolCallId: string = (parsed.id as string) ?? `tc_${Date.now()}`
                  const output: string = (parsed.output as string) ?? ''
                  const success: boolean = parsed.success as boolean ?? true

                  controller.enqueue({
                    type: 'tool-output-available',
                    toolCallId,
                    output: success ? output.slice(0, 2000) : output.slice(0, 500),
                    dynamic: true,
                  } as any)
                } else if (ev === 'text') {
                  // Emit text-start / delta / end
                  // Close reasoning part first if still open (SDK requires ordered parts)
                  if (reasoningStarted) {
                    controller.enqueue({ type: 'reasoning-end', id } as any)
                    reasoningStarted = false
                  }
                  const output: string = (parsed.output as string) ?? ''
                  if (output) {
                    if (!textStarted) {
                      controller.enqueue({ type: 'text-start', id })
                      textStarted = true
                    }
                    const CHUNK_SIZE = 80
                    for (let i = 0; i < output.length; i += CHUNK_SIZE) {
                      const chunk = output.slice(i, i + CHUNK_SIZE)
                      controller.enqueue({ type: 'text-delta', delta: chunk, id })
                    }
                  }
                } else if (ev === 'error') {
                  throw new Error((parsed.error as string) ?? 'Unknown SSE error')
                } else if (ev === 'done') {
                  // Done — agent complete. Extract final token/iteration info.
                  if (typeof parsed.iterations === 'number') {
                    useStore.getState().setAgentIterations(parsed.iterations)
                  }
                  if (typeof parsed.totalTokens === 'number') {
                    useStore.getState().setTokenUsage(parsed.totalTokens)
                  }
                  // Close parts in order: reasoning → text
                  if (reasoningStarted) {
                    controller.enqueue({ type: 'reasoning-end', id } as any)
                    reasoningStarted = false
                  }
                  if (!textEnded && textStarted) { controller.enqueue({ type: 'text-end', id }); textEnded = true }
                } else if (!ev) {
                  // Legacy fallback: data: {"text":"..."} without event
                  if (parsed.text?.length) {
                    if (!textStarted) {
                      controller.enqueue({ type: 'text-start', id })
                      textStarted = true
                    }
                    controller.enqueue({ type: 'text-delta', delta: parsed.text, id })
                  }
                }
              } catch { /* skip parse errors */ }
            }

            if (streamDone) break
          }

          // Ensure clean end state
          if (!textStarted) controller.enqueue({ type: 'text-start', id })
          if (!textEnded) controller.enqueue({ type: 'text-end', id })
          if (reasoningStarted) {
            controller.enqueue({ type: 'reasoning-end', id } as any)
          }
        } catch (err) {
          if (abortSignal?.aborted) {
            if (!textEnded && textStarted) controller.enqueue({ type: 'text-end', id })
          } else {
            controller.error(err)
          }
        } finally {
          controller.close()
        }
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }
}
