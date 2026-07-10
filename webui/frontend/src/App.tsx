import { useEffect } from 'react'
import { useStore, type StatusData } from './lib/store'
import { fetchStatus, connectWS } from './lib/api'
import { useTheme } from './lib/theme'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import SettingsModal from './components/SettingsModal'
import AdminPage from './pages/AdminPage'

export default function App() {
  useTheme()

  // Standalone admin sub-window — no layout, full admin page
  if (location.hash === '#/admin') return <AdminPage />

  const adminOpen = useStore((s) => s.adminOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setStatus = useStore((s) => s.setStatus)
  const setActiveTopic = useStore((s) => s.setActiveTopic)

  useEffect(() => {
    fetchStatus().then((data) => {
      setStatus(data)
      if (data.activeTopic) setActiveTopic(data.activeTopic)
    }).catch(() => {})
    const ws = connectWS((data: StatusData) => {
      setStatus(data)
      if (data.activeTopic) setActiveTopic(data.activeTopic)
    })
    return () => ws.close()
  }, [setStatus, setActiveTopic])

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-area">
        <div className="panel-content">
          <div className="panel"><ChatPanel /></div>
        </div>
      </main>
      {adminOpen && <div style={{ display: 'none' }} />}
      {settingsOpen && <SettingsModal />}
    </div>
  )
}
