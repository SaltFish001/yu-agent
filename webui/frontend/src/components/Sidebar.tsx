import { useStore } from '../lib/store'

interface Props {
  panels: Record<string, { label: string; icon: string }>
}

export default function Sidebar({ panels }: Props) {
  const status = useStore((s) => s.status)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
  const clearMessages = useStore((s) => s.clearMessages)

  const ws = status.ws
  const connected = ws?.connected != null && ws.connected > 0
  const wsOnline = status.ws?.connected != null
  const topics = status.topics || []

  return (
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <button className="sidebar-collapse-btn" onClick={toggleSidebar} title={sidebarCollapsed ? '展开' : '折叠'}>
        {sidebarCollapsed ? '›' : '‹'}
      </button>

      <div className="sidebar-header">
        <div className="sidebar-header-top">
          <h1>yu</h1>
          <span className="version">v{status.version || '0.1.0'}</span>
        </div>
        <div className={`status-badge ${wsOnline ? 'online' : 'offline'}`}>
          <span className="indicator" />
          <span>{wsOnline ? '在线' : '离线'}</span>
        </div>
      </div>

      <div className="sidebar-body">
        {/* System */}
        <div className="sidebar-section">
          <h2>系统</h2>
          <div className="stat-row">
            <span className="stat-label">Uptime</span>
            <span className="stat-value">{fmtDuration(status.uptime || 0)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">RSS</span>
            <span className="stat-value">{fmtBytes(status.memory?.rss || 0)}</span>
          </div>
        </div>

        {/* Topics */}
        <div className="sidebar-section">
          <h2>主题 <span className="count">{topics.length}</span></h2>
          {topics.length > 0 ? (
            topics.slice(0, 5).map((t) => (
              <div key={t.name} className={`topic-item ${t.name === status.activeTopic ? 'active' : ''}`}>
                <span className="topic-status">{t.status === 'active' ? '▶' : t.status === 'background' ? '⏳' : '○'}</span>
                <span className="item-name">{t.name}</span>
                <span className="item-desc">{t.turns}t</span>
              </div>
            ))
          ) : (
            <span className="sidebar-hint">暂无主题</span>
          )}
          {topics.length > 5 && <div className="list-more">+{topics.length - 5} more</div>}
        </div>

        {/* WebSocket */}
        <div className="sidebar-section">
          <h2>WebSocket</h2>
          <div className="stat-row"><span className="stat-label">状态</span><span className="stat-value" style={{ color: wsOnline ? 'var(--green)' : 'var(--red)' }}>{wsOnline ? '🟢 在线' : '🔴 离线'}</span></div>
          <div className="stat-row"><span className="stat-label">客户端</span><span className="stat-value">{ws?.connected || 0} (累计 {ws?.total || 0})</span></div>
          <div className="stat-row"><span className="stat-label">消息</span><span className="stat-value">{(ws?.messagesSent || 0).toLocaleString()}</span></div>
          <div className="stat-row"><span className="stat-label">WS 运行</span><span className="stat-value">{fmtDuration(ws?.uptimeSec || 0)}</span></div>
        </div>
      </div>

      {/* Actions */}
      <div className="sidebar-toggle-section">
        <button className="sidebar-btn" onClick={clearMessages} title="清空对话">
          🗑 <span>清空</span>
        </button>
        <button className="sidebar-btn" onClick={() => setActivePanel('chat')} title="新对话">
          ✕ <span>新对话</span>
        </button>
      </div>

      <div className="sidebar-footer">
        <div className="stat-row">
          <span className="stat-label">请求</span>
          <span className="stat-value">-</span>
        </div>
      </div>
    </aside>
  )
}

function fmtDuration(s: number): string {
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

function fmtBytes(b: number): string {
  if (b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}
