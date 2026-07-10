import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useChat } from '@ai-sdk/react'
import { type UIMessage, type TextUIPart, type ReasoningUIPart } from 'ai'
import { isDynamicToolUIPart, getToolName } from 'ai'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { YuTransport } from '../lib/yu-transport'
import { useStore } from '../lib/store'
import { uuid } from '../lib/uuid'
import { t, setLang } from '../lib/i18n'
import { applyTheme } from '../lib/theme'

// ── 会话持久化 ──

const STORAGE_KEY = 'yu-chat-messages'

function loadSavedMessages(): UIMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const msgs = JSON.parse(raw)
    // Migration: 旧格式只有 content 没有 parts → 转成 v4 parts
    return msgs.map((m: any) => {
      if (Array.isArray(m.parts)) return m as UIMessage
      // 旧格式: { id, role, content } → { id, role, parts: [{ type: 'text', text: content }] }
      return {
        id: m.id,
        role: m.role || 'user',
        parts: [{ type: 'text', text: m.content || '' }] as TextUIPart[],
        content: m.content || '',
      } as UIMessage
    })
  } catch {
    return []
  }
}

function saveMessages(msgs: UIMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-200)))
  } catch { /* quota exceeded */ }
}

// ── 工具函数 ──

/** Extract full text from a UIMessage (v4 uses `parts` not `content`). */
function msgText(m: UIMessage): string {
  return m.parts
    .filter((p): p is TextUIPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** Format JSON args for display. */
function fmtArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

/** Parse @topic references from text. */
function parseMentions(content: string, topicNames: string[]): string[] {
  const matches = content.match(/@[\w-]+/g)
  if (!matches) return []
  return [...new Set(matches.map((m) => m.slice(1)))].filter((n) => topicNames.includes(n))
}

const transport = new YuTransport()

// ── Available commands ──
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
  const connected = useStore((s) => s.connected)
  const setConnected = useStore((s) => s.setConnected)
  const tokenUsage = useStore((s) => s.tokenUsage)
  const setTokenUsage = useStore((s) => s.setTokenUsage)
  const agentIterations = useStore((s) => s.agentIterations)
  const setAgentIterations = useStore((s) => s.setAgentIterations)
  const agentBudget = useStore((s) => s.agentBudget)
  const topics = status.topics || []
  const nonArchived = topics.filter((t: any) => !t.archived)
  const activeTopicData = topics.find((t: any) => t.name === activeTopic)
  const topicNames = topics.map((t: any) => t.name)

  // ── AI SDK useChat ──
  const { messages, setMessages, status: chatStatus, error, ...chat } = useChat({
    transport,
    messages: loadSavedMessages(),
    onError: (e) => console.error('Chat error:', e),
  })

  const isLoading = chatStatus === 'streaming' || chatStatus === 'submitted'
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [inputValue, setInputValue] = useState('')

  // 持久化消息
  const prevMsgLen = useRef(messages.length)
  useEffect(() => {
    if (messages.length > 0 && messages.length !== prevMsgLen.current) {
      saveMessages(messages)
      prevMsgLen.current = messages.length
    }
  }, [messages])

  // 初始 loading（等 useChat 恢复历史）
  useEffect(() => {
    const t = setTimeout(() => setIsInitialLoading(false), 400)
    return () => clearTimeout(t)
  }, [])

  const inputRef = useRef<HTMLInputElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)
  const quickRefWrapRef = useRef<HTMLDivElement>(null)
  const quickRefTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── @mention ──
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStartPos, setMentionStartPos] = useState(-1)
  const [mentionIndex, setMentionIndex] = useState(0)

  // ── Slash command ──
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdQuery, setCmdQuery] = useState('')
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdStartPos, setCmdStartPos] = useState(-1)

  // ── Quick ref tooltip ──
  const [quickRefOpen, setQuickRefOpen] = useState(false)

  // Scroll to bottom on new messages (Virtuoso followOutput handles this natively)

  // Close popups on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) setMentionOpen(false)
      if (quickRefWrapRef.current && !quickRefWrapRef.current.contains(e.target as Node)) setQuickRefOpen(false)
      // Close command dropdown on outside click (no dedicated ref needed)
      setCmdOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── SSE connection monitoring ──
  useEffect(() => {
    // Try to connect to SSE endpoint to detect server health
    const es = new EventSource('/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    return () => { es.close(); setConnected(false) }
  }, [setConnected])

  // ── Track token usage from agent responses ──
  useEffect(() => {
    // Listen for assistant messages and estimate token usage
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'assistant' && !isLoading) {
      const text = msgText(lastMsg)
      const estimated = Math.ceil(text.length / 4)
      const current = useStore.getState().tokenUsage
      if (estimated > current) setTokenUsage(estimated)
    }
  }, [messages, isLoading])

  const getStatusColor = (t: any): string => {
    if (t?.status === 'active') return '#22c55e'
    if (t?.status === 'background') return '#3b82f6'
    if (t?.status === 'error') return '#ef4444'
    return '#6b7280'
  }

  // ── Send message ──
  const handleSend = () => {
    const text = inputValue.trim()
    if (!text || isLoading) return

    // Handle mention insertion before send
    if (mentionOpen && filteredMentions.length > 0) {
      insertMention(filteredMentions[mentionIndex].name)
      return
    }

    // Handle command insertion before send
    if (cmdOpen && filteredCommands.length > 0) {
      insertCommand(filteredCommands[cmdIndex].name)
      return
    }

    // Handle client-side commands (no server roundtrip)
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

    // ── /doctor ──
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

    // ── /topics ──
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

    // ── /theme ──
    if (text.startsWith('/theme ')) {
      const val = text.slice(7).trim()
      if (['dark', 'light', 'auto'].includes(val)) {
        applyTheme(val as any)
        addSystemMessage({ role: 'system', content: `🎨 主题已切换: ${val}`, id: uuid() })
      } else {
        addSystemMessage({ role: 'system', content: `⚠️ 无效主题 "${val}"，可选: dark, light, auto`, id: uuid() })
      }
      setInputValue('')
      return
    }

    // ── /lang ──
    if (text.startsWith('/lang ')) {
      const val = text.slice(6).trim()
      if (['zh', 'en'].includes(val)) {
        setLang(val)
        window.dispatchEvent(new CustomEvent('yu-lang-change', { detail: val }))
        addSystemMessage({ role: 'system', content: `🌐 语言已切换: ${val === 'zh' ? '中文' : 'English'}`, id: uuid() })
      } else {
        addSystemMessage({ role: 'system', content: `⚠️ 无效语言 "${val}"，可选: zh, en`, id: uuid() })
      }
      setInputValue('')
      return
    }

    // ── /budget ──
    if (text.startsWith('/budget ')) {
      const val = parseInt(text.slice(8).trim(), 10)
      if (!isNaN(val) && val > 0) {
        useStore.getState().setAgentBudget(val)
        addSystemMessage({ role: 'system', content: `💰 Token 预算已设置为: ${val.toLocaleString()}`, id: uuid() })
      } else {
        addSystemMessage({ role: 'system', content: '⚠️ 请输入有效数字', id: uuid() })
      }
      setInputValue('')
      return
    }

    // ── /model ──
    if (text.startsWith('/model ')) {
      const name = text.slice(7).trim()
      addSystemMessage({ role: 'system', content: `🤖 模型切换请求: ${name}（服务端支持取决于 provider 配置）`, id: uuid() })
      setInputValue('')
      return
    }

    // ── /export ──
    if (text === '/export') {
      const msgs = useStore.getState().messages
      if (msgs.length === 0) {
        addSystemMessage({ role: 'system', content: '📭 暂无对话可导出', id: uuid() })
      } else {
        const md = msgs.map((m) => `**${m.role}:** ${m.content}`).join('\n\n---\n\n')
        const blob = new Blob([`# yu-agent 对话导出\n\n${md}`], { type: 'text/markdown' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = `yu-export-${Date.now()}.md`; a.click()
        URL.revokeObjectURL(url)
        addSystemMessage({ role: 'system', content: `📤 已导出 ${msgs.length} 条消息`, id: uuid() })
      }
      setInputValue('')
      return
    }

    // ── /topic ──
    if (text.startsWith('/topic ')) {
      const name = text.slice(7).trim()
      if (name) {
        setActiveTopic(name)
        addSystemMessage({ role: 'system', content: `📂 切换到主题: ${name}`, id: uuid() })
      }
      setInputValue('')
      return
    }

    // ── /rm ──
    if (text.startsWith('/rm ')) {
      const name = text.slice(4).trim()
      if (name) {
        ;(async () => {
          try {
            const { deleteTopic } = await import('../lib/api')
            await deleteTopic(name)
            useStore.getState().refreshStatus()
            addSystemMessage({ role: 'system', content: `🗑️ 已删除主题: ${name}`, id: uuid() })
          } catch (e) {
            addSystemMessage({ role: 'system', content: `❌ 删除失败: ${(e as Error).message}`, id: uuid() })
          }
        })()
      }
      setInputValue('')
      return
    }

    // ── /archive ──
    if (text.startsWith('/archive ')) {
      const name = text.slice(9).trim()
      if (name) {
        ;(async () => {
          try {
            const { archiveTopic } = await import('../lib/api')
            await archiveTopic(name)
            useStore.getState().refreshStatus()
            addSystemMessage({ role: 'system', content: `📦 已归档主题: ${name}`, id: uuid() })
          } catch (e) {
            addSystemMessage({ role: 'system', content: `❌ 归档失败: ${(e as Error).message}`, id: uuid() })
          }
        })()
      }
      setInputValue('')
      return
    }

    // ── /new ──
    if (text.startsWith('/new ')) {
      const name = text.slice(5).trim()
      if (name) {
        addSystemMessage({ role: 'system', content: `📂 创建主题: ${name}...`, id: uuid() })
      }
      setInputValue('')
      return
    }

    chat.sendMessage({ text })
    setInputValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Slash command dropdown has priority over @mention
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

  // ── @mention logic ──
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
    const newVal = `${before}@${topicName} ${after}`
    setInputValue(newVal)
    setMentionOpen(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const filteredMentions = mentionOpen
    ? nonArchived.filter((t: any) => t.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)
    : []

  // ── Slash command logic ──
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
    const newVal = `/${cmdName} ${after}`
    setInputValue(newVal)
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

  const handleMentionClick = (topicName: string) => {
    setActiveTopic(topicName)
    addSystemMessage({ role: 'system', content: `📂 切换到主题: ${topicName}`, id: uuid() })
  }

  const insertQuickRef = (topicName: string) => {
    const newVal = `${inputValue} @${topicName} `
    setInputValue(newVal)
    setQuickRefOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }

  // ── Render parts for a message ──
  function renderParts(m: UIMessage, isLastAssistant: boolean, isStreaming: boolean) {
    return m.parts.map((part, pi) => {
      switch (part.type) {
        case 'reasoning': {
          const rp = part as ReasoningUIPart
          // Check if this is the last reasoning part and is still streaming
          const isLastReasoning = isLastAssistant && pi === m.parts.length - 1
          const isReasoningStreaming = isLastReasoning && isStreaming
          return (
            <details key={`p${pi}`} className="thinking-steps" open={isReasoningStreaming}>
              <summary className="thinking-summary">
                {isReasoningStreaming ? '🧠 推理中…' : '🧠 推理过程'}
              </summary>
              <div className={`thinking-step reasoning ${isReasoningStreaming ? 'stream-cursor' : ''}`}>
                <div className="step-content">{rp.text}</div>
              </div>
            </details>
          )
        }
        case 'text': {
          const tp = part as TextUIPart
          // Check streaming state for last text part
          const isLastText = isLastAssistant && pi === m.parts.length - 1
          const isTextStreaming = isLastText && isStreaming
          return (
            <div key={`p${pi}`} className={`msg-text ${isTextStreaming ? 'stream-cursor' : ''}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {tp.text}
              </ReactMarkdown>
            </div>
          )
        }
        case 'dynamic-tool': {
          const tp = part as any
          const toolName: string = tp.toolName ?? 'tool'
          const toolCallId: string = tp.toolCallId ?? ''
          const state: string = tp.state ?? ''

          // Input available → show tool call with args
          if (state === 'input-available' || state === 'input-streaming') {
            const args = tp.input ? JSON.stringify(tp.input, null, 2) : '{}'
            return (
              <details key={`p${pi}`} className="thinking-steps" open={false}>
                <summary className="thinking-summary">🛠️ {toolName}</summary>
                <div className="thinking-step tool-call">
                  <pre className="step-content">{args}</pre>
                </div>
              </details>
            )
          }

          // Output available → show tool result
          const isError = state === 'output-error'
          const output = isError ? (tp.errorText ?? '') : (tp.output ? JSON.stringify(tp.output, null, 2) : '')
          return (
            <details key={`p${pi}`} className="thinking-steps" open={false}>
              <summary className={`thinking-summary ${isError ? 'tool-error' : ''}`}>
                {isError ? '❌' : '✅'} {toolCallId.slice(0, 8)}…
              </summary>
              <div className={`thinking-step tool-result ${isError ? 'tool-error' : ''}`}>
                <pre className="step-content">{(output as string)?.slice(0, 2000)}{(output as string)?.length > 2000 ? '...(截断)' : ''}</pre>
              </div>
            </details>
          )
        }
        default:
          return null
      }
    })
  }

  return (
    <>
      {/* Topic context hint — enhanced with quick topic pills */}
      {activeTopic && (
        <div className="topic-context-hint">
          <span className="topic-context-label">当前主题:</span>
          <span className="topic-context-name" title={`状态: ${activeTopicData?.status || '—'} · 轮次: ${activeTopicData?.turns ?? 0}`}>
            {activeTopic}
          </span>
          {activeTopicData && (
            <>
              <span className="topic-context-sep">-</span>
              <span className="topic-context-status" style={{ color: getStatusColor(activeTopicData) }}>
                {activeTopicData.status === 'active' ? '活跃' : activeTopicData.status === 'background' ? '后台' : '空闲'}
              </span>
            </>
          )}
          {/* Quick topic pills for recent/active topics */}
          {nonArchived.length > 1 && (
            <span className="topic-context-sep" style={{ marginLeft: 'auto' }}>|</span>
          )}
          {nonArchived.slice(0, 5).map((t: any) => (
            t.name !== activeTopic && (
              <button
                key={t.name}
                className="mention-pill"
                onClick={() => insertQuickRef(t.name)}
                title={`@${t.name} · ${t.status || '—'} · ${t.turns ?? 0}t`}
              >
                @{t.name}
              </button>
            )
          ))}
          {nonArchived.length > 6 && (
            <span className="topic-context-sep" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              +{nonArchived.length - 6}
            </span>
          )}
        </div>
      )}

      <div className="chat-messages" style={{ position: 'relative' }}>
        {isInitialLoading ? (
          <div className="loading-overlay">
            <div className="loading-spinner"></div>
            <p>加载中…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="empty-state">
            <div className="icon">🎣</div>
            <h3>yu-agent + AI SDK</h3>
            <p>输入消息开始对话 &mdash; 输入 <kbd>/</kbd> 使用命令，<kbd>@</kbd> 引用 topic</p>
            <div className="empty-hints">
              <span className="hint">试试: yu help</span>
              <span className="hint">试试: yu doctor</span>
            </div>
          </div>
        ) : (
          <Virtuoso
            className="chat-virtuoso"
            data={messages}
            followOutput
            initialTopMostItemIndex={messages.length - 1}
            itemContent={(index, m) => {
              const content = msgText(m)
              const mentioned = content ? parseMentions(content, topicNames) : []
              const isLastAssistant = index === messages.length - 1 && m.role === 'assistant'

              return (
                <div className={`message ${m.role}`}>
                  <div className={`msg-avatar ${m.role}`}>
                    {m.role === 'user' ? 'U' : m.role === 'system' ? 'S' : 'Y'}
                  </div>
                  <div className="msg-body">
                    <div className="msg-label">
                      {m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'yu'}
                    </div>
                    <div className={`msg-content`}>
                      {renderParts(m, isLastAssistant, isLoading)}
                      {isLastAssistant && isLoading && m.parts.length === 0 && (
                        <span className="thinking-indicator">🤔 思考中…</span>
                      )}
                    </div>
                    {mentioned.length > 0 && (
                      <div className="mention-pills">
                        {mentioned.map((name) => (
                          <button key={name} className="mention-pill" onClick={() => handleMentionClick(name)} title={`切换到 topic: ${name}`}>@{name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            }}
            components={{
              Footer: () => error ? (
                <div className="error-banner" style={{ margin: '8px 16px' }}>
                  <span>❌ 发送失败: {error.message}</span>
                  <button className="error-retry" onClick={() => chat.regenerate()}>重试</button>
                </div>
              ) : null,
            }}
          />
        )}
      </div>

      {/* Dropdown container - aligns with input bar */}
      <div style={{ width: '100%', maxWidth: 680, margin: '0 auto' }}>
        {/* @mention dropdown */}
        {mentionOpen && filteredMentions.length > 0 && (
          <div className="mention-dropdown" ref={mentionRef}>
            {filteredMentions.map((t: any, i: number) => (
              <div
                key={t.name}
                className={`mention-item ${i === mentionIndex ? 'active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); insertMention(t.name) }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <span className="mention-status" style={{ color: getStatusColor(t) }}>
                  {t.status === 'active' ? '▶' : '○'}
                </span>
                <span className="mention-name">{t.name}</span>
                <span className="mention-meta">{t.turns ?? 0}t</span>
                {t.lastActive && (
                  <span className="mention-meta" style={{ minWidth: 'auto', marginLeft: '4px' }}>
                    {new Date(t.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Slash command dropdown */}
        {cmdOpen && filteredCommands.length > 0 && (
          <div className="mention-dropdown cmd-dropdown" style={{ margin: '0 0 4px' }}>
            {filteredCommands.map((cmd, i) => (
              <div
                key={cmd.name}
                className={`mention-item ${i === cmdIndex ? 'active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); insertCommand(cmd.name) }}
                onMouseEnter={() => setCmdIndex(i)}
              >
                <span className="mention-status">/</span>
                <span className="mention-name">{cmd.name}</span>
                <span className="mention-meta" style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-secondary)' }}>
                  {cmd.description}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick reference strip */}
      {nonArchived.length > 0 && (
        <div
          className="quick-ref-wrap"
          ref={quickRefWrapRef}
          onMouseEnter={() => { if (quickRefTimer.current) clearTimeout(quickRefTimer.current); setQuickRefOpen(true) }}
          onMouseLeave={() => { quickRefTimer.current = setTimeout(() => setQuickRefOpen(false), 200) }}
        >
          <span className="quick-ref-label">Topics:</span>
          <div className="quick-ref-strip">
            {nonArchived.slice(0, 5).map((t: any) => (
              <button
                key={t.name}
                className={`quick-topic-btn ${t.name === activeTopic ? 'active' : ''}`}
                onClick={() => insertQuickRef(t.name)}
                title={t.status === 'active' ? '活跃' : '空闲'}
              >
                <span className="qt-dot" style={{ color: getStatusColor(t) }}>●</span>
                <span className="qt-name">{t.name}</span>
              </button>
            ))}
            {nonArchived.length > 5 && <span className="quick-ref-more">+{nonArchived.length - 5}</span>}
          </div>
          {quickRefOpen && (
            <div className="quick-ref-tooltip">
              <div className="qrt-header">所有 topic · {nonArchived.length}</div>
              <div className="qrt-list">
                {nonArchived.map((t: any) => (
                  <div
                    key={t.name}
                    className={`qrt-item ${t.name === activeTopic ? 'active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); insertQuickRef(t.name) }}
                  >
                    <span className="qrt-status" style={{ color: getStatusColor(t) }}>{t.status === 'active' ? '▶' : '○'}</span>
                    <span className="qrt-name">{t.name}</span>
                    <span className="qrt-meta">{t.turns ?? 0}t</span>
                    {t.lastActive && (
                      <span className="qrt-meta" style={{ minWidth: 'auto', marginLeft: 0 }}>
                        {new Date(t.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="chat-input-bar">
        <input
          ref={inputRef}
          value={inputValue}
          onChange={onInputChange}
          onKeyDown={handleKeyDown}
          placeholder={t('input.placeholder')}
          disabled={isLoading}
        />
        {isLoading ? (
          <button className="stop-btn" onClick={() => chat.stop()}>{t('stop')}</button>
        ) : (
          <button onClick={handleSend} disabled={!inputValue.trim()}>{t('send')}</button>
        )}
      </div>

      {/* Status bar */}
      <div className="chat-status-bar">
        <span className={`status-indicator ${connected ? 'connected' : 'disconnected'}`} title={connected ? '已连接' : '已断开'}>
          <span className="status-dot" />
          <span className="status-label">{connected ? '已连接' : '已断开'}</span>
        </span>
        <span className="status-sep">·</span>
        <span className="status-item" title="本轮对话 Token 使用量">
          Token: {tokenUsage.toLocaleString()}
        </span>
        <span className="status-sep">·</span>
        <span className="status-item" title="Agent 循环迭代次数">
          迭代: {agentIterations}
        </span>
        {agentIterations > 0 && (
          <>
            <span className="status-sep">·</span>
            <span className="status-item" title="Token 预算">
              预算: {Math.round((tokenUsage / agentBudget) * 100)}%
            </span>
          </>
        )}
        <span className="status-filler" />
        <span className="status-item status-version">yu v{status.version || '?'}</span>
      </div>
    </>
  )
}
