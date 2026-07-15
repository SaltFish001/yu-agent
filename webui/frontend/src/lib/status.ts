/** yu-agent — shared status helpers */

export function getStatusColor(t: { status?: string } | null | undefined): string {
  if (t?.status === 'active') return 'var(--ok)'
  if (t?.status === 'background') return 'var(--accent)'
  if (t?.status === 'error') return 'var(--err)'
  return 'var(--text-tertiary)'
}

export function getStatusLabel(t: { status?: string } | null | undefined): string {
  if (t?.status === 'active') return '活跃'
  if (t?.status === 'background') return '后台'
  if (t?.status === 'error') return '错误'
  return '空闲'
}

export function getDotClass(t: { status?: string } | null | undefined): string {
  if (t?.status === 'active') return 'active'
  if (t?.status === 'background') return 'background'
  if (t?.status === 'error') return 'error'
  return 'idle'
}
