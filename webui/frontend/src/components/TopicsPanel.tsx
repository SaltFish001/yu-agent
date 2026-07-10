import { useState } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

export default function TopicsPanel() {
  const status = useStore((s) => s.status)
  const topics = status.topics || []
  const [filter, setFilter] = useState('')

  const filtered = filter
    ? topics.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : topics

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
              <tr key={t.name} onClick={() => {}}>
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
