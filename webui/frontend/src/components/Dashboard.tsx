import { useStore } from '../lib/store'
import { useEffect, useState } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { GaugeChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { t } from '../lib/i18n'
import { PanelLoading, ErrorState } from './primitives'
import { fmtBytes, fmtDuration } from '../lib/format'

echarts.use([GaugeChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer])

export default function Dashboard() {
  const status = useStore((s) => s.status)
  const statusLoaded = useStore((s) => s.statusLoaded)
  const connected = useStore((s) => s.connected)
  const refreshStatus = useStore((s) => s.refreshStatus)
  const [detail, setDetail] = useState<string | null>(null)
  const [memHistory] = useState<number[]>([])

  const s = status
  const uptime = s.uptime || 0
  const mem = s.memory?.rss || 0
  const rulesCount = s.rules?.length || 0
  const toolsCount = s.tools?.length || 0
  const bgStats = s.bgStats || {}
  const events = s.events || {}
  const agentStats = s.agentStats || {}
  const ws = s.ws || {}
  const skillsCount = s.skills?.length || 0

  // Track resolved theme so chart colors follow light/dark mode
  const [theme, setTheme] = useState<string>(
    typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme') || 'dark'
      : 'dark',
  )
  useEffect(() => {
    const el = document.documentElement
    const apply = () => setTheme(el.getAttribute('data-theme') || 'dark')
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const isLight = theme === 'light'
  // 深水暖灯 palette: warm amber signal + jade, matched to CSS tokens
  const trackColor = isLight ? '#dfe5e8' : '#1f2a34'
  const lineGrid = isLight ? '#e3e9eb' : '#1f2a34'
  const lineLabel = isLight ? '#67747f' : '#75818f'
  const lineStroke = isLight ? '#a06a0b' : '#e5a84b'
  const jade = isLight ? '#1e8f52' : '#4ecb8b'

  // Mem usage gauge
  const memGaugeOption = {
    series: [{
      type: 'gauge',
      startAngle: 200,
      endAngle: -20,
      min: 0,
      max: 512,
      center: ['50%', '50%'],
      radius: '62%',
      progress: { show: true, width: 8, itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: jade }, { offset: 1, color: lineStroke }] } } },
      axisLine: { lineStyle: { width: 8, color: [[1, trackColor]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      detail: { show: false },
      data: [{ value: Math.round(mem / 1024 / 1024), name: '' }],
    }]
  }

  // Memory timeline
  useEffect(() => {
    if (mem > 0) {
      memHistory.push(mem / 1024 / 1024)
      if (memHistory.length > 30) memHistory.shift()
    }
  }, [mem])

  const memLineOption = {
    grid: { top: 20, right: 10, bottom: 20, left: 40 },
    xAxis: { type: 'category', show: false },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: lineGrid } }, axisLabel: { color: lineLabel, fontSize: 10 } },
    series: [{
      type: 'line',
      data: memHistory,
      smooth: true,
      showSymbol: false,
      lineStyle: { color: lineStroke, width: 2 },
      areaStyle: { color: isLight ? 'rgba(160,106,11,0.08)' : 'rgba(229,168,75,0.08)' },
    }]
  }

  const detailContent = () => {
    switch (detail) {
      case 'uptime': return (
        <>
          <div className="detail-row"><span>{t('dash.uptime.long')}</span><span>{fmtDuration(uptime)}</span></div>
          <div className="detail-row"><span>{t('dash.seconds')}</span><span>{uptime.toFixed(1)}s</span></div>
        </>
      )
      case 'mem': return (
        <>
          <div className="detail-row"><span>{t('dash.rss')}</span><span>{fmtBytes(s.memory?.rss || 0)}</span></div>
          <div className="detail-row"><span>{t('dash.heap.total')}</span><span>{fmtBytes(s.memory?.heapTotal || 0)}</span></div>
          <div className="detail-row"><span>{t('dash.heap.used')}</span><span>{fmtBytes(s.memory?.heapUsed || 0)}</span></div>
          <div className="chart-box"><ReactEChartsCore echarts={echarts} option={memLineOption} style={{ height: '100%' }} /></div>
        </>
      )
      case 'rules': return (s.rules || []).length > 0 ? (s.rules || []).map((r: any, i: number) => (
        <div key={i} className="detail-row"><span>{r.name || '—'}</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.trigger || '—'}</span></div>
      )) : <span className="hint">{t('dash.no.rules')}</span>
      case 'tools': return (s.tools || []).length > 0 ? (s.tools || []).map((t: any, i: number) => (
        <div key={i} className="detail-row"><span>{t.name}</span><span>{t.paramCount != null ? `${t.paramCount}p` : ''}</span></div>
      )) : <span className="hint">{t('dash.no.tools')}</span>
      case 'agent': return (
        <>
          <div className="detail-row"><span>{t('dash.total')}</span><span>{agentStats.total || 0}</span></div>
          <div className="detail-row"><span>{t('dash.completed')}</span><span>{agentStats.completed || 0}</span></div>
          <div className="detail-row"><span>{t('dash.failed')}</span><span>{agentStats.failed || 0}</span></div>
          {agentStats.avgDurationMs != null && <div className="detail-row"><span>{t('dash.avg.duration')}</span><span>{fmtDuration(Math.floor(agentStats.avgDurationMs / 1000))}</span></div>}
        </>
      )
      case 'events': return (
        <>
          <div className="detail-row"><span>{t('dash.total')}</span><span>{events.total || 0}</span></div>
          <div className="detail-row"><span>{t('dash.unack')}</span><span>{events.unacknowledged || 0}</span></div>
          {events.pendingTopics?.length ? <div className="detail-row"><span>{t('dash.pending.topics')}</span><span>{(events.pendingTopics as string[]).join(', ')}</span></div> : null}
        </>
      )
      default: return null
    }
  }

  if (!statusLoaded) {
    return (
      <>
        <div className="panel-header"><h2>{t('dash.title')}</h2></div>
        <PanelLoading />
      </>
    )
  }
  if (!connected) {
    return (
      <>
        <div className="panel-header"><h2>{t('dash.title')}</h2></div>
        <ErrorState message={t('panel.disconnected')} onRetry={refreshStatus} />
      </>
    )
  }

  return (
    <>
      <div className="panel-header"><h2>{t('dash.title')}</h2></div>
      <div className="dash-grid">
        <div className="card" onClick={() => setDetail(detail === 'uptime' ? null : 'uptime')}>
          <div className="card-label">{t('dash.uptime')}</div>
          <div className="card-value">{fmtDuration(uptime)}</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'mem' ? null : 'mem')}>
          <div className="card-label">{t('dash.memory')}</div>
          <ReactEChartsCore echarts={echarts} option={memGaugeOption} style={{ height: 78 }} />
          <div className="card-value" style={{ marginTop: 2, fontSize: 16 }}>{fmtBytes(mem)}</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'rules' ? null : 'rules')}>
          <div className="card-label">{t('dash.rules')}</div>
          <div className="card-value">{rulesCount}</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'tools' ? null : 'tools')}>
          <div className="card-label">{t('dash.tools')}</div>
          <div className="card-value">{toolsCount}</div>
        </div>
      </div>
      <div className="dash-grid">
        <div className="card" onClick={() => setDetail(detail === 'agent' ? null : 'agent')}>
          <div className="card-label">{t('dash.agent')}</div>
          <div className="card-value">{agentStats.total || 0}</div>
          <div className="card-sub">{agentStats.completed || 0} {t('dash.completed')} / {agentStats.failed || 0} {t('dash.failed')}</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'events' ? null : 'events')}>
          <div className="card-label">{t('dash.events')}</div>
          <div className="card-value">{events.total || 0}</div>
          <div className="card-sub">{events.unacknowledged || 0} {t('dash.unack')}</div>
        </div>
        <div className="card">
          <div className="card-label">{t('dash.bg')}</div>
          <div className="card-value">{bgStats.active || 0}</div>
          <div className="card-sub">{bgStats.completed || 0} {t('dash.completed')}</div>
        </div>
        <div className="card">
          <div className="card-label">{t('dash.skills')}</div>
          <div className="card-value">{skillsCount}</div>
        </div>
      </div>
      {detail && (
        <div className="card-detail">
          <div className="card-detail-header">
            <span>{detail === 'uptime' ? t('dash.uptime') : detail === 'mem' ? t('dash.memory') : detail === 'rules' ? t('dash.rules') : detail === 'tools' ? t('dash.tools') : detail === 'agent' ? t('dash.agent') : detail === 'events' ? t('dash.events') : detail}</span>
            <span className="card-detail-close" onClick={() => setDetail(null)}>×</span>
          </div>
          {detailContent()}
        </div>
      )}
    </>
  )
}
