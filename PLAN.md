# yu-agent 完整改进计划

> 覆盖范围：Web UI / UX / 核心引擎 / CLI / 子系统 / 文档 / 测试  
> 已排除：之前已修复的项（见末尾"已修复清单"）

---

## Phase 1: 消息持久化（让"永久对话"真正成为永久）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1.1 | `/api/chat` 完成后写入 messages 表 | `server.ts` | 调用已有的 `insertMessage()` (`db-entities.ts:317`) |
| 1.2 | 新增 `GET /api/messages?limit=&before=` | `server.ts` | 游标分页，调用已有的 `getMessages()` |
| 1.3 | client init 时加载历史消息 | `client.ts` | `fetch /api/messages?limit=50` → 灌入 `state.messages` |
| 1.4 | 聊天容器顶部 `IntersectionObserver` 懒加载更早消息 | `client.ts` | 滚动到顶 → fetch before=oldest_id → `insertBefore` 不重建 DOM |
| 1.5 | 消息内容建 FTS5 全文索引 + `GET /api/messages/search?q=` | `db-entities.ts`, `server.ts` | 关键词搜索历史对话 |

---

## Phase 2: 聊天体验修复

### 2.1 思考内容显示
| # | 任务 | 文件 |
|---|------|------|
| 2.1.1 | `ProviderResponse` 加 `reasoning_content` 字段 | `provider.ts:89-93` |
| 2.1.2 | `ContextMessage` 加 `reasoning` 字段 | `context-manager.ts:25-34` |
| 2.1.3 | `callLLM()` 透传 reasoning | `agent-loop.ts:200-214` |
| 2.1.4 | `/api/chat` 返回 reasoning | `server.ts:827-849` |
| 2.1.5 | 前端 toggle + `<details>` 折叠区（默认折叠） | `client.ts`, `style.css` |

### 2.2 Markdown 渲染
| # | 任务 | 文件 |
|---|------|------|
| 2.2.1 | 修复双重转义 bug（code 块内容被 escapeHtml → 显示 `&lt;div&gt;`） | `client.ts:149-175` |
| 2.2.2 | 用 `marked` 替换手写正则（表格/引用/图片/嵌套） | `client.ts`, `package.json` |
| 2.2.3 | 代码块加语法高亮（`highlight.js`） | `client.ts` |
| 2.2.4 | 修复 Markdown URL href 的 `"` 注入漏洞 | `client.ts:169` |

### 2.3 渲染和状态
| # | 任务 | 文件 |
|---|------|------|
| 2.3.1 | 消息列表从全量 `innerHTML` 改为增量 DOM（`appendChild` / `insertBefore`） | `client.ts:198` |
| 2.3.2 | `hasStatusChanged()` 比较字段扩展到 topics/events/skills/agentStats | `client.ts:383-387` |
| 2.3.3 | 消除 `window.__lastStatus`，`applyStatus(data)` 直接传 data 给 `renderPanels` | `client.ts:296-344,593,740` |
| 2.3.4 | WS/SSE/HTTP 三通道加去重（消息版本号或 requestId） | `client.ts` |
| 2.3.5 | 代码块复制按钮（CSS 已写，JS 未写） | `client.ts` |
| 2.3.6 | typing-dots 加 CSS 动画 | `style.css` |
| 2.3.7 | loading-indicator 实际激活（请求开始时 `.active = true`） | `client.ts` |

### 2.4 消息元数据
| # | 任务 | 文件 |
|---|------|------|
| 2.4.1 | 每条消息显示时间戳 | `client.ts:198-215` |
| 2.4.2 | assistant 消息显示模型名 + 迭代轮数 + token 消耗 | `client.ts` |

---

## Phase 3: Streaming & Tool Call 实时展示

| # | 任务 | 文件 |
|---|------|------|
| 3.1 | `/api/chat` 改为 SSE 流式：push `tool_call_start` / `tool_call_result` / `thinking` / `content_chunk` / `done` | `server.ts:809-849` |
| 3.2 | AgentLoop 每轮 tool call 透出进度事件（不改核心循环，加 `onToolCall` 回调） | `agent-loop.ts` |
| 3.3 | 前端实时渲染 tool call 卡片：`🔧 Reading src/login.ts...` → `✅ Done (200 lines, 1.2s)` | `client.ts` |
| 3.4 | 思考内容流式显示（`reasoning_content` chunk by chunk） | `client.ts` |
| 3.5 | Diff 卡片：agent 修改文件后用 `git diff` 渲染变更对比 | `client.ts`, `server.ts` |

---

## Phase 4: API 补齐（后端函数已有，缺端点）

| # | 任务 | 文件 |
|---|------|------|
| 4.1 | `POST /api/topics` — 创建 topic | `server.ts` |
| 4.2 | `POST /api/topics/:name/switch` | `server.ts` |
| 4.3 | `POST /api/topics/:name/rename` | `server.ts` |
| 4.4 | `POST /api/topics/:name/archive` | `server.ts` |
| 4.5 | `POST /api/topics/:name/bg` — 后台任务 | `server.ts` |
| 4.6 | `GET /api/messages` + `/api/messages/search` — 见 Phase 1 |

---

## Phase 5: CLI 破损修复

| # | 问题 | 位置 | 修复 |
|---|------|------|------|
| 5.1 | `yu memory` 帮助列表有入口但无 handler，落入 default path → classifier | `bin/yu.ts:118` | 删掉 `YU_COMMANDS` 中的 `'memory'` 或加一个读取 `knowledgeStats()` 的最小 handler |
| 5.2 | `/memory` slash 命令 fall through 到不存在的 Pi 子系统 | `bin/yu.ts:1321-1324` | 删除或替换为同上 |
| 5.3 | `yu escalation` 只有 `console.log('Not yet implemented')` | `bin/yu.ts` | 删除入口或实现 |
| 5.4 | `test_direct.ts` 导入不存在的 `dist/extension/spawn.js` | `test_direct.ts` | 删除文件 |
| 5.5 | `yu run --bg` 解析出的 `isBackground` 永远为 false——`--bg` 夹在参数之间时被 slice 切掉 | `bin/yu.ts:935-945` | 在 `--agent` 提取之前先处理 `--bg/--background` |

---

## Phase 6: 终端面板修复

| # | 问题 | 位置 | 修复 |
|---|------|------|------|
| 6.1 | `terminalSessions` Map 以 topic 名为 key → 同名开第二个终端覆盖第一个（旧进程未 kill） | `server.ts:405` | key 改为 `${topic}-${counter}`，关闭时 `kill('SIGTERM')` + 超时 `SIGKILL` |
| 6.2 | resize 只设 `COLUMNS`/`LINES` env var，不调 ioctl → 已运行的子进程无效 | `server.ts:616-618` | 需 Bun 原生 PTY 支持或改用 node-pty；若短期不可行则加注释说明限制 |
| 6.3 | 多处 `(proc.stdin as any).write()` | `server.ts:610,622,626` | 替换为类型安全的写法 |

---

## Phase 7: Web UI/UX 全面优化

### 7.1 信息架构和导航
| # | 任务 | 说明 |
|---|------|------|
| 7.1.1 | 侧边栏"规则" section：从 WS 数据填充 `#rule-list`（数据已有，只差渲染） | `client.ts` |
| 7.1.2 | 侧边栏"工具" section：同上 | `client.ts` |
| 7.1.3 | 侧边栏"记忆" section：删除（子系统已移除）或替换为 knowledge stats | `client.ts`, `demo.html` |
| 7.1.4 | Topic 详情从聊天注入改为侧边抽屉 / modal 渲染 | `client.ts:513-588`, `demo.html` |
| 7.1.5 | 侧边栏最近消息摘要（最近 5 条消息预览，点击跳转） | `client.ts`, `demo.html` |

### 7.2 响应式布局和移动端
| # | 任务 | 说明 |
|---|------|------|
| 7.2.1 | 720px 以下侧边栏改为 hamburger 按钮 + slide-out 抽屉 | `client.ts`, `style.css`, `demo.html` |
| 7.2.2 | 移动端适配消息气泡宽度（当前 80% 在小屏太宽）、输入区高度 | `style.css:289` |
| 7.2.3 | 触摸交互：swipe 关闭抽屉、长按消息出上下文菜单 | `client.ts` |

### 7.3 输入区体验
| # | 任务 | 说明 |
|---|------|------|
| 7.3.1 | 输入框改为 `<textarea>` 自适应高度（或保留 input + Shift+Enter 换行提示） | `demo.html:108`, `style.css` |
| 7.3.2 | 输入区占位提示改为动态内容（如 "yu 正在思考…" 时禁用输入） | `client.ts` |
| 7.3.3 | 消息字数计数器（靠近 10000 字符上限时警告） | `client.ts` |

### 7.4 通知和反馈
| # | 任务 | 说明 |
|---|------|------|
| 7.4.1 | Toast 通知系统：错误、完成、连接断开/恢复 | `client.ts`, `style.css` |
| 7.4.2 | 长任务完成时发送 Browser Notification（`Notification API`，用户可开关） | `client.ts` |
| 7.4.3 | 连接状态从侧边栏底部提升到顶部 header 固定显示（醒目绿/红点） | `client.ts`, `demo.html` |
| 7.4.4 | 错误消息加重试按钮 + 错误分类（网络/超时/API/未知） | `client.ts:489-501` |

### 7.5 可访问性
| # | 任务 | 说明 |
|---|------|------|
| 7.5.1 | 聊天容器 `role="log"` 已设置；补充 `aria-live="polite"` 让新消息自动播报 | `demo.html:100` |
| 7.5.2 | 面板 tabs 加 `role="tablist"` / `role="tab"` / `aria-selected` | `demo.html:89-96`, `client.ts:849-864` |
| 7.5.3 | 侧边栏可折叠 sections 加 `aria-expanded` | `client.ts:986-1003` |
| 7.5.4 | 所有无文本的图标按钮加 `aria-label` | `demo.html`, `client.ts` |
| 7.5.5 | 焦点管理：发消息后焦点回到输入框；modal 打开时焦点 trap 在 modal 内 | `client.ts` |

### 7.6 视觉润色
| # | 任务 | 说明 |
|---|------|------|
| 7.6.1 | 新消息滑入动画（`@keyframes slideIn` + `animation` on `.message`） | `style.css` |
| 7.6.2 | 滚动到底部按钮（用户向上翻历史时出现 ↓ 箭头，点击滚回底部） | `client.ts`, `style.css` |
| 7.6.3 | Dashboard 卡片骨架屏（初始加载时灰色脉冲动画） | `style.css`, `client.ts` |
| 7.6.4 | 面板切换过渡动画（fade in/out 150ms） | `style.css` |
| 7.6.5 | 统一中文/英文（当前 sidebar 混合 "Uptime/RSS/在线/离线" → 全部中文） | `demo.html`, `client.ts` |

### 7.7 对话功能
| # | 任务 | 说明 |
|---|------|------|
| 7.7.1 | 消息右键菜单：复制 / 删除 / 引用回复 | `client.ts` |
| 7.7.2 | 对话导出（一键导出当前对话为 Markdown 文件） | `client.ts`, `server.ts` |
| 7.7.3 | "新对话"按钮真正创建新 session（而非仅清空——配合 Phase 1 的 session cookie） | `client.ts:1038-1041` |
| 7.7.4 | 消息内代码块 "Apply" 按钮（将 diff 代码块应用到文件系统——需后端支持） | `client.ts`, `server.ts` |

### 7.8 设置面板
| # | 任务 | 说明 |
|---|------|------|
| 7.8.1 | 设置齿轮图标 → modal 面板 | `client.ts`, `demo.html` |
| 7.8.2 | 可配置项：思考内容默认展开/折叠、通知开关、字体大小、消息密度 | `client.ts` |
| 7.8.3 | 设置持久化到 `localStorage`（`yu:preferences` key） | `client.ts` |

### 7.9 性能和基础设施
| # | 任务 | 说明 |
|---|------|------|
| 7.9.1 | 修复内存泄漏（`setInterval` 在 `beforeunload` / 组件销毁时 `clearInterval`） | `client.ts` |
| 7.9.2 | 加 `Content-Security-Policy` header | `server.ts` |
| 7.9.3 | `/assets/*` 静态文件加 `Cache-Control: public, max-age=3600`（当前 `no-cache` 每次重新请求） | `server.ts:164` |
| 7.9.4 | 加 favicon + meta tags（`og:title`, `og:description`） | `demo.html` |
| 7.9.5 | 暗色/亮色主题切换（`prefers-color-scheme` media query + 手动 toggle） | `style.css` |
| 7.9.6 | 打印样式（`@media print` — 隐藏侧边栏/终端/输入区，只留对话内容） | `style.css` |

---

## Phase 8: 核心引擎和子系统

### 8.1 架构一致性
| # | 任务 | 说明 |
|---|------|------|
| 8.1.1 | Plan agent 工具对齐：`config.ts:238` 加 `'web'` 到 `builtinToolNames`（设计要求 Web 搜索，实际只有 read/grep/find/ls） | `config.ts` |
| 8.1.2 | `prompts/plan.md` 确认是否描述了 Web 搜索用法——如有则不需要改代码 | `prompts/plan.md` |

### 8.2 Team mode 辅助功能
| # | 任务 | 文件 |
|---|------|------|
| 8.2.1 | snapshot.json 注入 Coder agent context | `team-orchestrator.ts:193` |
| 8.2.2 | 无冲突时自动 git merge（当前只检测不合并） | `team-orchestrator.ts:280-296` |
| 8.2.3 | sharedDir 清理（当前无清理代码） | `team-orchestrator.ts` |

### 8.3 代码质量
| # | 任务 | 文件 |
|---|------|------|
| 8.3.1 | `mainCli` 圈复杂度 183——拆分为路由表 `{ [command]: handler }` | `bin/yu.ts` |
| 8.3.2 | `executePlan` 圈复杂度 36 / 传递深度 12——按 Step 1-7 拆分为独立函数 | `scheduler.ts` |
| 8.3.3 | `runMigrations` 8 个 migration 耦合在一个函数——改为迁移文件数组 | `db-core.ts` |

### 8.4 测试补回
| # | 任务 | 文件 |
|---|------|------|
| 8.4.1 | `insertAgentRun` / `updateAgentRunStatus` DB 写路径无集成测试 | `tests/` |
| 8.4.2 | `mcp-sse.test.ts` 中 `_simulateDisconnect` 改为实际可用的 disconnect 模拟，或删除 | `tests/mcp-sse.test.ts` |

---

## Phase 9: 文档同步

| # | 任务 | 文件 |
|---|------|------|
| 9.1 | `ARCHITECTURE.md` 在 SessionPool / Memory / Monitor TUI 章节顶部加 `> ⚠️ 已移除，保留作为历史参考` | `ARCHITECTURE.md` |
| 9.2 | `README.md` 扩展 API 段：删除 `getSessionPool()` / `getAllPoolsStats()` 示例（函数不存在），改为 `spawnAgent()` | `README.md:189-200` |
| 9.3 | `DESIGN.md` v8 变更表加 `监控面板 → Web UI (yu ui)` | `DESIGN.md:13-21` |
| 9.4 | `DESIGN.md` v8 变更表同步 Plan agent 工具名 | `DESIGN.md` |
| 9.5 | 创建 ADR（`codebase-memory-mcp` 索引时提示 `adr_present: false`） | `.code-graph/` |

---

## Phase 10: 前端增强（可延后）

| # | 任务 | 说明 |
|---|------|------|
| 10.1 | 消息向量化搜索（`message_chunks` + embedding 列 + DeepSeek embedding API） | 语义搜索 "上次修的那个内存泄漏" |
| 10.2 | 键盘快捷键（`Ctrl+K` 命令面板、`Ctrl+.` toggle sidebar、`Escape` close modal） | |
| 10.3 | 拖拽文件到输入区上传（`drop` 事件 → 读文件内容 → 注入上下文） | |
| 10.4 | 消息钉选 / 书签（`state.pinnedMessages`，侧边栏快捷访问） | |
| 10.5 | Service Worker + 离线缓存（Cache API 缓存 `/assets/*`，离线可用） | |
| 10.6 | Agent 多步任务进度条（Step 1/5 → Step 2/5 → …），解析 scheduler plan 的 `parallel_groups` | |

---

## 工作量估算

| Phase | 文件数 | 工作量 | 可并行？ |
|-------|--------|--------|----------|
| 1. 消息持久化 | ~4 | 中 | — |
| 2. 聊天体验修复 | ~6 | 中-大 | 依赖 Phase 1 |
| 3. Streaming & Tool Call | ~4 | 大 | 依赖 Phase 1-2 |
| 4. API 补齐 | ~1 | 小 | ✅ 可与 5-6 并行 |
| 5. CLI 破损修复 | ~3 | 小 | ✅ |
| 6. 终端面板 | ~2 | 小 | ✅ |
| **7. Web UI/UX 全面优化** | **~5** | **大** | **可分批** |
| 8. 核心引擎 | ~7 | 中-大 | 重构独立 |
| 9. 文档同步 | ~4 | 小 | ✅ 随时 |
| 10. 前端增强 | ~5 | 大 | 可延后 |

**总文件数：** ~41 个  
**建议执行顺序：** Phase 1 → 2 → 3 → 4+5+6+7 部分并行 → 8 → 9 → 10

---

## 已修复清单（之前 session 完成）

- [x] `biome.json` — 排除 `env.d.ts`，禁用 `noExplicitAny`/`noDescendingSpecificity`
- [x] `tracker.ts` — `catch {}` → `log.warn(...)` 带 context
- [x] `tracker.test.ts` — 重写为 6 个内存测试 + `scheduler.test.ts` mock 泄漏修复
- [x] `transport.ts` — 新增 `getEvents()`；`mcp-stream.ts` — 使用 `getEvents()`；`transport-sse.ts` — 声明 `sseAbort`
- [x] `demo.html` — 18 个 `<button>` 加 `type="button"`
- [x] `package.json` — `lint:fix` flag `--apply` → `--fix`
- [x] `bin/yu.ts` — 删除未使用的 `_bgIdx`
- [x] `mcp-sse.test.ts` — 删除未使用的 `_sendCallback`
- [x] 测试回归 — 382/382 pass, typecheck 0 errors
