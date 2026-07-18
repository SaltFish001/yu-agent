import { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useChat } from '@ai-sdk/react'
import { type UIMessage, type TextUIPart, type ReasoningUIPart } from 'ai'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { YuTransport } from '../lib/yu-transport'
import { useStore } from '../lib/store'
import { uuid } from '../lib/uuid'
import { t } from '../lib/i18n'

const STORAGE_KEY = 'yu-chat-messages'

function loadSavedMessages(): UIMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const msgs = JSON.parse(raw)
    return msgs
      .map((m: any) => {
        if (m.text !== undefined) {
          const parts: any[] = [{ type: 'text', text: m.text || '' }]
          if (m.reasoning) parts.unshift({ type: 'reasoning', text: m.reasoning })
          return {
            id: m.id || `hist_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
            role: m.role || 'user',
            parts,
            content: m.text || '',
          } as UIMessage
        }
        if (Array.isArray(m.parts) && m.parts.length > 0) return m as UIMessage
        if (m.content) {
          return {
            id: m.id || `hist_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
            role: m.role || 'user',
            parts: [{ type: 'text', text: m.content || '' }] as TextUIPart[],
            content: m.content || '',
          } as UIMessage
        }
        return null
      })
      .filter(Boolean) as UIMessage[]
  } catch {
    return []
  }
}

function saveMessages(msgs: UIMessage[]) {
  try {
    const saved = msgs.slice(-200).map((m) => ({
      role: m.role,
      text: msgText(m),
      reasoning: msgReasoning(m),
      id: m.id,
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch { /* quota exceeded */ }
}

function msgReasoning(m: UIMessage): string {
  return m.parts
    .filter((p): p is ReasoningUIPart => p.type === 'reasoning')
    .map((p) => p.text)
    .join('\n')
}

function msgText(m: UIMessage): string {
  return m.parts
    .filter((p): p is TextUIPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

const transport = new YuTransport()

const COMMANDS = [
  { name: 'goal', description: '设定目标自动迭代', usage: '/goal <描述>' },
  { name: 'topic', description: '切换 topic', usage: '/topic <名称>' },
  { name: 'new', description: '创建 topic', usage: '/new <名称>' },
  { name: 'clear', description: '清除当前对话', usage: '/clear' },
  { name: 'rm', description: '删除 topic', usage: '/rm <名称>' },
  { name: 'archive', description: '归档 topic', usage: '/archive <名称>' },
  { name: 'doctor', description: '系统诊断', usage: '/doctor' },
  { name: 'topics', description: '列出所有 topic', usage: '/topics' },
  { name: 'theme', description: '切换主题', usage: '/theme <dark|light|auto>' },
  { name: 'lang', description: '切换语言', usage: '/lang <zh|en>' },
  { name: 'model', description: '切换模型', usage: '/model <名称>' },
  { name: 'budget', description: '设置 Token 预算', usage: '/budget <数量>' },
  { name: 'export', description: '导出对话', usage: '/export' },
  { name: 'help', description: '显示帮助', usage: '/help' },
]

export default function ChatPanel() {
  const status = useStore((s) => s.status)
  const activeTopic = useStore((s) => s.activeTopic)
  const setActiveTopic = useStore((s) => s.setActiveTopic)
  const addSystemMessage = useStore((s) => s.addMessage)
  const sysMessages = useStore((s) => s.messages)
  const topics = status.topics || []
  const nonArchived = topics.filter((t: any) => !t.archived)
  const activeTopicData = topics.find((t: any) => t.name === activeTopic)
  const topicNames = topics.map((t: any) => t.name)

  async function loadHistory(): Promise<UIMessage[]> {
    try {
      const res = await fetch('/api/messages?limit=50')
      if (res.ok) {
        const data = await res.json()
        if (data.messages?.length > 0) {
          return data.messages.map((m: any) => {
            const parts: any[] = [{ type: 'text', text: m.content || '' }]
            if (m.reasoning) parts.unshift({ type: 'reasoning', text: m.reasoning })
            return {
              id: String(m.id || Date.now()),
              role: m.role || 'user',
              parts,
              content: m.content || '',
            } as UIMessage
          })
        }
      }
    } catch { /* offline or error */ }
    return loadSavedMessages()
  }

  const { messages, setMessages, status: chatStatus, error, ...chat } = useChat({
    transport,
    messages: loadSavedMessages(),
    onError: (e) => console.error('Chat error:', e),
  })

  useEffect(() => {
    loadHistory().then((msgs) => {
      if (msgs.length > 0) setMessages(msgs)
    })
  }, [])

  const isLoading = chatStatus === 'streaming' || chatStatus === 'submitted'
  const [inputValue, setInputValue] = useState('')

  const displayMessages = useMemo(() => {
    const sys = sysMessages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: 'text', text: m.content }] as TextUIPart[],
    }))
    return [...messages, ...sys]
  }, [messages, sysMessages])

  const prevMsgLen = useRef(messages.length)
  useEffect(() => {
    if (messages.length > 0 && messages.length !== prevMsgLen.current) {
      saveMessages(messages)
      prevMsgLen.current = messages.length
    }
  }, [messages])

  const inputRef = useRef<HTMLInputElement>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStartPos, setMentionStartPos] = useState(-1)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdQuery, setCmdQuery] = useState('')
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdStartPos, setCmdStartPos] = useState(-1)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (!target) return
      setMentionOpen(false)
      setCmdOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const onNewChat = () => {
      setMessages([])
      localStorage.removeItem(STORAGE_KEY)
    }
    window.addEventListener('yu:new-chat', onNewChat)
    return () => window.removeEventListener('yu:new-chat', onNewChat)
  }, [setMessages])

  const handleSend = () => {
    const text = inputValue.trim()
    if (!text || isLoading) return

    if (text === '/help') {
      const helpText = [
        '## yu-agent 命令',
        '',
        '| 命令 | 说明 |',
        '|------|------|',
        '| `/goal <描述>` | 设置目标，Agent 迭代直到条件满足 |',
        '| `/topic <名称>` | 切换到指定 topic |',
        '| `/new <名称>` | 创建 topic |',
        '| `/clear` | 清除当前对话 |',
        '| `/rm <名称>` | 删除 topic |',
        '| `/archive <名称>` | 归档 topic |',
        '| `/doctor` | 运行系统诊断 |',
        '| `/topics` | 列出所有 topic |',
        '| `/theme <dark\\|light\\|auto>` | 切换主题 |',
        '| `/lang <zh\\|en>` | 切换语言 |',
        '| `/model <名称>` | 切换模型 |',
        '| `/budget <数量>` | 设置 Token 预算 |',
        '| `/export` | 导出对话为 Markdown |',
        '| `/help` | 显示此帮助 |',
        '',
        '**提示:** 输入 `/` 查看可用命令，输入 `@` 引用 topic',
      ].join('\n')
      setMessages((prev) => [...prev, {
        id: uuid(),
        role: 'system',
        parts: [{ type: 'text', text: helpText }] as TextUIPart[],
        content: helpText,
      }])
      setInputValue('')
      return
    }

    if (text === '/clear') {
      setMessages([])
      setInputValue('')
      return
    }

    if (text === '/doctor') {
      const s = useStore.getState().status
      const uptime = s.uptime ? (s.uptime < 60 ? Math.floor(s.uptime) + 's' : Math.floor(s.uptime / 60) + 'm') : '—'
      const rss = s.memory?.rss ? (s.memory.rss / 1024 / 1024).toFixed(1) + 'MB' : '—'
      const heap = s.memory?.heapUsed ? (s.memory.heapUsed / 1024 / 1024).toFixed(1) + 'MB' : '—'
      const lines = [
        '## 🏥 yu-agent 诊断',
        '',
        `**版本:** ${s.version || '—'}`,
        `**运行时间:** ${uptime}`,
        `**连接:** ${s.ws?.connected ?? 0} WS`,
        `**Topic:** ${(s.topics || []).length} 个`,
        `**Agent 运行:** ${(s as any).agentStats?.total ?? 0} 总计 | ${(s as any).agentStats?.completed ?? 0} 完成`,
        `**内存:** RSS ${rss} / 堆 ${heap}`,
      ]
      if (activeTopic) lines.push(`**当前 Topic:** ${activeTopic}`)
      addSystemMessage({ role: 'system', content: lines.join('\n'), id: uuid() })
      setInputValue('')
      return
    }

    if (text === '/topics') {
      const tps = useStore.getState().status.topics || []
      if (tps.length === 0) {
        addSystemMessage({ role: 'system', content: '📭 暂无 topic', id: uuid() })
      } else {
        const lines = ['## 📁 所有 Topic', '']
        for (const t of tps) {
          const icon = t.archived ? '📦' : (t.name === activeTopic ? '▶' : '○')
          const status = t.archived ? '归档' : (t.status || '空闲')
          lines.push(`- ${icon} **${t.name}** — ${status}  |  ${t.turns ?? 0} 轮`)
        }
        addSystemMessage({ role: 'system', content: lines.join('\n'), id: uuid() })
      }
      setInputValue('')
      return
    }

    chat.sendMessage({ text })
    setInputValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (cmdOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => Math.min(i + 1, filteredCommands.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertCommand(filteredCommands[cmdIndex].name); return }
      if (e.key === 'Escape') { e.preventDefault(); setCmdOpen(false); return }
    }
    if (mentionOpen && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, filteredMentions.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filteredMentions[mentionIndex].name); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionOpen(false); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const detectMention = (val: string, cursorPos: number) => {
    const before = val.slice(0, cursorPos)
    const atIdx = before.lastIndexOf('@')
    if (atIdx >= 0) {
      const afterAt = before.slice(atIdx + 1)
      if (!afterAt.includes(' ') && afterAt.length < 30) {
        setMentionQuery(afterAt)
        setMentionStartPos(atIdx)
        setMentionIndex(0)
        setMentionOpen(true)
        return
      }
    }
    setMentionOpen(false)
  }

  const insertMention = (topicName: string) => {
    const before = inputValue.slice(0, mentionStartPos)
    const after = inputValue.slice(mentionStartPos + mentionQuery.length + 1)
    setInputValue(`${before}@${topicName} ${after}`)
    setMentionOpen(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const filteredMentions = mentionOpen
    ? nonArchived.filter((t: any) => t.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)
    : []

  const detectCommand = (val: string, cursorPos: number) => {
    const before = val.slice(0, cursorPos)
    const slashIdx = before.lastIndexOf('/')
    if (slashIdx === 0) {
      const afterSlash = before.slice(1)
      if (!afterSlash.includes(' ') && afterSlash.length < 30) {
        setCmdQuery(afterSlash)
        setCmdStartPos(slashIdx)
        setCmdIndex(0)
        setCmdOpen(true)
        return
      }
    }
    setCmdOpen(false)
  }

  const insertCommand = (cmdName: string) => {
    const after = inputValue.slice(cmdStartPos + cmdQuery.length + 1)
    setInputValue(`/${cmdName} ${after}`)
    setCmdOpen(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const filteredCommands = cmdOpen
    ? COMMANDS.filter((c) => c.name.toLowerCase().includes(cmdQuery.toLowerCase())).slice(0, 6)
    : []

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setInputValue(val)
    const pos = e.target.selectionStart ?? val.length
    detectMention(val, pos)
    detectCommand(val, pos)
  }

  function renderParts(m: UIMessage, isLastAssistant: boolean, isStreaming: boolean) {
    if (!m.parts || m.parts.length === 0) {
      const text = (m as any).content || ''
      if (text) {
        return <div className="prose prose-invert max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown></div>
      }
      return null
    }
    return m.parts.map((part, pi) => {
      switch (part.type) {
        case 'reasoning': {
          const rp = part as ReasoningUIPart
          const isLastReasoning = isLastAssistant && pi === m.parts.length - 1
          const isReasoningStreaming = isLastReasoning && isStreaming
          return (
            <details key={`p${pi}`} className="mt-2 bg-bg-surface border border-border rounded-lg overflow-hidden" open={isReasoningStreaming}>
              <summary className={`flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary cursor-pointer select-none transition-colors hover:text-text hover:bg-accent/5 ${isReasoningStreaming ? 'text-accent' : ''}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isReasoningStreaming ? 'bg-accent animate-breathe' : 'bg-text-muted'}`} />
                {isReasoningStreaming ? '推理中…' : '推理过程'}
              </summary>
              <div className="px-3 py-2 text-sm text-text-secondary leading-relaxed border-t border-border">
                {rp.text}
              </div>
            </details>
          )
        }
        case 'text': {
          const tp = part as TextUIPart
          return (
            <div key={`p${pi}`} className="prose prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{tp.text}</ReactMarkdown>
            </div>
          )
        }
        case 'dynamic-tool': {
          const tp = part as any
          const toolName: string = tp.toolName ?? 'tool'
          const state: string = tp.state ?? ''
          if (state === 'input-available' || state === 'input-streaming') {
            const args = tp.input ? JSON.stringify(tp.input, null, 2) : '{}'
            return (
              <details key={`p${pi}`} className="mt-2 bg-bg-surface border border-border rounded-lg overflow-hidden">
                <summary className="flex items-center gap-2 px-3 py-2 text-xs text-text-tertiary cursor-pointer select-none font-mono">
                  {toolName}
                </summary>
                <pre className="px-3 py-2 text-xs font-mono text-text-secondary overflow-x-auto border-t border-border">{args}</pre>
              </details>
            )
          }
          const isError = state === 'output-error'
          const output = isError ? (tp.errorText ?? '') : (tp.output ? JSON.stringify(tp.output, null, 2) : '')
          return (
            <details key={`p${pi}`} className="mt-2 bg-bg-surface border border-border rounded-lg overflow-hidden">
              <summary className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer select-none ${isError ? 'text-err' : 'text-ok'}`}>
                <span className="font-mono">{toolName}</span>
                <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] bg-bg-elev">{isError ? '失败' : '完成'}</span>
              </summary>
              <pre className={`px-3 py-2 text-xs font-mono overflow-x-auto border-t border-border ${isError ? 'text-err' : 'text-text-secondary'}`}>
                {(output as string)?.slice(0, 2000)}{(output as string)?.length > 2000 ? '…(已截断)' : ''}
              </pre>
            </details>
          )
        }
        default:
          return null
      }
    })
  }

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto">
      {/* Topic context */}
      {activeTopic && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <span className="text-xs text-text-tertiary">当前:</span>
          <span className="text-sm font-medium text-accent">{activeTopic}</span>
          {activeTopicData && (
            <span className="text-xs text-text-tertiary">
              {activeTopicData.status === 'active' ? '活跃' : activeTopicData.status === 'background' ? '后台' : '空闲'}
            </span>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {displayMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 pb-20">
            <div className="w-16 h-16 rounded-2xl bg-accent text-on-accent flex items-center justify-center text-3xl shadow-glow animate-pulse-glow">
              🎣
            </div>
            <h3 className="text-lg font-semibold text-text">深流</h3>
            <p className="text-sm text-text-tertiary text-center max-w-md">
              和 yu 说说你要做什么 —— 输入 <kbd className="px-1.5 py-0.5 bg-bg-elev border border-border rounded text-xs">/</kbd> 使用命令，<kbd className="px-1.5 py-0.5 bg-bg-elev border border-border rounded text-xs">@</kbd> 引用 topic
            </p>
            <div className="flex gap-2 mt-2">
              {['解释一下这个项目的结构', '/doctor', '帮我写一个脚本'].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setInputValue(s)
                    requestAnimationFrame(() => inputRef.current?.focus())
                  }}
                  className="px-4 py-2 text-sm bg-bg-surface border border-border rounded-full text-text-secondary hover:border-accent hover:text-accent transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Virtuoso
            className="h-full"
            data={displayMessages}
            followOutput
            initialTopMostItemIndex={displayMessages.length - 1}
            itemContent={(index, m) => {
              const isLastAssistant = index === displayMessages.length - 1 && m.role === 'assistant'
              return (
                <div className={`flex gap-3 px-4 py-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                    m.role === 'user'
                      ? 'bg-bg-elev text-text-secondary border border-border'
                      : m.role === 'system'
                      ? 'bg-transparent text-text-muted border border-dashed border-border'
                      : 'bg-accent text-on-accent shadow-glow'
                  }`}>
                    {m.role === 'user' ? '你' : m.role === 'system' ? '·' : 'y'}
                  </div>
                  <div className={`min-w-0 max-w-[80%] ${m.role === 'user' ? 'ml-auto' : ''}`}>
                    <div className="text-xs text-text-tertiary mb-1">
                      {m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'yu'}
                    </div>
                    <div className={`rounded-2xl px-4 py-3 ${
                      m.role === 'user'
                        ? 'bg-accent/10 border border-accent/20 rounded-br-md'
                        : m.role === 'system'
                        ? 'bg-transparent'
                        : 'bg-bg-surface border border-border rounded-bl-md'
                    }`}>
                      {renderParts(m, isLastAssistant, isLoading)}
                      {isLastAssistant && isLoading && m.parts.length === 0 && (
                        <span className="flex items-center gap-2 text-sm text-text-tertiary">
                          <span className="w-2 h-2 rounded-full bg-accent animate-breathe" />
                          思考中…
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            }}
            components={{
              Footer: () => error ? (
                <div className="mx-4 mb-4 p-3 bg-err/10 border border-err/30 rounded-lg text-sm text-err flex items-center justify-between">
                  <span>❌ 发送失败: {error.message}</span>
                  <button onClick={() => chat.regenerate()} className="px-3 py-1 text-xs bg-err/20 hover:bg-err/30 rounded-full transition-colors">
                    重试
                  </button>
                </div>
              ) : null,
            }}
          />
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-border">
        <div className="relative">
          {/* Dropdowns */}
          {mentionOpen && filteredMentions.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-64 bg-bg-elev border border-border rounded-lg shadow-lg overflow-hidden z-50">
              {filteredMentions.map((t: any, i: number) => (
                <div
                  key={t.name}
                  className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                    i === mentionIndex ? 'bg-accent/10 text-text' : 'text-text-secondary hover:bg-bg-hover'
                  }`}
                  onMouseDown={(e) => { e.preventDefault(); insertMention(t.name) }}
                >
                  <span className="text-xs">{t.status === 'active' ? '▶' : '○'}</span>
                  <span className="flex-1">{t.name}</span>
                  <span className="text-xs text-text-tertiary">{t.turns ?? 0}t</span>
                </div>
              ))}
            </div>
          )}
          {cmdOpen && filteredCommands.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-72 bg-bg-elev border border-border rounded-lg shadow-lg overflow-hidden z-50">
              {filteredCommands.map((cmd, i) => (
                <div
                  key={cmd.name}
                  className={`flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors ${
                    i === cmdIndex ? 'bg-accent/10 text-text' : 'text-text-secondary hover:bg-bg-hover'
                  }`}
                  onMouseDown={(e) => { e.preventDefault(); insertCommand(cmd.name) }}
                >
                  <span className="font-mono text-accent">/{cmd.name}</span>
                  <span className="text-xs text-text-tertiary">{cmd.description}</span>
                </div>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div className="flex items-center gap-2 bg-bg-surface border border-border rounded-xl px-3 py-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent transition-all">
            <input
              ref={inputRef}
              value={inputValue}
              onChange={onInputChange}
              onKeyDown={handleKeyDown}
              placeholder={t('input.placeholder')}
              disabled={isLoading}
              className="flex-1 bg-transparent text-sm text-text placeholder:text-text-tertiary outline-none min-w-0"
            />
            {isLoading ? (
              <button
                onClick={() => chat.stop()}
                className="px-4 py-2 text-sm font-medium text-err bg-err/10 border border-err/30 rounded-lg hover:bg-err/20 transition-colors"
              >
                {t('stop')}
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputValue.trim()}
                className="px-4 py-2 text-sm font-semibold text-on-accent bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-30 disabled:cursor-default transition-all hover:shadow-glow"
              >
                {t('send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
