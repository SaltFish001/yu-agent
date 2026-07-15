import { useState, Fragment, useEffect } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import { deleteTopic, archiveTopic, renameTopic } from '../lib/api'
import CreateTopicModal from './CreateTopicModal'
import TopicDetailDrawer from './TopicDetailDrawer'
import { getStatusColor, getStatusLabel, getDotClass } from '../lib/status'

export default function Sidebar() {
  const status = useStore((s) => s.status)
  const topicSearch = useStore((s) => s.topicSearch)
  const setTopicSearch = useStore((s) => s.setTopicSearch)
  const activeTopic = useStore((s) => s.activeTopic)
  const setActiveTopic = useStore((s) => s.setActiveTopic)
  const pushToast = useStore((s) => s.pushToast)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  const topics = status.topics || []
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('all')
  const filtered = topics.filter((t) => {
    if (topicSearch && !t.name.toLowerCase().includes(topicSearch.toLowerCase())) return false
    if (filter === 'active' && (t.archived || t.status !== 'active')) return false
    if (filter === 'archived' && !t.archived) return false
    return true
  })

  // Active first, then by name, archived last
  const sorted = [...filtered].sort((a, b) => {
    if (a.name === activeTopic) return -1
    if (b.name === activeTopic) return 1
    if (a.archived && !b.archived) return 1
    if (!a.archived && b.archived) return -1
    return a.name.localeCompare(b.name)
  })

  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [detailName, setDetailName] = useState<string | null>(null)

  // Open create-topic modal from command palette
  useEffect(() => {
    const onOpen = () => setCreating(true)
    window.addEventListener('yu:open-create', onOpen)
    return () => window.removeEventListener('yu:open-create', onOpen)
  }, [])

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ topic: any; x: number; y: number } | null>(null)

  const handleTopicClick = (name: string) => {
    setActiveTopic(name)
  }

  const formatDate = (s: string): string => {
    try { return new Date(s).toLocaleString() } catch { return s }
  }

  const handleCreatedTopic = (name: string) => {
    useStore.getState().refreshStatus()
    setActiveTopic(name)
    pushToast({ type: 'success', message: `已创建主题: ${name}` })
  }

  const handleDetailArchive = async (name: string) => {
    try {
      await archiveTopic(name)
      useStore.getState().refreshStatus()
      pushToast({ type: 'success', message: `已归档主题: ${name}` })
    } catch (e) {
      pushToast({ type: 'error', message: `归档失败: ${(e as Error).message}` })
    }
    setDetailName(null)
  }

  const handleDetailRename = (name: string) => {
    setDetailName(null)
    setRenaming(name)
    setRenameValue(name)
  }

  const handleRename = async (oldName: string, newName: string) => {
    if (newName.trim() && newName !== oldName) {
      try {
        await renameTopic(oldName, newName.trim())
        useStore.getState().refreshStatus()
        pushToast({ type: 'success', message: `重命名主题: ${oldName} → ${newName.trim()}` })
      } catch (e) {
        pushToast({ type: 'error', message: `重命名失败: ${(e as Error).message}` })
      }
    }
    setRenaming(null)
    setRenameValue('')
  }

  const handleArchive = async (name: string) => {
    try {
      await archiveTopic(name)
      pushToast({ type: 'success', message: `已归档主题: ${name}` })
    } catch (e) {
      pushToast({ type: 'error', message: `归档失败: ${(e as Error).message}` })
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`确定要删除主题「${name}」吗？此操作不可撤销。`)) return
    try {
      await deleteTopic(name)
      useStore.getState().refreshStatus()
      pushToast({ type: 'success', message: `已删除主题: ${name}` })
    } catch (e) {
      pushToast({ type: 'error', message: `删除失败: ${(e as Error).message}` })
    }
  }

  const handleSwitch = (name: string) => {
    handleTopicClick(name)
  }

  return (
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <button className="sidebar-toggle" onClick={toggleSidebar} title="切换侧边栏 (Cmd/Ctrl + .)" aria-label="切换侧边栏">
        ☰
      </button>
      {/* Brand */}
      <div className="sidebar-brand">
        <span className="brand-icon">y</span>
      </div>

      {/* Create topic button */}
      <div className="topic-create-wrap">
        <button className="topic-create-btn" onClick={() => setCreating(true)} title="创建新 topic">
          + 新建 Topic
        </button>
      </div>

      {/* Topic search */}
      <div className="topic-search-wrap">
        <input
          className="topic-search"
          type="text"
          placeholder={t('search.topic')}
          value={topicSearch}
          onChange={(e) => setTopicSearch(e.target.value)}
        />
      </div>

      {/* Status filter */}
      <div className="topic-filter">
        {(['all', 'active', 'archived'] as const).map((f) => (
          <button
            key={f}
            className={`topic-filter-btn ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? '全部' : f === 'active' ? '活跃' : '归档'}
          </button>
        ))}
      </div>

      {/* Topic list */}
      <nav className="topic-list">
        {sorted.length > 0 ? sorted.map((t, idx) => (
          <Fragment key={t.name}>
          {idx > 0 && !t.archived && sorted[idx - 1].archived && (
            <div className="topic-archived-divider">已归档</div>
          )}
          <div
            className={`topic-item ${t.name === activeTopic ? 'active' : ''} ${t.archived ? 'archived' : ''}`}
            onClick={() => handleTopicClick(t.name)}
            onMouseEnter={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              // Smart positioning: if tooltip would overflow right, show on left
              const tooltipW = 220
              const spaceRight = window.innerWidth - rect.right - 16
              const x = spaceRight >= tooltipW ? rect.right + 8 : rect.left - tooltipW - 8
              setTooltip({ topic: t, x, y: Math.max(8, rect.top) })
            }}
            onMouseMove={(e) => {
              // Keep tooltip Y aligned with topic item
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setTooltip((prev) => (prev ? { ...prev, y: Math.max(8, rect.top) } : null))
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            <span className="topic-status"><span className={`topic-dot ${getDotClass(t)}`} /></span>
            {renaming === t.name ? (
              <div className="topic-rename-input">
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(t.name, renameValue)
                    if (e.key === 'Escape') { setRenaming(null); setRenameValue('') }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              </div>
            ) : (
              <span
                className="topic-name"
                onDoubleClick={(e) => { e.stopPropagation(); setRenaming(t.name); setRenameValue(t.name) }}
              >{t.name}</span>
            )}
            <span className="topic-turns">{t.turns}t</span>
            {t.archived && <span className="topic-archived">📦</span>}
            <div className="topic-hover-actions">
              <button
                className="topic-action-btn detail"
                onClick={(e) => { e.stopPropagation(); setDetailName(t.name) }}
                title="查看详情"
              >ℹ</button>
              <button
                className="topic-action-btn switch"
                onClick={(e) => { e.stopPropagation(); handleSwitch(t.name) }}
                title="切换到此 topic"
              >⇄</button>
              <button
                className="topic-action-btn archive"
                onClick={(e) => { e.stopPropagation(); handleArchive(t.name) }}
                title="归档 topic"
              >📦</button>
              <button
                className="topic-action-btn rename"
                onClick={(e) => { e.stopPropagation(); setRenaming(t.name); setRenameValue(t.name) }}
                title="重命名 topic"
              >✏️</button>
              <button
                className="topic-action-btn delete"
                onClick={(e) => { e.stopPropagation(); handleDelete(t.name) }}
                title="删除 topic"
              >🗑️</button>
            </div>
            <button
              className="topic-term-btn"
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().openWindow('terminal')
              }}
              title="打开终端"
            >$_</button>
          </div>
          </Fragment>
        )) : (
          <div className="topic-empty">
            {topicSearch ? t('no.match') : t('no.topics')}
          </div>
        )}
      </nav>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="topic-tooltip-fixed"
          style={{ position: 'fixed', left: tooltip.x, top: tooltip.y, zIndex: 1000 }}
          onMouseEnter={() => setTooltip(tooltip)}
          onMouseLeave={() => setTooltip(null)}
        >
          <div className="tt-header">{tooltip.topic.name}</div>
          <div className="tt-body">
            <div className="tt-row">
              <span className="tt-label">状态</span>
              <span className="tt-value" style={{ color: getStatusColor(tooltip.topic) }}>{getStatusLabel(tooltip.topic)}</span>
            </div>
            <div className="tt-row">
              <span className="tt-label">轮次</span>
              <span className="tt-value">{tooltip.topic.turns ?? 0}</span>
            </div>
            {tooltip.topic.lastActive && (
              <div className="tt-row">
                <span className="tt-label">上次活跃</span>
                <span className="tt-value">{formatDate(tooltip.topic.lastActive)}</span>
              </div>
            )}
            {tooltip.topic.archived && (
              <div className="tt-row">
                <span className="tt-label">归档</span>
                <span className="tt-value">📦 已归档</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="sidebar-footer">
        <button className="sb-btn" onClick={() => useStore.getState().setSettingsOpen(true)} aria-label={t('settings')} title={t('settings')}>⚙️ {t('settings')}</button>
        <button className="sb-btn" onClick={() => useStore.getState().openWindow('status')} aria-label={t('status')} title={t('status')}>📊 {t('status')}</button>
      </div>

      <CreateTopicModal open={creating} onClose={() => setCreating(false)} onCreated={handleCreatedTopic} />
      <TopicDetailDrawer
        open={detailName !== null}
        name={detailName}
        onClose={() => setDetailName(null)}
        onSwitch={handleSwitch}
        onArchive={handleDetailArchive}
        onRename={handleDetailRename}
      />
    </aside>
  )
}

