import { create } from 'zustand'

export interface StatusData {
  version?: string
  uptime?: number
  memory?: { rss?: number; heapTotal?: number; heapUsed?: number }
  ws?: { connected?: number; total?: number; messagesSent?: number; uptimeSec?: number }
  rules?: Array<{ name?: string; trigger?: string; action?: string; condition?: string }>
  tools?: Array<{ name?: string; description?: string; paramCount?: number }>
  topics?: Array<{ name: string; status?: string; turns?: number; lastActive?: string; archived?: boolean }>
  activeTopic?: string | null
  events?: { total?: number; unacknowledged?: number; pendingTopics?: string[] }
  agentStats?: { total?: number; completed?: number; failed?: number; avgDurationMs?: number }
  tokenUsage?: any
  skills?: Array<{ name: string; description?: string }>
  backgroundTasks?: Array<{ id: string; type: string; status: string; duration: number | null; prompt?: string }>
  bgStats?: { active?: number; completed?: number; failed?: number }
}

export type WindowType = 'status' | 'bg' | 'terminal' | 'files' | 'rules' | 'skills'

export interface SubWindow {
  id: string
  type: WindowType
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  id: string
}

export interface Toast {
  id: string
  type: 'success' | 'error' | 'info'
  message: string
}

interface AppState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  settingsOpen: boolean
  paletteOpen: boolean
  mainView: 'chat' | 'topics'
  windows: SubWindow[]
  windowSeq: number
  status: StatusData
  statusLoaded: boolean
  messages: ChatMessage[]
  toasts: Toast[]
  topicSearch: string
  activeTopic: string | null
  connected: boolean
  tokenUsage: number
  agentIterations: number
  agentBudget: number
  setSidebarWidth: (w: number) => void
  toggleSidebar: () => void
  setSettingsOpen: (o: boolean) => void
  setPaletteOpen: (o: boolean) => void
  setMainView: (v: AppState['mainView']) => void
  openWindow: (type: WindowType) => void
  closeWindow: (id: string) => void
  focusWindow: (id: string) => void
  moveWindow: (id: string, x: number, y: number) => void
  resizeWindow: (id: string, w: number, h: number) => void
  persistWindows: () => void
  setStatus: (s: StatusData) => void
  addMessage: (m: ChatMessage) => void
  setTopicSearch: (s: string) => void
  setActiveTopic: (t: string | null) => void
  setConnected: (c: boolean) => void
  setTokenUsage: (t: number) => void
  setAgentIterations: (i: number) => void
  setAgentBudget: (b: number) => void
  refreshStatus: () => Promise<void>
  pushToast: (t: Omit<Toast, 'id'> | string) => void
  dismissToast: (id: string) => void
  setStatusLoaded: (v: boolean) => void
}

const WIN_POS_KEY = 'yu-win-pos'
type WinLayout = Record<string, { x: number; y: number; w: number; h: number }>
function loadWinLayout(): WinLayout {
  try {
    return JSON.parse(localStorage.getItem(WIN_POS_KEY) || '{}') as WinLayout
  } catch {
    return {}
  }
}
function saveWinLayout(layout: WinLayout) {
  try {
    localStorage.setItem(WIN_POS_KEY, JSON.stringify(layout))
  } catch {
    /* ignore quota / privacy errors */
  }
}

export const useStore = create<AppState>((set, get) => ({
  activePanel: 'chat',
  sidebarWidth: 240,
  sidebarCollapsed: false,
  settingsOpen: false,
  paletteOpen: false,
  mainView: 'chat',
  windows: [],
  windowSeq: 0,
  status: {},
  statusLoaded: false,
  messages: [],
  toasts: [],
  topicSearch: '',
  activeTopic: null,
  connected: false,
  tokenUsage: 0,
  agentIterations: 0,
  agentBudget: 40000,

  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSettingsOpen: (o) => set({ settingsOpen: o }),
  setPaletteOpen: (o) => set({ paletteOpen: o }),
  setMainView: (v) => set({ mainView: v }),
  openWindow: (type) =>
    set((s) => {
      const titles: Record<WindowType, string> = {
        status: '系统状态',
        bg: '后台任务',
        terminal: '终端',
        files: '文件',
        rules: '规则',
        skills: '技能',
      }
      const existing = s.windows.find((w) => w.type === type)
      if (existing) {
        const maxZ = s.windows.reduce((m, w) => Math.max(m, w.z), 0)
        return { windows: s.windows.map((w) => (w.id === existing.id ? { ...w, z: maxZ + 1 } : w)) }
      }
      const seq = s.windowSeq + 1
      const count = s.windows.length
      const baseX = 120 + (count % 5) * 40
      const baseY = 90 + (count % 5) * 36
      const maxZ = s.windows.reduce((m, w) => Math.max(m, w.z), 0)
      const defaults: Record<WindowType, { w: number; h: number }> = {
        status: { w: 460, h: 520 },
        bg: { w: 520, h: 460 },
        terminal: { w: 560, h: 420 },
        files: { w: 560, h: 480 },
        rules: { w: 520, h: 460 },
        skills: { w: 520, h: 460 },
      }
      const saved = loadWinLayout()[type]
      const win: SubWindow = {
        id: `win-${seq}`,
        type,
        title: titles[type],
        x: saved?.x ?? baseX,
        y: saved?.y ?? baseY,
        w: saved?.w ?? defaults[type].w,
        h: saved?.h ?? defaults[type].h,
        z: maxZ + 1,
      }
      return { windows: [...s.windows, win], windowSeq: seq }
    }),
  closeWindow: (id) => set((s) => ({ windows: s.windows.filter((w) => w.id !== id) })),
  focusWindow: (id) =>
    set((s) => {
      const maxZ = s.windows.reduce((m, w) => Math.max(m, w.z), 0)
      return { windows: s.windows.map((w) => (w.id === id ? { ...w, z: maxZ + 1 } : w)) }
    }),
  moveWindow: (id, x, y) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, x, y } : w)) })),
  resizeWindow: (id, w, h) =>
    set((s) => ({ windows: s.windows.map((win) => (win.id === id ? { ...win, w, h } : win)) })),

  persistWindows: () => {
    const layout = loadWinLayout()
    for (const w of get().windows) {
      layout[w.type] = { x: w.x, y: w.y, w: w.w, h: w.h }
    }
    saveWinLayout(layout)
  },
  setStatus: (s) => set({ status: s, statusLoaded: true }),

  refreshStatus: async () => {
    try {
      const { fetchStatus } = await import('./api')
      const data = await fetchStatus()
      set({ status: data, statusLoaded: true })
    } catch {
      // silenty fail — WS will update eventually
    }
  },

  addMessage: (m) =>
    set((s) => ({ messages: [...s.messages, m] })),

  setTopicSearch: (s) => set({ topicSearch: s }),
  setActiveTopic: (t) => set({ activeTopic: t }),
  setConnected: (c) => set({ connected: c }),
  setTokenUsage: (t) => set({ tokenUsage: t }),
  setAgentIterations: (i) => set({ agentIterations: i }),
  setAgentBudget: (b) => set({ agentBudget: b }),

  setStatusLoaded: (v) => set({ statusLoaded: v }),

  pushToast: (t) =>
    set((s) => {
      const toast: Toast = {
        id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: typeof t === 'string' ? 'info' : t.type,
        message: typeof t === 'string' ? t : t.message,
      }
      return { toasts: [...s.toasts, toast] }
    }),

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
