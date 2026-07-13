const BASE = ''

export async function fetchStatus(): Promise<any> {
  const res = await fetch(`${BASE}/api/status`)
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchTopics(): Promise<{ topics: any[]; activeName: string | null }> {
  const res = await fetch(`${BASE}/api/topics`)
  if (!res.ok) throw new Error(`Topics fetch failed: ${res.status}`)
  return res.json()
}

export async function fetchTopicDetail(name: string): Promise<any> {
  const res = await fetch(`${BASE}/api/topic/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`Topic fetch failed: ${res.status}`)
  return res.json()
}

export async function deleteTopic(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/topic/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Delete failed: ${res.status}`)
  }
}

export async function archiveTopic(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/topic/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archive' }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Archive failed: ${res.status}`)
  }
}

export async function renameTopic(oldName: string, newName: string): Promise<void> {
  const res = await fetch(`${BASE}/api/topic/${encodeURIComponent(oldName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rename', newName }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Rename failed: ${res.status}`)
  }
}

export async function updateConfig(cfg: Record<string, unknown>): Promise<void> {
  await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
}

export async function sendChat(message: string): Promise<any> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) throw new Error(`Chat failed: ${res.status}`)
  return res.json()
}

export function streamChat(message: string, onChunk: (text: string, done: boolean) => void): AbortController {
  const ctrl = new AbortController()
  fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onChunk(`Error: ${res.status}`, true); return }
    const reader = res.body?.getReader()
    if (!reader) { onChunk('No response body', true); return }
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) { onChunk('', true); break }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') { onChunk('', true); return }
          try {
            const parsed = JSON.parse(data)
            if (parsed.text) onChunk(parsed.text, false)
          } catch { /* ignore partial */ }
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') onChunk(`Error: ${err.message}`, true)
  })
  return ctrl
}

export function connectWS(onStatus: (data: any) => void): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${location.host}/ws`)
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'status') onStatus(msg.data)
    } catch { /* ignore */ }
  }
  ws.onclose = () => setTimeout(() => connectWS(onStatus), 3000)
  return ws
}
