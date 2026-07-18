import { useStore } from '../lib/store'
import { useEffect } from 'react'

export function Toast() {
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast);

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-[360px] pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-3 px-4 py-3 bg-bg-elev border border-border rounded-xl shadow-lg cursor-pointer animate-slide-up"
          onClick={() => dismissToast(toast.id)}
        >
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              toast.type === 'success'
                ? 'bg-ok shadow-[0_0_6px_rgba(0,229,160,0.5)]'
                : toast.type === 'error'
                ? 'bg-err'
                : 'bg-accent shadow-glow'
            }`}
          />
          <span className="flex-1 text-sm text-text leading-relaxed">{toast.message}</span>
        </div>
      ))}
    </div>
  )
}

// Auto-dismiss effect
export function useAutoDismiss() {
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)

  useEffect(() => {
    const timers = toasts.map((toast) =>
      setTimeout(() => dismissToast(toast.id), 3000)
    )
    return () => timers.forEach(clearTimeout)
  }, [toasts, dismissToast])
}
