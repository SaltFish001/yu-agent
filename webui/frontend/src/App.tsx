import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type StatusData, type WindowType } from './lib/store'
import { fetchStatus, connectWS } from './lib/api'
import { useTheme } from './lib/theme'
import { t } from './lib/i18n'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import TopicsPanel from './components/TopicsPanel'
import SettingsModal from './components/SettingsModal'
import CommandPalette from './components/CommandPalette'
import SubWindow from './components/SubWindow'
import { Toast } from './components/Toast'
import StatusBar from './components/StatusBar'

export default function App() {
  useTheme()

  const settingsOpen = useStore((s) => s.settingsOpen)
  const mainView = useStore((s) => s.mainView)
  const setMainView = useStore((s) => s.setMainView)
  const windows = useStore((s) => s.windows)
  const openWindow = useStore((s) => s.openWindow)
  const setStatus = useStore((s) => s.setStatus)
  const setActiveTopic = useStore((s) => s.setActiveTopic)
  const setConnected = useStore((s) => s.setConnected)

  const [langNonce, setLangNonce] = useState(0)

  const NAV: Array<{ key: 'chat' | 'topics'; label: string }> = [
    { key: 'chat', label: t('nav.chat') },
    { key: 'topics', label: t('nav.topics') },
  ]

  const WIN_MENU: Array<{ type: WindowType; label: string }> = [
    { type: 'status', label: t('nav.status') },
    { type: 'bg', label: t('nav.bg') },
    { type: 'terminal', label: t('nav.terminal') },
    { type: 'files', label: t('nav.files') },
    { type: 'rules', label: t('nav.rules') },
    { type: 'skills', label: t('nav.skills') },
  ]

  const [winMenuOpen, setWinMenuOpen] = useState(false)
  const winBtnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)

  const toggleWinMenu = () => {
    if (!winMenuOpen && winBtnRef.current) {
      const r = winBtnRef.current.getBoundingClientRect()
      const left = Math.max(8, r.right - 160)
      setMenuPos({ left, top: r.bottom + 4 })
    }
    setWinMenuOpen((v) => !v)
  }

  // ── i18n reactive: force full-tree re-render on language change ──
  useEffect(() => {
    const onLang = () => setLangNonce((n) => n + 1)
    window.addEventListener('yu-lang-change', onLang)
    return () => window.removeEventListener('yu-lang-change', onLang)
  }, [])

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'k') {
        e.preventDefault()
        const s = useStore.getState()
        s.setPaletteOpen(!s.paletteOpen)
      } else if (mod && e.key === '.') {
        e.preventDefault()
        useStore.getState().toggleSidebar()
      } else if (mod && key === 'n') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('yu:new-chat'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    fetchStatus().then((data) => {
      setStatus(data)
      if (data.activeTopic) setActiveTopic(data.activeTopic)
    }).catch(() => {})
    const conn = connectWS(
      (data: StatusData) => {
        setStatus(data)
        if (data.activeTopic) setActiveTopic(data.activeTopic)
      },
      (c: boolean) => setConnected(c),
    )
    return () => conn.close()
  }, [setStatus, setActiveTopic, setConnected])

  const renderView = () => {
    switch (mainView) {
      case 'topics': return <TopicsPanel />
      default: return <ChatPanel />
    }
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-area">
        <nav className="main-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`main-nav-item ${mainView === n.key ? 'active' : ''}`}
              onClick={() => setMainView(n.key)}
            >
              {n.label}
            </button>
          ))}
          <div className="win-menu-wrap">
            <button ref={winBtnRef} className="win-menu-btn" onClick={toggleWinMenu}>
              {t('nav.windows')} ▾
            </button>
            {winMenuOpen && menuPos && createPortal(
              <>
                <div className="win-menu-backdrop" onClick={() => setWinMenuOpen(false)} />
                <div className="win-menu" style={{ left: menuPos.left, top: menuPos.top, right: 'auto' }}>
                  {WIN_MENU.map((m) => (
                    <button
                      key={m.type}
                      className="win-menu-item"
                      onClick={() => {
                        openWindow(m.type)
                        setWinMenuOpen(false)
                      }}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </>,
              document.body,
            )}
          </div>
        </nav>
        <div className="panel-content">
          <div className="panel">{renderView()}</div>
        </div>
        <StatusBar />
      </main>
      {windows.map((w) => (
        <SubWindow key={w.id} win={w} />
      ))}
      {settingsOpen && <SettingsModal />}
      <CommandPalette />
      <Toast />
    </div>
  )
}
