import { useState, useEffect } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import ReactECharts from 'echarts-for-react'

export default function Dashboard() {
  const status = useStore((s) => s.status)
  const mem = status.memory?.rss || 0
  const uptime = status.uptime || 0
  const topics = status.topics || []
  const events = status.events || {}
  const agentStats = status.agentStats || {}
  const ws = status.ws || {}

  const [theme, setTheme] = useState('dark')
  useEffect(() => {
    const el = document.documentElement
    const apply = () => setTheme(el.getAttribute('data-theme') || 'dark')
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const isLight = theme === 'light'
  const trackColor = isLight ? '#dfe5e8' : '#1f2a34'
  const lineGrid = isLight ? '#e3e9eb' : '#1f2a34'
  const lineLabel = isLight ? '#67747f' : '#75818f'
  const lineStroke = isLight ? '#0088aa' : '#00d4ff'
  const jade = isLight ? '#1e8f52' : '#00e5a0'

  const memGaugeOption = {
    series: [{
      type: 'gauge',
      startAngle: 200,
      endAngle: -20,
      min: 0,
      max: 512,
      center: ['50%', '50%'],
      radius: '62%',
      progress: {
        show: true,
        width: 8,
        itemStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 1, y2: 0,
            colorStops: [
              { offset: 0, color: jade },
              { offset: 1, color: lineStroke },
            ],
          },
        },
      },
      axisLine: { lineStyle: { width: 8, color: [[1, trackColor]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      detail: { show: false },
      data: [{ value: Math.round(mem / 1024 / 1024), name: '' }],
    }],
  }

  return (
    <div className="space-y-4">
      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricCard label={t('dash.uptime')} value={fmtDuration(uptime)} />
        <MetricCard label={t('dash.memory')} value={`${(mem / 1024 / 1024).toFixed(1)} MB`} />
        <MetricCard label={t('dash.topics')} value={topics.length.toString()} />
        <MetricCard label={t('dash.ws')} value={`${ws.connected ?? 0}`} />
        <MetricCard label={t('dash.agents.total')} value={`${agentStats.total ?? 0}`} />
        <MetricCard label={t('dash.agents.completed')} value={`${agentStats.completed ?? 0}`} />
      </div>

      {/* Memory Gauge */}
      <div className="bg-bg-surface border border-border rounded-xl p-4">
        <h4 className="text-sm font-medium text-text mb-2">内存使用</h4>
        <ReactECharts option={memGaugeOption} style={{ height: 180 }} />
      </div>

      {/* Events */}
      {Object.keys(events).length > 0 && (
        <div className="bg-bg-surface border border-border rounded-xl p-4">
          <h4 className="text-sm font-medium text-text mb-2">事件</h4>
          <div className="space-y-1">
            {Object.entries(events).map(([key, count]) => (
              <div key={key} className="flex justify-between text-sm">
                <span className="text-text-secondary">{key}</span>
                <span className="text-text font-mono">{count as number}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-surface border border-border rounded-xl p-4 hover:border-border-light transition-colors">
      <div className="text-xs text-text-tertiary mb-1">{label}</div>
      <div className="text-xl font-semibold text-text tabular-nums">{value}</div>
    </div>
  )
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}
