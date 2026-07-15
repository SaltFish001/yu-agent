import { useEffect, useState } from 'react'
import Modal from './Modal'
import { fetchTopicDetail } from '../lib/api'

type Detail = {
  topic: {
    name: string
    dir: string
    status?: string
    summary?: string
    turns?: number
    lastActive?: string
    createdAt?: string
    archived?: boolean
  }
  files: Array<{ name: string; path: string; isDir: boolean; size: number }>
  git: { hasGit: boolean; lastCommit: string; diffStat: string; diff: string }
}

type Props = {
  open: boolean
  name: string | null
  onClose: () => void
  onSwitch?: (name: string) => void
  onArchive?: (name: string) => void
  onRename?: (name: string) => void
}

function fmtSize(b: number): string {
  if (!b) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function fmtDate(s?: string): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString()
  } catch {
    return s
  }
}

const dotClass = (status?: string) =>
  status === 'active' ? 'active' : status === 'background' ? 'background' : status === 'error' ? 'error' : 'idle'

export default function TopicDetailDrawer({
  open,
  name,
  onClose,
  onSwitch,
  onArchive,
  onRename,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !name) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchTopicDetail(name)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, name])

  return (
    <Modal open={open} onClose={onClose} title={name ? `主题 · ${name}` : '主题'} variant="drawer">
      {loading && <div className="loading-fallback">加载中…</div>}
      {!loading && detail && (
        <div className="td-section">
          <div className="td-row">
            <span className="td-key">状态</span>
            <span className="td-val">
              <span className={`topic-dot ${dotClass(detail.topic.status)}`} style={{ marginRight: 6 }} />
              {detail.topic.status || 'idle'}
            </span>
          </div>
          <div className="td-row">
            <span className="td-key">轮次</span>
            <span className="td-val">{detail.topic.turns ?? 0}</span>
          </div>
          <div className="td-row">
            <span className="td-key">目录</span>
            <span className="td-val td-mono">{detail.topic.dir}</span>
          </div>
          <div className="td-row">
            <span className="td-key">创建</span>
            <span className="td-val">{fmtDate(detail.topic.createdAt)}</span>
          </div>
          <div className="td-row">
            <span className="td-key">上次活跃</span>
            <span className="td-val">{fmtDate(detail.topic.lastActive)}</span>
          </div>
          {detail.topic.summary && (
            <div className="td-summary">
              <div className="td-key" style={{ marginBottom: 4 }}>
                摘要
              </div>
              <div className="td-val">{detail.topic.summary}</div>
            </div>
          )}

          {detail.git.hasGit && (
            <div className="td-git">
              <div className="td-key" style={{ marginBottom: 4 }}>
                Git
              </div>
              <div className="td-val td-mono" style={{ fontSize: 12 }}>
                {detail.git.lastCommit || '(无提交)'}
              </div>
              {detail.git.diffStat && <pre className="td-diffstat">{detail.git.diffStat}</pre>}
            </div>
          )}

          <div className="td-files">
            <div className="td-key" style={{ margin: '4px 0 8px' }}>
              文件 ({detail.files.length})
            </div>
            <div className="td-filetree">
              {detail.files.length === 0 && <div className="td-empty">目录为空</div>}
              {detail.files.map((f) => {
                const rel = f.path.replace(detail.topic.dir, '').replace(/^\//, '')
                const depth = rel.split('/').filter(Boolean).length - 1
                return (
                  <div key={f.path} className="td-file" style={{ paddingLeft: 8 + depth * 14 }}>
                    {f.isDir ? (
                      <span className="td-dir">
                        <span className="td-caret">▾</span>
                        <span className="td-name">📁 {f.name}</span>
                      </span>
                    ) : (
                      <span className="td-name td-file-row">
                        📄 {f.name}
                        <span className="td-size">{fmtSize(f.size)}</span>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="td-actions">
            {onSwitch && (
              <button className="action-btn" onClick={() => onSwitch(detail.topic.name)}>
                ⇄ 切换
              </button>
            )}
            {onRename && (
              <button className="action-btn" onClick={() => onRename(detail.topic.name)}>
                ✏️ 重命名
              </button>
            )}
            {onArchive && !detail.topic.archived && (
              <button className="action-btn" onClick={() => onArchive(detail.topic.name)}>
                📦 归档
              </button>
            )}
          </div>
        </div>
      )}
      {!loading && !detail && <div className="error-banner">加载主题详情失败</div>}
    </Modal>
  )
}
