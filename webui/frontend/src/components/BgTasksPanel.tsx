import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import { PanelLoading, ErrorState } from './primitives'
import { fmtMs } from '../lib/format'

export default function BgTasksPanel() {
  const status = useStore((s) => s.status)
  const statusLoaded = useStore((s) => s.statusLoaded)
  const connected = useStore((s) => s.connected)
  const refreshStatus = useStore((s) => s.refreshStatus)
  const tasks = status.backgroundTasks || []

  if (!statusLoaded) {
    return (
      <>
        <div className="panel-header"><h2>{t('bg.title')}</h2></div>
        <PanelLoading />
      </>
    )
  }
  if (!connected) {
    return (
      <>
        <div className="panel-header"><h2>{t('bg.title')}</h2></div>
        <ErrorState message={t('panel.disconnected')} onRetry={refreshStatus} />
      </>
    )
  }

  return (
    <>
      <div className="panel-header"><h2>{t('bg.title')}</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>{t('bg.type')}</th>
              <th>{t('bg.status')}</th>
              <th>{t('bg.duration')}</th>
              <th>{t('bg.task')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length > 0 ? tasks.map((t) => (
              <tr key={t.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.id}</td>
                <td>{t.type}</td>
                <td>
                  <span className={`status-tag tag-${t.status}`}>
                    <span className="tag-dot" />
                    {t.status}
                  </span>
                </td>
                <td>{t.duration != null ? fmtMs(t.duration) : '—'}</td>
                <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.prompt || '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={5}><span className="hint">{t('bg.none')}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
