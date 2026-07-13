import { useStore } from '../lib/store'
import { useEffect, useState } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { GaugeChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([GaugeChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer])

function fmtBytes(b: number): string {
  if (!b || b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function fmtDuration(s: number): string {
  if (!s || s < 60) return Math.floor(s || 0) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

export default function Dashboard() {
  const status = useStore((s) => s.status)
  const [detail, setDetail] = useState<string | null>(null)
  const [memHistory] = useState<number[]>([])
  const [tokenHistory] = useState<number[]>([])

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

  // Mem usage gauge
  const memGaugeOption = {
    series: [{
      type: 'gauge',
      startAngle: 200,
      endAngle: -20,
      min: 0,
      max: 512,
      center: ['50%', '60%'],
      radius: '70%',
      progress: { show: true, width: 8, itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#4caf7d' }, { offset: 1, color: '#5b7aff' }] } } },
      axisLine: { lineStyle: { width: 8, color: [[1, '#1c1c22']] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: { fontSize: 18, fontWeight: 700, color: '#e4e4ea', offsetCenter: [0, 0], formatter: () => fmtBytes(mem) },
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
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1c1c22' } }, axisLabel: { color: '#54545e', fontSize: 10 } },
    series: [{
      type: 'line',
      data: memHistory,
      smooth: true,
      showSymbol: false,
      lineStyle: { color: '#5b7aff', width: 2 },
      areaStyle: { color: 'rgba(91,122,255,0.08)' },
    }]
  }

  const detailContent = () => {
    switch (detail) {
      case 'uptime': return (
        <>
          <div className="detail-row"><span>启动时长</span><span>{fmtDuration(uptime)}</span></div>
          <div className="detail-row"><span>秒数</span><span>{uptime.toFixed(1)}s</span></div>
        </>
      )
      case 'mem': return (
        <>
          <div className="detail-row"><span>RSS</span><span>{fmtBytes(s.memory?.rss || 0)}</span></div>
          <div className="detail-row"><span>Heap Total</span><span>{fmtBytes(s.memory?.heapTotal || 0)}</span></div>
          <div className="detail-row"><span>Heap Used</span><span>{fmtBytes(s.memory?.heapUsed || 0)}</span></div>
          <div className="chart-box"><ReactEChartsCore echarts={echarts} option={memLineOption} style={{ height: '100%' }} /></div>
        </>
      )
      case 'rules': return (s.rules || []).length > 0 ? (s.rules || []).map((r: any, i: number) => (
        <div key={i} className="detail-row"><span>{r.name || '—'}</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.trigger || '—'}</span></div>
      )) : <span className="hint">无规则</span>
      case 'tools': return (s.tools || []).length > 0 ? (s.tools || []).map((t: any, i: number) => (
        <div key={i} className="detail-row"><span>{t.name}</span><span>{t.paramCount != null ? `${t.paramCount}p` : ''}</span></div>
      )) : <span className="hint">无工具</span>
      case 'agent': return (
        <>
          <div className="detail-row"><span>总计</span><span>{agentStats.total || 0}</span></div>
          <div className="detail-row"><span>完成</span><span>{agentStats.completed || 0}</span></div>
          <div className="detail-row"><span>失败</span><span>{agentStats.failed || 0}</span></div>
          {agentStats.avgDurationMs != null && <div className="detail-row"><span>平均耗时</span><span>{fmtDuration(Math.floor(agentStats.avgDurationMs / 1000))}</span></div>}
        </>
      )
      case 'events': return (
        <>
          <div className="detail-row"><span>总计</span><span>{events.total || 0}</span></div>
          <div className="detail-row"><span>未确认</span><span>{events.unacknowledged || 0}</span></div>
          {events.pendingTopics?.length ? <div className="detail-row"><span>待处理主题</span><span>{(events.pendingTopics as string[]).join(', ')}</span></div> : null}
        </>
      )
      default: return null
    }
  }

  return (
    <>
      <div className="panel-header"><h2>仪表盘</h2></div>
      <div className="dash-grid">
        <div className="card" onClick={() => setDetail(detail === 'uptime' ? null : 'uptime')}>
          <div className="card-label">运行时间</div>
          <div className="card-value">{fmtDuration(uptime)}</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'mem' ? null : 'mem')}>
          <div className="card-label">内存</div>
          <ReactEChartsCore echarts={echarts} option={memGaugeOption} style={{ height: 80 }} />
        </div>
        <div className="card" onClick={() => setDetail(detail === 'rules' ? null : 'rules')}>
          <div className="card-label">规则</div>
          <div className="card-value">{rulesCount}</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'tools' ? null : 'tools')}>
          <div className="card-label">工具</div>
          <div className="card-value">{toolsCount}</div>
        </div>
      </div>
      <div className="dash-grid">
        <div className="card" onClick={() => setDetail(detail === 'agent' ? null : 'agent')}>
          <div className="card-label">Agent 运行</div>
          <div className="card-value">{agentStats.total || 0}</div>
          <div className="card-sub">{agentStats.completed || 0} 完成 / {agentStats.failed || 0} 失败</div>
        </div>
        <div className="card" onClick={() => setDetail(detail === 'events' ? null : 'events')}>
          <div className="card-label">事件</div>
          <div className="card-value">{events.total || 0}</div>
          <div className="card-sub">{events.unacknowledged || 0} 未确认</div>
        </div>
        <div className="card">
          <div className="card-label">后台任务</div>
          <div className="card-value">{bgStats.active || 0}</div>
          <div className="card-sub">{bgStats.completed || 0} 完成</div>
        </div>
        <div className="card">
          <div className="card-label">技能</div>
          <div className="card-value">{skillsCount}</div>
        </div>
      </div>
      {detail && (
        <div className="card-detail">
          <div className="card-detail-header">
            <span>{detail === 'uptime' ? '运行时间' : detail === 'mem' ? '内存' : detail === 'rules' ? '规则' : detail === 'tools' ? '工具' : detail === 'agent' ? 'Agent' : detail === 'events' ? '事件' : detail}</span>
            <span className="card-detail-close" onClick={() => setDetail(null)}>×</span>
          </div>
          {detailContent()}
        </div>
      )}
    </>
  )
}
