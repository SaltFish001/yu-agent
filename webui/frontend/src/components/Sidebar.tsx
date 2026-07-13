import { useState } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import { fetchTopicDetail, deleteTopic, archiveTopic, renameTopic } from '../lib/api'
import { uuid } from '../lib/uuid'

export default function Sidebar() {
  const status = useStore((s) => s.status)
  const topicSearch = useStore((s) => s.topicSearch)
  const setTopicSearch = useStore((s) => s.setTopicSearch)
  const activeTopic = useStore((s) => s.activeTopic)
  const setActiveTopic = useStore((s) => s.setActiveTopic)
  const addMessage = useStore((s) => s.addMessage)

  const topics = status.topics || []
  const filtered = topicSearch
    ? topics.filter((t) => t.name.toLowerCase().includes(topicSearch.toLowerCase()))
    : topics

  // Active first, then by name, archived last
  const sorted = [...filtered].sort((a, b) => {
    if (a.name === activeTopic) return -1
    if (b.name === activeTopic) return 1
    if (a.archived && !b.archived) return 1
    if (!a.archived && b.archived) return -1
    return a.name.localeCompare(b.name)
  })

  const [creating, setCreating] = useState(false)
  const [newTopicName, setNewTopicName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ topic: any; x: number; y: number } | null>(null)

  const openAdmin = () => {
    const url = window.location.origin + window.location.pathname + '#/admin'
    window.open(url, 'yu-admin', 'width=900,height=680,resizable=yes,scrollbars=yes')
  }

  const handleTopicClick = async (name: string) => {
    setActiveTopic(name)
    addMessage({ role: 'system', content: `📂 加载主题: ${name}...`, id: uuid() })
    try {
      const detail = await fetchTopicDetail(name)
      const lines: string[] = []
      lines.push(`# 📁 ${detail.topic.name}`)
      lines.push('')
      lines.push(`**状态:** ${detail.topic.status}  |  **目录:** \`${detail.topic.dir}\``)
      lines.push(`**轮次:** ${detail.topic.turns}  |  **创建:** ${detail.topic.createdAt ? new Date(detail.topic.createdAt).toLocaleDateString() : '-'}`)
      if (detail.topic.summary) lines.push(`**摘要:** ${detail.topic.summary}`)
      lines.push('')
      lines.push('---')
      lines.push(`🖥 在 \`${detail.topic.dir}\` 目录下打开终端`)
      lines.push('')

      // File tree
      lines.push('## 📄 文件')
      lines.push('')
      if (detail.files.length > 0) {
        const dirs = detail.files.filter((f: any) => f.isDir)
        const files = detail.files.filter((f: any) => !f.isDir)
        for (const d of dirs) lines.push(`📁 \`${d.name}/\``)
        for (const f of files) lines.push(`📄 \`${f.name}\`  (${fmtBytes(f.size)})`)
      } else {
        lines.push('*(目录不存在或为空)*')
      }
      lines.push('')

      // Git status
      if (detail.git?.hasGit) {
        lines.push('## 🔄 Git')
        lines.push('')
        if (detail.git.lastCommit) lines.push(`**最后提交:** \`${detail.git.lastCommit}\``)
        if (detail.git.diffStat) {
          lines.push('')
          lines.push('**未提交变更:**')
          lines.push('```')
          lines.push(detail.git.diffStat)
          lines.push('```')
        }
      }

      addMessage({ role: 'system', content: lines.join('\n'), id: uuid() })
    } catch (e) {
      addMessage({ role: 'system', content: `❌ 加载主题失败: ${(e as Error).message}`, id: uuid() })
    }
  }

  const getStatusColor = (t: any): string => {
    if (t.status === 'active') return '#22c55e'
    if (t.status === 'background') return '#3b82f6'
    if (t.status === 'error') return '#ef4444'
    return '#6b7280'
  }

  const getStatusIcon = (t: any): string => {
    if (t.status === 'active') return '▶'
    if (t.status === 'background') return '⏳'
    if (t.status === 'error') return '✕'
    return '○'
  }

  const getStatusLabel = (t: any): string => {
    if (t.status === 'active') return '活跃'
    if (t.status === 'background') return '后台'
    if (t.status === 'error') return '错误'
    return '空闲'
  }

  const formatDate = (s: string): string => {
    try { return new Date(s).toLocaleString() } catch { return s }
  }

  const handleCreateTopic = () => {
    if (newTopicName.trim()) {
      addMessage({ role: 'system', content: `📂 创建主题: ${newTopicName.trim()}...`, id: uuid() })
      setNewTopicName('')
      setCreating(false)
    }
  }

  const handleRename = async (oldName: string, newName: string) => {
    if (newName.trim() && newName !== oldName) {
      try {
        await renameTopic(oldName, newName.trim())
        useStore.getState().refreshStatus()
        addMessage({ role: 'system', content: `✏️ 重命名主题: ${oldName} → ${newName.trim()}`, id: uuid() })
      } catch (e) {
        addMessage({ role: 'system', content: `❌ 重命名失败: ${(e as Error).message}`, id: uuid() })
      }
    }
    setRenaming(null)
    setRenameValue('')
  }

  const handleArchive = async (name: string) => {
    try {
      await archiveTopic(name)
      addMessage({ role: 'system', content: `📦 归档主题: ${name}`, id: uuid() })
    } catch (e) {
      addMessage({ role: 'system', content: `❌ 归档失败: ${(e as Error).message}`, id: uuid() })
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`确定要删除主题「${name}」吗？此操作不可撤销。`)) return
    try {
      await deleteTopic(name)
      useStore.getState().refreshStatus()
      addMessage({ role: 'system', content: `🗑️ 已删除主题: ${name}`, id: uuid() })
    } catch (e) {
      addMessage({ role: 'system', content: `❌ 删除失败: ${(e as Error).message}`, id: uuid() })
    }
  }

  const handleSwitch = (name: string) => {
    handleTopicClick(name)
  }

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="sidebar-brand">
        <span className="brand-icon">y</span>
      </div>

      {/* Create topic button */}
      <div className="topic-create-wrap">
        {creating ? (
          <div className="topic-create-input">
 <input
   type="text"
   placeholder={t('create.topic.hint')}
              value={newTopicName}
              onChange={(e) => setNewTopicName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateTopic()
                if (e.key === 'Escape') { setCreating(false); setNewTopicName('') }
              }}
              autoFocus
            />
            <button className="topic-create-confirm" onClick={handleCreateTopic} title="确认创建">✓</button>
            <button className="topic-create-cancel" onClick={() => { setCreating(false); setNewTopicName('') }} title="取消">✕</button>
          </div>
        ) : (
          <button className="topic-create-btn" onClick={() => setCreating(true)} title="创建新 topic">
            + 新建 Topic
          </button>
        )}
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

      {/* Topic list */}
      <nav className="topic-list">
        {sorted.length > 0 ? sorted.map((t) => (
          <div
            key={t.name}
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
              setTooltip((prev) => {
                if (!prev) return null
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                return { ...prev, y: Math.max(8, rect.top) }
              })
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            <span className="topic-status" style={{ color: getStatusColor(t) }}>{getStatusIcon(t)}</span>
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
                addMessage({ role: 'system', content: `终端功能待实现: ${t.name}`, id: uuid() })
              }}
              title="打开终端"
            >$_</button>
          </div>
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
        <button className="sb-btn" onClick={openAdmin} aria-label={t('status')} title={t('status')}>📊 {t('status')}</button>
      </div>
    </aside>
  )
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}
