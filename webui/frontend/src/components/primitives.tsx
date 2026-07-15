/** yu-agent — shared UI primitives */

import type { ReactNode } from 'react'

export function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div
      className="loading-spinner"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 12)) }}
      role="status"
      aria-label="加载中"
    />
  )
}

export function Skeleton({ height = 16, width = '100%', radius = 6 }: { height?: number; width?: string | number; radius?: number }) {
  return (
    <div
      className="skeleton"
      style={{ height, width, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

export function EmptyState({ icon = '∅', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  )
}

export function ErrorState({
  message = '加载失败',
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <div className="error-state">
      <div className="error-icon">⚠</div>
      <div className="error-msg">{message}</div>
      {onRetry && (
        <button type="button" className="error-retry" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

export function PanelLoading({ rows = 3 }: { rows?: number }) {
  const widths = Array.from({ length: rows }, (_, i) => `${70 - i * 8}%`)
  return (
    <div className="panel-loading">
      <Spinner size={26} />
      <div className="skeleton-col">
        {widths.map((w) => (
          <Skeleton key={w} height={14} width={w} />
        ))}
      </div>
    </div>
  )
}

export type { ReactNode }
