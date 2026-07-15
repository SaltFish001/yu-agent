import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { getStoredTheme, applyTheme, type Theme } from '../lib/theme'
import { setLang, t } from '../lib/i18n'

type Item = {
  id: string
  label: string
  hint?: string
  group: string
  keywords?: string
  run: () => void
}

function toggleTheme() {
  const cur = getStoredTheme()
  const next: Theme = cur === 'light' ? 'dark' : 'light'
  applyTheme(next)
}

function toggleLang() {
  const cur = (localStorage.getItem('yu-lang') || 'zh') === 'zh' ? 'en' : 'zh'
  setLang(cur)
  window.dispatchEvent(new CustomEvent('yu-lang-change', { detail: cur }))
}

export default function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const activeTopic = useStore((s) => s.activeTopic)
  const setActiveTopic = useStore((s) => s.setActiveTopic)
  const topics = useStore((s) => s.status.topics) || []

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    const app: Item[] = [
      { id: 'new-chat', label: t('cmd.new.chat'), hint: '清空当前会话', group: t('cmd.group.app'), keywords: 'new chat clear', run: () => window.dispatchEvent(new CustomEvent('yu:new-chat')) },
      { id: 'toggle-sidebar', label: t('cmd.toggle.sidebar'), hint: 'Cmd/Ctrl + .', group: t('cmd.group.app'), keywords: 'sidebar', run: () => useStore.getState().toggleSidebar() },
      { id: 'toggle-theme', label: t('cmd.toggle.theme'), hint: '深色 / 浅色', group: t('cmd.group.app'), keywords: 'theme dark light', run: toggleTheme },
      { id: 'toggle-lang', label: t('cmd.toggle.lang'), hint: '中文 / English', group: t('cmd.group.app'), keywords: 'language lang zh en', run: toggleLang },
      { id: 'open-settings', label: t('cmd.open.settings'), group: t('cmd.group.app'), keywords: 'settings', run: () => useStore.getState().setSettingsOpen(true) },
      { id: 'new-topic', label: t('cmd.new.topic'), group: t('cmd.group.app'), keywords: 'topic create', run: () => window.dispatchEvent(new CustomEvent('yu:open-create')) },
    ]
    const wins: Item[] = [
      { id: 'win-status', label: `${t('cmd.open')} ${t('nav.status')}`, group: t('cmd.group.win'), keywords: 'status dashboard 系统状态', run: () => useStore.getState().openWindow('status') },
      { id: 'win-bg', label: `${t('cmd.open')} ${t('nav.bg')}`, group: t('cmd.group.win'), keywords: 'background 后台', run: () => useStore.getState().openWindow('bg') },
      { id: 'win-terminal', label: `${t('cmd.open')} ${t('nav.terminal')}`, group: t('cmd.group.win'), keywords: 'terminal 终端', run: () => useStore.getState().openWindow('terminal') },
      { id: 'win-files', label: `${t('cmd.open')} ${t('nav.files')}`, group: t('cmd.group.win'), keywords: 'files 文件', run: () => useStore.getState().openWindow('files') },
      { id: 'win-rules', label: `${t('cmd.open')} ${t('nav.rules')}`, group: t('cmd.group.win'), keywords: 'rules 规则', run: () => useStore.getState().openWindow('rules') },
      { id: 'win-skills', label: `${t('cmd.open')} ${t('nav.skills')}`, group: t('cmd.group.win'), keywords: 'skills 技能', run: () => useStore.getState().openWindow('skills') },
    ]
    const topicItems: Item[] = topics
      .filter((t) => !t.archived)
      .map((t) => ({
        id: `topic:${t.name}`,
        label: `切换到 ${t.name}`,
        hint: (t.status || 'idle') + (t.name === activeTopic ? ' · 当前' : ''),
        group: '主题',
        keywords: `topic switch ${t.name}`,
        run: () => {
          setActiveTopic(t.name)
          window.dispatchEvent(new CustomEvent('yu:switch-topic', { detail: t.name }))
        },
      }))
    return [...app, ...wins, ...topicItems]
  }, [topics, activeTopic, setActiveTopic])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => (i.label + ' ' + (i.keywords || '') + ' ' + i.group).toLowerCase().includes(q))
  }, [items, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  const close = () => setOpen(false)
  const runItem = (it: Item) => {
    it.run()
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[index]) runItem(filtered[index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  // group items preserving order
  let lastGroup = ''
  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="cmdk-input-wrap">
          <span className="cmdk-prompt">⌘</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="输入命令或搜索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="cmdk-esc">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 && <div className="cmdk-empty">无匹配结果</div>}
          {filtered.map((it, i) => {
            const showGroup = it.group !== lastGroup
            lastGroup = it.group
            return (
              <div key={it.id}>
                {showGroup && <div className="cmdk-group">{it.group}</div>}
                <div
                  className={`cmdk-item ${i === index ? 'active' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(e) => { e.preventDefault(); runItem(it) }}
                >
                  <span className="cmdk-label">{it.label}</span>
                  {it.hint && <span className="cmdk-hint">{it.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
