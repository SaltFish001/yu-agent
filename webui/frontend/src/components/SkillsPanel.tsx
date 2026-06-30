import { useStore } from '../lib/store'

export default function SkillsPanel() {
  const status = useStore((s) => s.status)
  const skills = status.skills || []

  return (
    <>
      <div className="panel-header"><h2>技能 ({skills.length})</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>描述</th>
            </tr>
          </thead>
          <tbody>
            {skills.length > 0 ? skills.map((s, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.name}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{s.description || '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={2}><span className="hint">无技能</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
