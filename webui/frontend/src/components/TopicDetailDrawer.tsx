import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'

interface Props {
  open: boolean
  name: string | null
  onClose: () => void
  onSwitch: (name: string) => void
  onArchive: (name: string) => void
  onRename: (name: string) => void
}

export default function TopicDetailDrawer({ open, name, onClose, onSwitch, onArchive, onRename }: Props) {
  const [detail, setDetail] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !name) return
    setLoading(true)
    fetch(`/api/topic/${name}`)
      .then((res) => res.json())
      .then((data) => {
        setDetail(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [open, name])

  if (!open || !name) return null

  return (
    <div className="fixed inset-0 z-[200] flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-[400px] max-w-[90vw] h-full bg-bg border-l border-border shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-text">{name}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {loading ? (
            <div className="text-sm text-text-tertiary text-center py-8">加载中...</div>
          ) : detail ? (
            <>
              <div className="space-y-2">
                <DetailRow label="状态" value={detail.status || '—'} />
                <DetailRow label="轮次" value={detail.turns?.toString() || '0'} />
                <DetailRow label="创建时间" value={detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '—'} />
                <DetailRow label="最后活跃" value={detail.lastActive ? new Date(detail.lastActive).toLocaleString() : '—'} />
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t border-border">
                <button
                  onClick={() => { onSwitch(name); onClose() }}
                  className="flex-1 py-2 text-sm text-accent bg-accent/10 border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
                >
                  切换
                </button>
                <button
                  onClick={() => { onArchive(name); onClose() }}
                  className="flex-1 py-2 text-sm text-text-secondary bg-bg-surface border border-border rounded-lg hover:bg-bg-hover transition-colors"
                >
                  归档
                </button>
                <button
                  onClick={() => { onRename(name); onClose() }}
                  className="flex-1 py-2 text-sm text-text-secondary bg-bg-surface border border-border rounded-lg hover:bg-bg-hover transition-colors"
                >
                  重命名
                </button>
              </div>
            </>
          ) : (
            <div className="text-sm text-text-tertiary text-center py-8">无法加载详情</div>
          )}
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-text-tertiary">{label}</span>
      <span className="text-text">{value}</span>
    </div>
  )
}
