/** yu-agent — shared primitive components */

interface SpinnerProps {
  size?: number
  className?: string
}

export function Spinner({ size = 24, className = '' }: SpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-2 border-border border-t-accent ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

interface SkeletonProps {
  className?: string
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div className={`animate-pulse bg-bg-surface rounded-lg ${className}`} />
  )
}

interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  className?: string
}

export function EmptyState({ icon = '🔍', title, description, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 gap-3 ${className}`}>
      <span className="text-3xl opacity-40">{icon}</span>
      <h3 className="text-sm font-medium text-text">{title}</h3>
      {description && <p className="text-xs text-text-tertiary text-center max-w-xs">{description}</p>}
    </div>
  )
}

interface ErrorStateProps {
  message: string
  onRetry?: () => void
  className?: string
}

export function ErrorState({ message, onRetry, className = '' }: ErrorStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 gap-3 ${className}`}>
      <span className="text-3xl">⚠️</span>
      <p className="text-sm text-err">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 text-sm text-accent bg-accent/10 border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
        >
          重试
        </button>
      )}
    </div>
  )
}

interface PanelLoadingProps {
  className?: string
}

export function PanelLoading({ className = '' }: PanelLoadingProps) {
  return (
    <div className={`flex items-center gap-4 p-5 ${className}`}>
      <Skeleton className="w-10 h-10 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  )
}
