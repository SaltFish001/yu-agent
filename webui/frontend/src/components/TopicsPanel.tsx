import { useState } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import { PanelLoading, ErrorState } from './primitives'

export default function TopicsPanel() {
  const status = useStore((s) => s.status)
  const statusLoaded = useStore((s) => s.statusLoaded)
  const connected = useStore((s) => s.connected)
  const refreshStatus = useStore((s) => s.refreshStatus)
  const setActiveTopic = useStore((s) => s.setActiveTopic)
  const setMainView = useStore((s) => s.setMainView)
  const topics = status.topics || []
  const [filter, setFilter] = useState('')

  const filtered = filter
    ? topics.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : topics

  const handleRowClick = (name: string) => {
    setActiveTopic(name)
    setMainView('chat')
  }

  if (!statusLoaded) {
    return (
      <>
        <div className="panel-header"><h2>{t('topic.title')}</h2></div>
        <PanelLoading />
      </>
    )
  }
  if (!connected) {
    return (
      <>
        <div className="panel-header"><h2>{t('topic.title')}</h2></div>
        <ErrorState message={t('panel.disconnected')} onRetry={refreshStatus} />
      </>
    )
  }

  return (
    <>
      <div className="panel-header"><h2>{t('topic.title')} ({topics.length})</h2></div>
      <input
        className="panel-filter"
        placeholder={t('topic.filter')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('topic.name')}</th>
              <th>{t('topic.status')}</th>
              <th>{t('topic.turns')}</th>
              <th>{t('topic.last.active')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length > 0 ? filtered.map((t) => (
              <tr key={t.name} className="clickable-row" onClick={() => handleRowClick(t.name)}>
                <td>{t.name}</td>
                <td>
                  <span className={`status-tag tag-${t.status || 'pending'}`}>
                    <span className="tag-dot" />
                    {t.status || '—'}
                  </span>
                </td>
                <td>{t.turns || 0}</td>
                <td>{t.lastActive ? new Date(t.lastActive).toLocaleString() : '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={4}><span className="hint">{t('topic.none')}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
