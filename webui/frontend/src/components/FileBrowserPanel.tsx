import { useState, useEffect } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

export default function FileBrowserPanel() {
  const activeTopic = useStore((s) => s.activeTopic)
  const [files, setFiles] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!activeTopic) return
    setLoading(true)
    fetch(`/api/topics/${activeTopic}/files`)
      .then((res) => res.json())
      .then((data) => {
        setFiles(data.files || [])
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [activeTopic])

  if (loading) {
    return <div className="text-sm text-text-tertiary text-center py-8">加载中...</div>
  }

  if (error) {
    return <div className="text-sm text-err text-center py-8">加载失败: {error}</div>
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-text mb-3">文件浏览器</h3>
      {files.length === 0 ? (
        <div className="text-sm text-text-tertiary text-center py-8">暂无文件</div>
      ) : (
        <div className="space-y-1">
          {files.map((file: any) => (
            <div key={file.path} className="flex items-center gap-2 p-2 hover:bg-bg-hover rounded-lg transition-colors cursor-pointer">
              <span className="text-lg">{file.type === 'dir' ? '📁' : '📄'}</span>
              <span className="text-sm text-text-secondary flex-1 truncate">{file.name}</span>
              <span className="text-xs text-text-tertiary">{formatBytes(file.size)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
