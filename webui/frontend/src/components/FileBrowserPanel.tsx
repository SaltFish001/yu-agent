import { useState, useEffect, useCallback } from 'react'
import { t } from '../lib/i18n'
import { useStore } from '../lib/store'

interface FileItem {
  name: string
  path: string
  isDir: boolean
  size: number
}

interface TopicDetail {
  topic: any
  files: FileItem[]
  git: { hasGit: boolean; lastCommit: string; diffStat: string; diff: string } | null
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

export default function FileBrowserPanel() {
  const status = useStore((s) => s.status)
  const topics = (status.topics || []).filter((t: any) => !t.archived)
  const [selectedTopic, setSelectedTopic] = useState('')
  const [detail, setDetail] = useState<TopicDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showGit, setShowGit] = useState(false)

  const loadTopic = useCallback(async (name: string) => {
    if (!name) { setDetail(null); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/topic/${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setDetail(data)
    } catch (e) {
      setError((e as Error).message)
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedTopic) loadTopic(selectedTopic)
  }, [selectedTopic, loadTopic])

  // Auto-select first topic
  useEffect(() => {
    if (!selectedTopic && topics.length > 0) {
      setSelectedTopic(topics[0].name)
    }
  }, [topics, selectedTopic])

  const dirs = detail?.files.filter((f) => f.isDir) || []
  const files = detail?.files.filter((f) => !f.isDir) || []
  const git = detail?.git

  return (
    <>
      <div className="panel-header">
        <h2>{t('fb.title')}</h2>
      </div>

      {/* Topic selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select
          value={selectedTopic}
          onChange={(e) => setSelectedTopic(e.target.value)}
          style={{
            flex: 1,
            maxWidth: 300,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '6px 10px',
            fontSize: 13,
            color: 'var(--text)',
            outline: 'none',
          }}
        >
          {topics.map((t: any) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <button
          className="topic-create-btn"
          style={{ width: 'auto', padding: '6px 14px', borderStyle: 'solid' }}
          onClick={() => loadTopic(selectedTopic)}
        >
          ↻ {t('fb.refresh')}
        </button>
      </div>

      {error && <div style={{ marginBottom: 12, fontSize: 13, color: '#ef4444' }}>❌ {error}</div>}

      {loading ? (
        <div className="loading-fallback">{t('fb.loading')}</div>
      ) : detail ? (
        <div>
          {/* Topic meta */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
            <span>{t('fb.dir')}: {detail.topic?.dir || '—'}</span>
            <span>{t('fb.files')}: {detail.files.length}</span>
            {git?.hasGit && <span>Git: ✔</span>}
          </div>

          {/* Git status */}
          {git?.hasGit && (
            <details
              style={{ marginBottom: 12 }}
              open={showGit}
              onToggle={(e) => setShowGit((e.target as HTMLDetailsElement).open)}
            >
              <summary className="thinking-summary" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4 }}>
                Git · {git.lastCommit || t('fb.no.commit')}
                {git.diffStat && ` · ${git.diffStat.split('\n').length} ${t('fb.file.changes')}`}
              </summary>
              <div style={{ marginTop: 6, fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', background: 'var(--bg-code)', padding: 8, borderRadius: 4, maxHeight: 300, overflow: 'auto', color: 'var(--text-secondary)' }}>
                {git.diffStat || '(clean)'}
              </div>
            </details>
          )}

          {/* File tree */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            {dirs.length > 0 && (
              <div>
                <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>{t('fb.directory')}</div>
                {dirs.map((f) => (
                  <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 13, borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    <span>📁</span>
                    <span>{f.name}/</span>
                  </div>
                ))}
              </div>
            )}
            {files.length > 0 && (
              <div>
                <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>{t('fb.file')}</div>
                {files.map((f) => (
                  <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', fontSize: 13, borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    <span>📄</span>
                    <span style={{ flex: 1 }}>{f.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
            {detail.files.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                {t('fb.empty')}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="hint">{t('fb.select.topic')}</div>
      )}
    </>
  )
}
