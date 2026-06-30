import { useEffect } from 'react'
import { useStore, type StatusData } from './lib/store'
import { fetchStatus, connectWS } from './lib/api'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import Dashboard from './components/Dashboard'
import TopicsPanel from './components/TopicsPanel'
import BgTasksPanel from './components/BgTasksPanel'
import RulesPanel from './components/RulesPanel'
import SkillsPanel from './components/SkillsPanel'

const PANELS: Record<string, { label: string; icon: string }> = {
  chat: { label: '对话', icon: '💬' },
  dashboard: { label: '仪表盘', icon: '📊' },
  topics: { label: '主题', icon: '📋' },
  bg: { label: '后台', icon: '⏳' },
  rules: { label: '规则', icon: '🔒' },
  skills: { label: '技能', icon: '🧩' },
}

export default function App() {
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
  const setStatus = useStore((s) => s.setStatus)

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => {})
    const ws = connectWS((data: StatusData) => setStatus(data))
    return () => ws.close()
  }, [setStatus])

  return (
    <div className="app-layout">
      <Sidebar panels={PANELS} />
      <div className="main-area">
        <div className="panel-tabs">
          {Object.entries(PANELS).map(([key, p]) => (
            <button
              key={key}
              className={`panel-tab ${activePanel === key ? 'active' : ''}`}
              onClick={() => setActivePanel(key)}
            >
              {p.icon} {p.label}
            </button>
          ))}
        </div>
        <div className="panel-content">
          <div className={`panel ${activePanel === 'chat' ? 'active' : ''}`}>
            <ChatPanel />
          </div>
          <div className={`panel dashboard ${activePanel === 'dashboard' ? 'active' : ''}`}>
            <Dashboard />
          </div>
          <div className={`panel ${activePanel === 'topics' ? 'active' : ''}`}>
            <TopicsPanel />
          </div>
          <div className={`panel ${activePanel === 'bg' ? 'active' : ''}`}>
            <BgTasksPanel />
          </div>
          <div className={`panel ${activePanel === 'rules' ? 'active' : ''}`}>
            <RulesPanel />
          </div>
          <div className={`panel ${activePanel === 'skills' ? 'active' : ''}`}>
            <SkillsPanel />
          </div>
        </div>
      </div>
    </div>
  )
}
