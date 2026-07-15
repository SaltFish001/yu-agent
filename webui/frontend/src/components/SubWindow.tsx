/** yu-agent — floating sub-window host for secondary panels */
import { useStore, type SubWindow as SubWindowData, type WindowType } from '../lib/store'
import Dashboard from './Dashboard'
import BgTasksPanel from './BgTasksPanel'
import TerminalPanel from './TerminalPanel'
import FileBrowserPanel from './FileBrowserPanel'
import RulesPanel from './RulesPanel'
import SkillsPanel from './SkillsPanel'

function renderBody(type: WindowType) {
  switch (type) {
    case 'status': return <Dashboard />
    case 'bg': return <BgTasksPanel />
    case 'terminal': return <TerminalPanel />
    case 'files': return <FileBrowserPanel />
    case 'rules': return <RulesPanel />
    case 'skills': return <SkillsPanel />
    default: return null
  }
}

export default function SubWindow({ win }: { win: SubWindowData }) {
  const focusWindow = useStore((s) => s.focusWindow)
  const moveWindow = useStore((s) => s.moveWindow)
  const resizeWindow = useStore((s) => s.resizeWindow)
  const closeWindow = useStore((s) => s.closeWindow)

  const onHeaderDown = (e: React.MouseEvent) => {
    focusWindow(win.id)
    const sx = e.clientX
    const sy = e.clientY
    const ox = win.x
    const oy = win.y
    const move = (ev: MouseEvent) => {
      const maxX = Math.max(0, window.innerWidth - win.w)
      const maxY = Math.max(0, window.innerHeight - win.h)
      const nx = Math.min(maxX, Math.max(0, ox + (ev.clientX - sx)))
      const ny = Math.min(maxY, Math.max(0, oy + (ev.clientY - sy)))
      moveWindow(win.id, nx, ny)
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      useStore.getState().persistWindows()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const onResizeDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    focusWindow(win.id)
    const sx = e.clientX
    const sy = e.clientY
    const ow = win.w
    const oh = win.h
    const move = (ev: MouseEvent) => {
      const nw = Math.max(320, ow + (ev.clientX - sx))
      const nh = Math.max(240, oh + (ev.clientY - sy))
      resizeWindow(win.id, nw, nh)
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      useStore.getState().persistWindows()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const onResizeKey = (e: React.KeyboardEvent) => {
    const step = 24
    if (e.key === 'ArrowLeft') resizeWindow(win.id, Math.max(320, win.w - step), win.h)
    else if (e.key === 'ArrowRight') resizeWindow(win.id, win.w + step, win.h)
    else if (e.key === 'ArrowUp') resizeWindow(win.id, win.w, Math.max(240, win.h - step))
    else if (e.key === 'ArrowDown') resizeWindow(win.id, win.w, win.h + step)
    else return
    e.preventDefault()
    useStore.getState().persistWindows()
  }

  return (
    <div
      className="sub-window"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
    >
      <div className="sub-window-header">
        <button
          type="button"
          className="sub-window-drag"
          aria-label="拖动窗口"
          onMouseDown={onHeaderDown}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') focusWindow(win.id) }}
        >
          <span className="sub-window-title">{win.title}</span>
        </button>
        <button
          type="button"
          className="sub-win-close"
          title="关闭"
          aria-label="关闭窗口"
          onMouseDown={(e) => {
            e.stopPropagation()
            closeWindow(win.id)
          }}
        >
          ✕
        </button>
      </div>
      <div className={'sub-window-body' + (win.type === 'terminal' ? ' sub-window-body--term' : '')}>
        {renderBody(win.type)}
      </div>
      <button
        type="button"
        className="sub-window-resize"
        aria-label="调整窗口大小"
        onMouseDown={onResizeDown}
        onKeyDown={onResizeKey}
      />
    </div>
  )
}
