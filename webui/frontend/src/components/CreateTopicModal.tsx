import { useState } from 'react'
import { createTopic } from '../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (name: string) => void
}

export default function CreateTopicModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      await createTopic(name.trim())
      onCreated(name.trim())
      setName('')
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-[400px] max-w-[90vw] bg-bg border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-text">新建 Topic</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入 topic 名称"
              autoFocus
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-tertiary outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            />
          </div>

          {error && (
            <div className="text-sm text-err">{error}</div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="px-4 py-2 text-sm font-semibold text-on-accent bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              {loading ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
