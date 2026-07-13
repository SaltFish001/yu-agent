import { t } from '../lib/i18n'
import { useStore } from '../lib/store'

export default function RulesPanel() {
  const status = useStore((s) => s.status)
  const rules = status.rules || []

  return (
    <>
      <div className="panel-header"><h2>{t('rules.title')} ({rules.length})</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('rules.name')}</th>
              <th>{t('rules.trigger')}</th>
              <th>{t('rules.action')}</th>
              <th>{t('rules.condition')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.length > 0 ? rules.map((r, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{r.name || '—'}</td>
                <td><code style={{ fontSize: 11, background: 'var(--bg-code)', padding: '2px 6px', borderRadius: 3 }}>{r.trigger || '—'}</code></td>
                <td>{r.action || '—'}</td>
                <td>{r.condition || '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={4}><span className="hint">{t('rules.none')}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
