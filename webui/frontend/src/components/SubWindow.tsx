import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore, type SubWindow } from '../lib/store'
import Dashboard from './Dashboard'
import BgTasksPanel from './BgTasksPanel'
import TerminalPanel from './TerminalPanel'
import FileBrowserPanel from './FileBrowserPanel'
import RulesPanel from './RulesPanel'
import SkillsPanel from './SkillsPanel'

interface SubWindowProps {
  win: SubWindow
}

export default function SubWindow({ win }: SubWindowProps) {
  const closeWindow = useStore((s) => s.closeWindow)
  const moveWindow = useStore((s) => s.moveWindow)
  const resizeWindow = useStore((s) => s.resizeWindow)

  const headerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, winX: 0, winY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, winW: 0, winH: 0 })

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === headerRef.current || (e.target as HTMLElement).closest('.sub-window-header')) {
      setDragging(true)
      dragStart.current = { x: e.clientX, y: e.clientY, winX: win.x, winY: win.y }
    }
  }, [win.x, win.y])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setResizing(true)
    resizeStart.current = { x: e.clientX, y: e.clientY, winW: win.w, winH: win.h }
  }, [win.w, win.h])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragging) {
        const dx = e.clientX - dragStart.current.x
        const dy = e.clientY - dragStart.current.y
        moveWindow(win.id, dragStart.current.winX + dx, dragStart.current.winY + dy)
      }
      if (resizing) {
        const dx = e.clientX - resizeStart.current.x
        const dy = e.clientY - resizeStart.current.y
        resizeWindow(win.id, Math.max(320, resizeStart.current.winW + dx), Math.max(240, resizeStart.current.winH + dy))
      }
    }
    const handleMouseUp = () => {
      setDragging(false)
      setResizing(false)
    }
    if (dragging || resizing) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [dragging, resizing, win.id, moveWindow, resizeWindow])

  const renderContent = () => {
    switch (win.type) {
      case 'status': return <Dashboard />
      case 'bg': return <BgTasksPanel />
      case 'terminal': return <TerminalPanel />
      case 'files': return <FileBrowserPanel />
      case 'rules': return <RulesPanel />
      case 'skills': return <SkillsPanel />
      default: return null
    }
  }

  const titles: Record<string, string> = {
    status: '📊 系统状态',
    bg: '🗂 后台任务',
    terminal: '⌨ 终端',
    files: '📁 文件',
    rules: '📐 规则',
    skills: '🧩 技能',
  }

  return (
    <div
      className="absolute flex flex-col bg-bg-surface border border-border rounded-xl shadow-xl overflow-hidden"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, minWidth: 320, minHeight: 240 }}
    >
      {/* Header */}
      <div
        ref={headerRef}
        className="sub-window-header flex items-center justify-between px-3 py-2 bg-bg-sidebar border-b border-border cursor-move select-none"
        onMouseDown={handleMouseDown}
      >
        <span className="text-sm font-medium text-text">{titles[win.type] || win.type}</span>
        <button
          onClick={() => closeWindow(win.id)}
          className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {renderContent()}
      </div>

      {/* Resize handle */}
      <div
        className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize"
        onMouseDown={handleResizeMouseDown}
        style={{
          background: 'linear-gradient(135deg, transparent 50%, var(--color-text-muted) 50%, var(--color-text-muted) 58%, transparent 58%, transparent 72%, var(--color-text-muted) 72%, var(--color-text-muted) 80%, transparent 80%)',
        }}
      />
    </div>
  )
}
