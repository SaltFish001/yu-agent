// yu-agent Web UI demo server
// Usage: node serve-demo.js
// Open http://localhost:2420

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'

const PORT = 2420
const ROOT = new URL('.', import.meta.url).pathname

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = createServer((req, res) => {
  let path = req.url === '/' ? '/demo.html' : req.url
  // strip query string
  path = path.split('?')[0]

  const filePath = join(ROOT, path)
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('404 Not Found')
    return
  }

  const ext = extname(filePath)
  const content = readFileSync(filePath)

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  res.end(content)
})

server.listen(PORT, () => {
  console.log(`\n  🎣 yu-agent Web UI demo`)
  console.log(`  ─────────────────────`)
  console.log(`  → http://localhost:${PORT}`)
  console.log(`  → http://0.0.0.0:${PORT}\n`)
})
