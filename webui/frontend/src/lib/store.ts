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

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  id: string
}

interface AppState {
  activePanel: string
  sidebarWidth: number
  sidebarCollapsed: boolean
  adminOpen: boolean
  settingsOpen: boolean
  status: StatusData
  messages: ChatMessage[]
  streaming: boolean
  topicSearch: string
  activeTopic: string | null
  connected: boolean
  tokenUsage: number
  agentIterations: number
  agentBudget: number
  setActivePanel: (p: string) => void
  setSidebarWidth: (w: number) => void
  toggleSidebar: () => void
  setAdminOpen: (o: boolean) => void
  setSettingsOpen: (o: boolean) => void
  setStatus: (s: StatusData) => void
  addMessage: (m: ChatMessage) => void
  appendToLastMessage: (text: string) => void
  finalizeStream: () => void
  setStreaming: (s: boolean) => void
  clearMessages: () => void
  setTopicSearch: (s: string) => void
  setActiveTopic: (t: string | null) => void
  setConnected: (c: boolean) => void
  setTokenUsage: (t: number) => void
  setAgentIterations: (i: number) => void
  setAgentBudget: (b: number) => void
  refreshStatus: () => Promise<void>
}

export const useStore = create<AppState>((set) => ({
  activePanel: 'chat',
  sidebarWidth: 240,
  sidebarCollapsed: false,
  adminOpen: false,
  settingsOpen: false,
  status: {},
  messages: [],
  streaming: false,
  topicSearch: '',
  activeTopic: null,
  connected: false,
  tokenUsage: 0,
  agentIterations: 0,
  agentBudget: 40000,

  setActivePanel: (p) => set({ activePanel: p }),
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setAdminOpen: (o) => set({ adminOpen: o }),
  setSettingsOpen: (o) => set({ settingsOpen: o }),
  setStatus: (s) => set({ status: s }),

  refreshStatus: async () => {
    try {
      const { fetchStatus } = await import('./api')
      const data = await fetchStatus()
      set({ status: data })
    } catch {
      // silenty fail — WS will update eventually
    }
  },

  addMessage: (m) =>
    set((s) => ({ messages: [...s.messages, m] })),

  appendToLastMessage: (text) =>
    set((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + text }
      }
      return { messages: msgs }
    }),

  finalizeStream: () =>
    set((s) => {
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant' && last.content === '') {
        msgs.pop()
      }
      return { messages: msgs, streaming: false }
    }),

  setStreaming: (s) => set({ streaming: s }),
  clearMessages: () => set({ messages: [] }),
  setTopicSearch: (s) => set({ topicSearch: s }),
  setActiveTopic: (t) => set({ activeTopic: t }),
  setConnected: (c) => set({ connected: c }),
  setTokenUsage: (t) => set({ tokenUsage: t }),
  setAgentIterations: (i) => set({ agentIterations: i }),
  setAgentBudget: (b) => set({ agentBudget: b }),
}))
