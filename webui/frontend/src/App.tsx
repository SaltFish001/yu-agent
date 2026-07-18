import { useEffect } from 'react'
import { useStore } from './lib/store'
import { useTheme } from './lib/theme'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import StatusBar from './components/StatusBar'
import CommandPalette from './components/CommandPalette'
import SettingsModal from './components/SettingsModal'
import SubWindow from './components/SubWindow'
import { Toast } from './components/Toast'

export default function App() {
  useTheme()

  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const windows = useStore((s) => s.windows)

  return (
    <div className="flex h-screen w-screen bg-bg text-text-secondary overflow-hidden">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="flex flex-col flex-1 min-w-0 transition-all duration-300">
        {/* Chat area */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatPanel />
        </div>

        {/* Status bar */}
        <StatusBar />
      </main>

      {/* Floating windows */}
      {windows.map((w) => (
        <SubWindow key={w.id} win={w} />
      ))}

      {/* Modals */}
      {settingsOpen && <SettingsModal />}
      <CommandPalette />
      <Toast />
    </div>
  )
}
