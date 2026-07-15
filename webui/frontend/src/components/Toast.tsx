/** yu-agent — toast notifications */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../lib/store'

function ToastItem({
  id,
  type,
  message,
}: {
  id: string
  type: 'success' | 'error' | 'info'
  message: string
}) {
  const dismissToast = useStore((s) => s.dismissToast)
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(id), 3000)
    return () => clearTimeout(timer)
  }, [id, dismissToast])
  return (
    <button type="button" className={`toast toast-${type}`} onClick={() => dismissToast(id)}>
      <span className="toast-dot" />
      <span className="toast-msg">{message}</span>
    </button>
  )
}

export function Toast() {
  const toasts = useStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return createPortal(
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} type={t.type} message={t.message} />
      ))}
    </div>,
    document.body,
  )
}
