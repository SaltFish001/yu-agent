// yu-agent Web UI demo server
// Usage: bun serve-demo.ts
// Open http://localhost:2420

import { existsSync } from 'fs'
import { extname, join } from 'path'

const PORT = 2420
const ROOT = new URL('.', import.meta.url).pathname

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    let path = url.pathname === '/' ? '/demo.html' : url.pathname

    const filePath = join(ROOT, path)
    if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
      return new Response('404 Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const ext = extname(filePath)
    return new Response(Bun.file(filePath), {
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    })
  },
})

console.log(`\n  🎣 yu-agent Web UI demo`)
console.log(`  ─────────────────────`)
console.log(`  → http://localhost:${PORT}`)
console.log(`  → http://0.0.0.0:${PORT}\n`)
