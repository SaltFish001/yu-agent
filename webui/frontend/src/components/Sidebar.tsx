import { useState, Fragment } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import { deleteTopic, archiveTopic, renameTopic } from '../lib/api'
import CreateTopicModal from './CreateTopicModal'
import TopicDetailDrawer from './TopicDetailDrawer'
import { getStatusColor, getStatusLabel } from '../lib/status'

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

  const handleCreatedTopic = (name: string) => {
    useStore.getState().refreshStatus()
    setActiveTopic(name)
    pushToast({ type: 'success', message: `已创建主题: ${name}` })
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

  return (
    <aside className={`flex flex-col bg-bg-sidebar border-r border-border transition-all duration-300 ${sidebarCollapsed ? 'w-16' : 'w-64'}`}>
      {/* Brand */}
      <div className="flex items-center gap-3 p-4 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-accent text-on-accent flex items-center justify-center text-sm font-bold shadow-glow">
          y
        </div>
        {!sidebarCollapsed && <span className="text-text font-semibold text-sm">yu-agent</span>}
      </div>

      {/* Search & Filter */}
      {!sidebarCollapsed && (
        <div className="p-3 space-y-2">
          <input
            type="text"
            placeholder={t('search.topic')}
            value={topicSearch}
            onChange={(e) => setTopicSearch(e.target.value)}
            className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-tertiary focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
          />
          <div className="flex gap-1 p-1 bg-bg-surface rounded-lg">
            {(['all', 'active', 'archived'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex-1 py-1 text-xs rounded-md transition-colors ${
                  filter === f
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-tertiary hover:text-text'
                }`}
              >
                {f === 'all' ? '全部' : f === 'active' ? '活跃' : '归档'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Topic List */}
      <nav className="flex-1 overflow-y-auto px-2 space-y-1">
        {sorted.length > 0 ? (
          sorted.map((t, idx) => (
            <Fragment key={t.name}>
              {idx > 0 && !t.archived && sorted[idx - 1].archived && (
                <div className="pt-2 pb-1 px-2 text-xs text-text-tertiary uppercase tracking-wider">已归档</div>
              )}
              <div
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all ${
                  t.name === activeTopic
                    ? 'bg-accent/10 text-accent'
                    : 'hover:bg-bg-hover text-text-secondary'
                }`}
                onClick={() => setActiveTopic(t.name)}
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    t.status === 'active'
                      ? 'bg-ok shadow-[0_0_6px_rgba(0,229,160,0.5)]'
                      : t.status === 'background'
                      ? 'bg-accent shadow-[0_0_6px_rgba(0,212,255,0.5)]'
                      : t.status === 'error'
                      ? 'bg-err'
                      : 'bg-text-muted'
                  }`}
                />
                {!sidebarCollapsed && (
                  <>
                    <span className="flex-1 truncate text-sm">{t.name}</span>
                    <span className="text-xs text-text-tertiary tabular-nums">{t.turns}t</span>
                    {t.archived && <span className="text-xs">📦</span>}
                  </>
                )}
              </div>
            </Fragment>
          ))
        ) : (
          <div className="p-4 text-center text-sm text-text-tertiary">
            {topicSearch ? t('no.match') : t('no.topics')}
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-border space-y-1">
        <button
          onClick={() => setCreating(true)}
          className="w-full py-2 px-3 text-sm text-text-tertiary hover:text-text hover:bg-bg-hover rounded-lg transition-colors text-left"
        >
          + 新建 Topic
        </button>
        <button
          onClick={() => useStore.getState().setSettingsOpen(true)}
          className="w-full py-2 px-3 text-sm text-text-tertiary hover:text-text hover:bg-bg-hover rounded-lg transition-colors text-left"
        >
          ⚙️ {t('settings')}
        </button>
      </div>

      <CreateTopicModal open={creating} onClose={() => setCreating(false)} onCreated={handleCreatedTopic} />
      <TopicDetailDrawer
        open={detailName !== null}
        name={detailName}
        onClose={() => setDetailName(null)}
        onSwitch={setActiveTopic}
        onArchive={handleArchive}
        onRename={(name) => {
          setDetailName(null)
          setRenaming(name)
          setRenameValue(name)
        }}
      />
    </aside>
  )
}
