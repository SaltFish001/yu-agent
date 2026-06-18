# Web UI 优化计划

## 现状

| 文件 | 行数 | 作用 |
|------|------|------|
| `server.ts` | 186 | Bun.serve HTTP + WebSocket SSE + REST API |
| `demo.html` | 374 | 单页前端 (Tailwind + Alpine.js + HTMX) |
| `serve-demo.ts` | 47 | 独立静态文件服务器 (仅 demo.html) |

**痛点：**
- 3 个 CDN 外链 (Tailwind / Alpine.js / HTMX) + Google Fonts — 离线不可用
- `/api/chat` 返回 mock 数据，未接入 AgentLoop
- 会话列表、消息、监控面板数据全部硬编码
- SSE 通过 Bun WebSocket 实现，非标准 EventSource 协议
- 无构建步骤，CSS/JS 内联在 HTML 中不可维护
- `server.ts` 使用 WebSocket 模拟 SSE，Bun 的 `server.upgrade()` 要求客户端支持 WebSocket

## 优化项

### P0 — 接入真实后端

| 任务 | 说明 | 预估 |
|------|------|------|
| `POST /api/chat` 调 AgentLoop | 替换 mock，调用 actual executePlan/AgentLoop | ~80 LOC |
| `GET /api/status` 返回实时数据 | 内存/进程/会话/工具调用统计 | ~60 LOC |
| SSE `/events` 推送 agent 状态 | 用 `ReadableStream` 做标准 SSE，弃 WebSocket | ~50 LOC |
| 会话列表 CRUD API | 对接 DB 层 `getTopics/listTopics` | ~100 LOC |

### P1 — 前端零 CDN 依赖

| 任务 | 说明 | 预估 |
|------|------|------|
| Tailwind CSS → 内联工具集 | 用 Tailwind CLI 生成 `tailwind.css`，本地 serve | 配置 5min |
| Alpine.js → 原生 JS | 替换为 Handlebars 模板或直接 DOM 操作 (无框架) | ~200 LOC |
| HTMX SSE → EventSource | 原生 `EventSource` 替代 HTMX SSE 扩展 | ~30 LOC |
| Google Fonts → 系统字体栈 | `system-ui, sans-serif` 替代 Inter 字体 | 1 行 CSS |

### P2 — 构建与部署

| 任务 | 说明 | 预估 |
|------|------|------|
| `bun run build:web` | Tailwind CLI + HTML 内联打包 | 配置 |
| `bun run dev:web` | 开发模式热更新 | 配置 |
| Docker 多阶段构建 | `bun build` 产出 + `bun run web` | ~20 行 Dockerfile |
| 集成到 `yu server` 命令 | `bin/yu.ts` 新增 `server` 子命令 | ~30 LOC |

### P3 — 架构优化

| 任务 | 说明 | 预估 |
|------|------|------|
| `webui/assets/` 目录 | 拆分 CSS/JS/HTML，不内联 | 文件重组 |
| 前端 TS 文件 | `webui/client.ts` 类型安全的前端逻辑 | ~150 LOC |
| 去掉 `'url'` 模块引用 | `fileURLToPath` → `import.meta.dir` (Bun 原生) | 1 行 |
| Monitor 面板实时推送 | 通过 SSE 推送 agent/工具调用/记忆统计 | ~80 LOC |

## 实施顺序

```
Phase 1 (P0): 后端真实 API 接入
  1. SSE ReadableStream 改造 (弃 WebSocket)
  2. /api/status 实时数据
  3. /api/chat 接 AgentLoop
  4. 会话 CRUD

Phase 2 (P1): 前端去 CDN
  1. Tailwind CLI 本地生成
  2. Alpine.js → 原生 JS
  3. HTMX SSE → EventSource
  4. 系统字体栈

Phase 3 (P2): 构建工具链
  1. bun run build:web
  2. bun run dev:web
  3. 集成到 yu server 子命令

Phase 4 (P3): 架构打磨
  1. 文件拆分 assets/
  2. 前端 TS
  3. 去 node:* 模块
  4. 实时监控推送
```

## 不做的

- ❌ SPA 框架 (React/Vue/Svelte) — 一个页面足够
- ❌ WebSocket 双向通信 — SSE 单向推送足够
- ❌ 暗/亮模式 — 仅暗色
- ❌ 移动端 PWA — 桌面工具
