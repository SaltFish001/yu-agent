import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

export default function BgTasksPanel() {
  const status = useStore((s) => s.status)
  const bgTasks = status.backgroundTasks || []

  return (
    <div>
      <h3 className="text-sm font-semibold text-text mb-3">{t('bg.title')}</h3>
      {bgTasks.length === 0 ? (
        <div className="text-sm text-text-tertiary text-center py-8">暂无后台任务</div>
      ) : (
        <div className="space-y-2">
          {bgTasks.map((task: any) => (
            <div key={task.id} className="flex items-center gap-3 p-3 bg-bg-surface border border-border rounded-lg">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                task.status === 'running' ? 'bg-accent animate-pulse' :
                task.status === 'completed' ? 'bg-ok' :
                task.status === 'failed' ? 'bg-err' :
                'bg-text-muted'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text truncate">{task.name || task.id}</div>
                <div className="text-xs text-text-tertiary">{task.status}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
