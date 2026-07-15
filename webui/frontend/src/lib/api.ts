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

export async function createTopic(name: string, dir?: string): Promise<any> {
  const res = await fetch(`${BASE}/api/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dir: dir ?? '' }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Create failed: ${res.status}`)
  }
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

export function connectWS(
  onStatus: (data: any) => void,
  onConn?: (connected: boolean) => void,
): { close: () => void } {
  let ws: WebSocket | null = null
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/ws`)
    ws.onopen = () => onConn?.(true)
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'status') onStatus(msg.data)
      } catch { /* ignore */ }
    }
    ws.onclose = () => {
      onConn?.(false)
      if (!closed) retry = setTimeout(connect, 3000)
    }
  }

  connect()
  return {
    close: () => {
      closed = true
      if (retry) clearTimeout(retry)
      ws?.close()
    },
  }
}
