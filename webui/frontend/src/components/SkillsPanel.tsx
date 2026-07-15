import { t } from '../lib/i18n'
import { useStore } from '../lib/store'
import { PanelLoading, ErrorState } from './primitives'

export default function SkillsPanel() {
  const status = useStore((s) => s.status)
  const statusLoaded = useStore((s) => s.statusLoaded)
  const connected = useStore((s) => s.connected)
  const refreshStatus = useStore((s) => s.refreshStatus)
  const skills = status.skills || []

  if (!statusLoaded) {
    return (
      <>
        <div className="panel-header"><h2>{t('skills.title')}</h2></div>
        <PanelLoading />
      </>
    )
  }
  if (!connected) {
    return (
      <>
        <div className="panel-header"><h2>{t('skills.title')}</h2></div>
        <ErrorState message={t('panel.disconnected')} onRetry={refreshStatus} />
      </>
    )
  }

  return (
    <>
      <div className="panel-header"><h2>{t('skills.title')} ({skills.length})</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('skills.name')}</th>
              <th>{t('skills.description')}</th>
            </tr>
          </thead>
          <tbody>
            {skills.length > 0 ? skills.map((s, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.name}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{s.description || '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={2}><span className="hint">{t('skills.none')}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
