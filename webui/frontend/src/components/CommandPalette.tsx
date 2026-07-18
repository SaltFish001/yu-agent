import { useState, useEffect, useRef } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

const COMMANDS = [
  { id: 'new-chat', label: '新建对话', shortcut: '⌘N', action: () => window.dispatchEvent(new CustomEvent('yu:new-chat')) },
  { id: 'toggle-sidebar', label: '切换侧边栏', shortcut: '⌘.', action: () => useStore.getState().toggleSidebar() },
  { id: 'settings', label: '设置', shortcut: '', action: () => useStore.getState().setSettingsOpen(true) },
  { id: 'status', label: '系统状态', shortcut: '', action: () => useStore.getState().openWindow('status') },
  { id: 'terminal', label: '终端', shortcut: '', action: () => useStore.getState().openWindow('terminal') },
  { id: 'files', label: '文件浏览器', shortcut: '', action: () => useStore.getState().openWindow('files') },
  { id: 'bg', label: '后台任务', shortcut: '', action: () => useStore.getState().openWindow('bg') },
  { id: 'rules', label: '规则', shortcut: '', action: () => useStore.getState().openWindow('rules') },
  { id: 'skills', label: '技能', shortcut: '', action: () => useStore.getState().openWindow('skills') },
]

export default function CommandPalette() {
  const paletteOpen = useStore((s) => s.paletteOpen)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)
  const topics = useStore((s) => s.status.topics || [])
  const setActiveTopic = useStore((s) => s.setActiveTopic)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (paletteOpen) {
      setQuery('')
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [paletteOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!paletteOpen)
      }
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, setPaletteOpen])

  const topicItems = topics.map((t: any) => ({
    id: `topic-${t.name}`,
    label: t.name,
    group: 'Topics',
    action: () => {
      setActiveTopic(t.name)
      setPaletteOpen(false)
    },
  }))

  const allItems = [
    ...COMMANDS.map((c) => ({ ...c, group: '应用' })),
    ...topicItems,
  ]

  const filtered = query
    ? allItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    : allItems

  const groups = filtered.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = []
    acc[item.group].push(item)
    return acc
  }, {} as Record<string, typeof allItems>)

  const flatItems = Object.values(groups).flat()

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[selected]
      if (item) {
        item.action()
        setPaletteOpen(false)
      }
    }
  }

  if (!paletteOpen) return null

  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh]" onClick={() => setPaletteOpen(false)}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-[560px] max-w-[92vw] bg-bg-elev border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <span className="text-accent text-lg">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={handleKeyDown}
            placeholder="搜索命令或 topic..."
            className="flex-1 bg-transparent text-text text-base outline-none placeholder:text-text-tertiary"
          />
          <span className="text-xs text-text-tertiary px-2 py-1 border border-border rounded">ESC</span>
        </div>

        {/* List */}
        <div className="overflow-y-auto p-2">
          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div className="px-3 py-1.5 text-[10px] text-text-tertiary uppercase tracking-wider">{group}</div>
              {items.map((item, idx) => {
                const globalIdx = flatItems.indexOf(item)
                return (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${
                      globalIdx === selected ? 'bg-accent/10 text-text' : 'text-text-secondary hover:bg-bg-hover'
                    }`}
                    onClick={() => { item.action(); setPaletteOpen(false) }}
                    onMouseEnter={() => setSelected(globalIdx)}
                  >
                    <span>{item.label}</span>
                    {(item as any).shortcut && (
                      <span className="text-xs text-text-tertiary">{(item as any).shortcut}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {flatItems.length === 0 && (
            <div className="p-6 text-center text-sm text-text-tertiary">无匹配结果</div>
          )}
        </div>
      </div>
    </div>
  )
}
