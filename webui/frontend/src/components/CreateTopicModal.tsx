import { useState } from 'react'
import Modal from './Modal'
import { createTopic } from '../lib/api'

type Props = {
  open: boolean
  onClose: () => void
  onCreated: (name: string) => void
}

export default function CreateTopicModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setName('')
    setDir('')
    setError(null)
    setSubmitting(false)
  }

  const close = () => {
    reset()
    onClose()
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入主题名称')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await createTopic(trimmed, dir.trim() || undefined)
      onCreated(trimmed)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="新建主题"
      footer={
        <>
          <button className="action-btn" onClick={close} disabled={submitting}>
            取消
          </button>
          <button className="action-btn" onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-field">
        <label className="form-label" htmlFor="ct-name">
          名称
        </label>
        <input
          id="ct-name"
          className="settings-input"
          style={{ width: '100%' }}
          placeholder="my-feature"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>
      <div className="form-field" style={{ marginTop: 14 }}>
        <label className="form-label" htmlFor="ct-dir">
          目录（可选，默认当前工作目录）
        </label>
        <input
          id="ct-dir"
          className="settings-input"
          style={{ width: '100%' }}
          placeholder="留空则使用当前工作目录"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>
      {error && (
        <div className="error-banner" style={{ marginTop: 14 }}>
          <span>❌ {error}</span>
        </div>
      )}
    </Modal>
  )
}
