import { useStore } from '../lib/store'

export default function RulesPanel() {
  const status = useStore((s) => s.status)
  const rules = status.rules || []

  return (
    <>
      <div className="panel-header"><h2>规则 ({rules.length})</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>触发器</th>
              <th>动作</th>
              <th>条件</th>
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
              <tr><td colSpan={4}><span className="hint">暂无规则</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
