import { useStore } from '../lib/store'

export default function BgTasksPanel() {
  const status = useStore((s) => s.status)
  const tasks = status.backgroundTasks || []

  return (
    <>
      <div className="panel-header"><h2>后台任务</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>类型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>任务</th>
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
              <tr><td colSpan={5}><span className="hint">无后台任务</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function fmtMs(ms: number): string {
  if (ms < 1000) return ms + 'ms'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}
