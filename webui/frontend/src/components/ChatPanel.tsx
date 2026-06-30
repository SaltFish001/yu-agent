import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useStore } from '../lib/store'
import { sendChat, streamChat } from '../lib/api'

export default function ChatPanel() {
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => s.streaming)
  const addMessage = useStore((s) => s.addMessage)
  const appendToLastMessage = useStore((s) => s.appendToLastMessage)
  const finalizeStream = useStore((s) => s.finalizeStream)
  const setStreaming = useStore((s) => s.setStreaming)
  const clearMessages = useStore((s) => s.clearMessages)

  const [input, setInput] = useState('')
  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const ctrlRef = useRef<AbortController | null>(null)

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
    })
  }, [])

  useEffect(() => { scrollBottom() }, [messages, scrollBottom])

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    addMessage({ role: 'user', content: text, id: crypto.randomUUID() })
    scrollBottom()

    const msgId = crypto.randomUUID()
    addMessage({ role: 'assistant', content: '', id: msgId })
    setStreaming(true)
    scrollBottom()

    try {
      const res = await sendChat(text)
      // Non-streaming fallback
      if (res.content) {
        appendToLastMessage(res.content || JSON.stringify(res))
        finalizeStream()
        scrollBottom()
        return
      }
    } catch {
      // Fallback to streaming
    }

    // Try streaming
    ctrlRef.current = streamChat(text, (chunk, done) => {
      if (chunk) appendToLastMessage(chunk)
      if (done) {
        finalizeStream()
        scrollBottom()
      } else {
        scrollBottom()
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <>
      <div className="chat-messages" ref={chatRef}>
        {messages.length === 0 && !streaming ? (
          <div className="empty-state">
            <div className="icon">🎣</div>
            <h3>yu-agent</h3>
            <p>输入消息开始对话</p>
            <div className="empty-hints">
              <span className="hint">试试: yu help</span>
              <span className="hint">试试: yu doctor</span>
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <div className={`msg-avatar ${m.role}`}>
                {m.role === 'user' ? 'U' : 'Y'}
              </div>
              <div className="msg-body">
                <div className="msg-label">{m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'yu'}</div>
                <div className={`msg-content ${m.id === messages[messages.length - 1]?.id && streaming && m.role === 'assistant' && !m.content ? 'stream-cursor' : ''}`}>
                  {m.content ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                    >
                      {m.content}
                    </ReactMarkdown>
                  ) : streaming && m.role === 'assistant' ? (
                    <span className="stream-cursor" />
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="chat-input-bar">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          disabled={streaming}
        />
        <button onClick={handleSend} disabled={!input.trim() || streaming}>
          {streaming ? '…' : '发送'}
        </button>
      </div>
    </>
  )
}
