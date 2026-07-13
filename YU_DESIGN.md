# yu-agent 设计文档（汇总版）

> **v0.3.1** (2026-07-10) — DeepSeek 原生编程代理  
> 调度器 + 多子 agent + 团队模式 + Web UI  
> 零外部运行时依赖，Bun 原生构建，单文件发布

---

## 目录

1. [架构总览](#一架构总览)
2. [模块依赖与目录结构](#二模块依赖与目录结构)
3. [数据流与请求管线](#三数据流与请求管线)
4. [Agent 类型与配置](#四agent-类型与配置)
5. [调度器设计](#五调度器设计)
6. [Prompt 系统](#六prompt-系统)
7. [Session 生命周期与缓存模型](#七session-生命周期与缓存模型)
8. [Team Mode 编排](#八team-mode-编排)
9. [Web UI](#九web-ui)
10. [工具与集成](#十工具与集成)
11. [资源限制与配置](#十一资源限制与配置)
12. [健康度与测试](#十二健康度与测试)
13. [灵感来源](#十三灵感来源)

---

## 一、架构总览

### 1.1 一句话

用户输入（CLI 或 Web UI）→ 调度器分类意图 → 执行器按并行组并发 spawn AgentLoop → LSP 验证 → 测试运行 → 决策持久化。

### 1.2 核心原则

- **纯 DeepSeek** — 仅 v4-flash 和 v4-pro，无多模型路由
- **零外部依赖** — 所有逻辑在进程内完成，无外部 SDK/运行时
- **缓存优先** — Three-Region 前缀缓存模型，降低 API 成本
- **Bun 原生** — `Bun.spawn`/`Bun.file`/`Bun.build`，无 `node:` 或 `child_process`

### 1.3 运行时路径 (v8)

```
用户输入（CLI: yu "fix login bug" 或 Web UI）
    │
    ▼
classifier.ts — 意图分类 (fast path + LLM fallback)
    │
    ▼
scheduler.ts — 执行计划 (executePlan)
    │
    ├── pass_through → deepseek.js (直接 API)
    │
    └── 编程任务
         │
         ▼
    executor.ts — 并行组执行 (runParallelGroup)
         │
         ▼
    spawn.ts → agent-loop.ts (AgentLoop 代理)
         │
         ▼
    runAgent() — LLM 调用 (带 tool use 的 agent 循环)
         │
         ▼
    verifier.ts — LSP 验证 + 测试运行
         │
         ▼
    tracker.ts — 决策持久化
```

### 1.4 关键差异（相对 Pi SDK 架构）

Pi SDK 已移除（2026-06）。以下差异点：

- 无 Pi SessionPool → 每次 spawn 新建 `runAgent()`
- 工具全部 Bun 原生实现 (`tools/*.ts`)
- 上下文管理自有 (`context-manager.ts`)
- 构建：`bun build` → 单文件 `dist/yu.js`（190 模块，330ms）
- 测试：`bun test` → 612 测试，0 失败

---

## 二、模块依赖与目录结构

### 2.1 顶层目录

```
~/yu-agent/
├── bin/yu.ts                  # CLI 入口：路由所有命令
├── src/                       # 核心抽象层
│   ├── types/                 # 基础类型定义
│   ├── agent/                 # Agent 生命周期管理
│   ├── tool/                  # 工具注册与执行
│   ├── llm/                   # LLM 调用与提供商管理
│   └── memory/                # 记忆存储与管理
├── extension/                 # 具体实现层
│   ├── agent-loop.ts          # Agent 执行循环
│   ├── classifier.ts          # 意图分类
│   ├── scheduler.ts           # 主调度器 (143 行)
│   ├── executor.ts            # Agent 派发 + 并发控制
│   ├── spawn.ts               # SessionPool + spawn 代理
│   ├── verifier.ts            # LSP 校验 + 测试
│   ├── tracker.ts             # 状态追踪 + 决策持久化
│   ├── template.ts            # LLM 输出解析
│   ├── mcp-manager.ts         # MCP 服务器管理
│   ├── context-manager.ts     # 上下文压缩
│   ├── bootstrap.ts           # 启动时注册 Agent 类型
│   ├── topic.ts               # Topic 系统 (1039 行)
│   ├── supervisor.ts          # Worker 进程管理
│   ├── deepseek.ts            # DeepSeek API 封装
│   ├── provider.ts            # LLM 提供商封装
│   ├── team/                  # 团队子系统
│   │   ├── orchestrator.ts    # 团队编排
│   │   ├── types.ts           # 团队类型定义
│   │   └── index.ts           # 组件导出
│   ├── memory/                # 记忆系统
│   ├── terminal/              # PTY 终端
│   └── tools/                 # 工具注册表
├── webui/                     # Web UI
│   ├── server.ts              # Hono + Bun.serve 服务器
│   └── frontend/              # Vite + React + TypeScript
├── prompts/                   # Agent 提示词文件
├── dist/                      # 构建产物
└── tests/                     # 测试
```

### 2.2 src（核心抽象层）vs extension（具体实现）

| src 模块 | extension 对应实现 | 职责 |
|----------|-------------------|------|
| `src/agent/` | `extension/agent-loop.ts` | Agent 执行循环 |
| `src/tool/` | `extension/tools/registry.ts` | 工具注册表 |
| `src/llm/` | `extension/deepseek.ts`, `extension/provider.ts` | LLM 调用 |
| `src/memory/` | `extension/session-context.ts`, `extension/db.ts` | 持久化存储 |
| `src/types/` | `extension/types.ts` | 扩展类型 |

### 2.3 扩展模块清单（extension/）

| 模块 | 行数 | 职责 | 测试覆盖 |
|------|------|------|---------|
| `topic.ts` | 1,039 | Topic CRUD + 事件通道 + 初始化 | ✅ 39 测试 |
| `bin/yu.ts` | 1,001 | CLI 入口 | 🟡 逻辑已拆分 |
| `supervisor.ts` | 978 | Worker 进程管理 | ✅ 16 测试 |
| `mcp-manager.ts` | 529 | MCP 服务器生命周期 | 🟡 需 MCP 实例 |
| `lsp-manager.ts` | 452 | LSP 服务器管理 | 🟡 需 LSP 实例 |
| `context-manager.ts` | 451 | 上下文压缩/缓存 | ✅ 18 测试 |
| `terminal/index.ts` | 401 | PTY/SSH 终端 | 🟡 集成测试 |
| `knowledge/index.ts` | 386 | FTS5 全文搜索 | 🟡 集成测试 |
| `agent-loop.ts` | ~350 | Agent 执行循环 | ✅ 17 测试 |

---

## 三、数据流与请求管线

### 3.1 完整请求管线

```
用户输入 "fix login bug"
    │
    ▼
1. resetTracker() — 初始化状态追踪
    │
    ▼
2. classifyIntent() — 意图分类
   ├── Fast path: >200字 / 角色扮演 → pass_through
   └── LLM: spawn scheduler agent (v4-flash, maxTurns=3)
        → 输出 JSON 规划
    │
    ▼
3. 解析调度器输出
   ├── 提取 JSON（从 markdown 代码块）
   ├── 清理 JS 注释 / 单引号 / trailing commas
   └── JSON.parse → SchedulerPlan
    │
    ├── pass_through=true → 直接 API 调用，返回
    │
    └── 编程任务 → 继续执行
    │
    ▼
4. Plan Interpretation
   ├── Build agentMap from plan.agents
   ├── Load decisions from decisions.json
   └── Inject knowledge context (RAG)
    │
    ▼
5. 并行组执行 (executor.ts)
   For each group in plan.parallel_groups:
     └── runWithConcurrencyLimit(tasks, 4)
         For each agent in group (Promise.all):
           1. checkpointGuard('agent_spawn')
           2. trackAgent(id, 'running')
           3. spawnAgentWithTimeout(config)
           4. trackAgent(id, 'completed'|'failed')
           5. Collect results
    │
    ▼
6. spawnAgent() (spawn.ts)
   1. 获取/创建 SessionPool（按 type 隔离）
   2. pool.call(task, config):
      → 序列化 mutex
      → 上下文压缩 (>75% usage)
      → 重置 (>300 turns / >900k tokens)
      → Append agent prefix + task
      → _promptWithTimeout(session, task, timeout)
      → Extract response + cache stats
      → Turn-end compaction (截断 >3000 token 结果)
   3. 返回 SpawnResult
    │
    ▼
7. 收集 Modified Files + Diff Review
   ├── parseAgentOutput(response) → 提取 files_modified
   ├── git diff --stat + git diff
   └── 用户确认 (交互式 y/N, 超时 60s)
    │
    ▼
8. LSP 验证 (verifier.ts)
   1. findProjectRoot(files)
   2. detectLspServer(ts/py/go/rust)
   3. Start LspManager → didOpen → collect diagnostics
   4. 有 error → spawn coding agent 修复（最多 2 轮）
   5. Stop LspManager
    │
    ▼
9. 测试运行 (verifier.ts)
   ├── Auto-detect: vitest/jest/mocha/pytest
   └── 失败 → spawn coding 修复（最多 2 轮）
    │
    ▼
10. 决策持久化 (tracker.ts)
    └── Write decisions.json（最近 50 条）
```

### 3.2 并行规则

**可并行：**
- 多文件独立修改 → 多个 coding agent（`Promise.all`）
- coding + search（边改边查）
- Architect + Searcher
- LSP 多文件验证
- 多模块并行 Coder / Reviewer

**串行：**
- Coder 等 Architect 出方案
- Reviewer 等 Coder 完成
- LSP 报错 → 串行修复（最多 2 轮）
- 测试失败 → 串行修复（最多 2 轮）

**并发上限：** 4（`MAX_CONCURRENCY`）

---

## 四、Agent 类型与配置

### 4.1 内置 Agent 类型

| Type | 默认模型 | Thinking | Max Turns | 内置工具 | MCP 服务器 | Skills | 用途 |
|------|---------|----------|-----------|---------|-----------|--------|------|
| `coding` | v4-pro | max | 50 | bash, read, edit, write, grep, find, ls | codegraph | — | 编码 |
| `review` | v4-flash | max | 30 | read, grep, find, ls | codegraph | — | 审查（只读） |
| `plan` | v4-pro | max | 15 | read, grep, find, ls, write | codegraph | — | 架构规划 |
| `lsp` | v4-flash | high | 20 | bash | — | — | LSP 诊断 |
| `commit` | v4-flash | high | 10 | bash | — | — | Git 提交 |
| `doc` | v4-flash | high | 20 | read, edit | codegraph | — | 文档生成 |
| `search` | v4-flash | high | 15 | bash, read, grep | codegraph | — | 代码+网页搜索 |
| `chat` | v4-flash | max | 10 | read, grep, find, bash | — | character-rp | 非编程对话与 RP |
| `general-purpose` | v4-flash | max | 3 | — | — | — | 调度器/分类器 |

### 4.2 模型路由

**v4-pro 触发条件：**
- 用户输入含"仔细""深度""pro""完全审查"等关键词
- 涉及 5+ 文件或跨模块改动
- 涉及安全/认证/加密/支付模块
- intent 为 `refactor` 或 `team`
- review 标记为深度审查

**否则 v4-flash**（快速、经济）。

### 4.3 AgentConfig 注册方式

Agent type 配置在 `extension/config.ts` 中以 `AGENT_TYPES` 记录定义，每个 type 通过三个组件绑定工具与能力：

```typescript
export const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  coding: {
    builtinToolNames: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'],
    mcpServers: ['codegraph'],
    // skillNames 未设置
  },
  chat: {
    builtinToolNames: ['read', 'grep', 'find', 'bash'],
    skillNames: ['character-rp'],
    // mcpServers 未设置
  },
  // ...
};
```

由 `extension/bootstrap.ts` 的 7 步流程在启动时顺序执行：

| 步骤 | 函数 | 说明 |
|------|------|------|
| 1 | `injectApiKeys()` | 从 ~/.yu/config.json 注入 API key 到环境变量 |
| 2 | `validateAll()` | 校验 MCP 配置与必需的环境变量 |
| 3 | `registerTypes()` | 遍历 AGENT_TYPES 注册到内存注册表 |
| 4 | `startMCP()` | 启动 MCP server manager（后台生命周期） |
| 5 | `loadSkills()` | 扫描 ~/.yu/skills/ 目录加载 .ts skill 文件 |
| 6 | `registerMcpTools()` | 从已启动的 MCP server 注册工具 |
| 7 | `registerHooks()` | 注册调度器 / 输入钩子 |

### 4.4 子 agent 输出格式（JSON）

**coding agent：**
```json
{"status": "success|partial|failed", "files_modified": [...], "summary": "...", "details": [...]}
```

**review agent：**
```json
{"status": "approved|changes_requested", "findings": [{"severity": "high|low", "file": "...", "line": 42, "message": "..."}]}
```

**search agent：**
```json
{"results": [{"source": "codebase|web", "path": "...", "line": 42, "snippet": "...", "title": "..."}]}
```

**lsp agent：**
```json
{"status": "clean|fixed|unresolved", "errors_fixed": [...], "errors_remaining": [...]}
```

**commit agent：**
```json
{"status": "committed|nothing_to_commit", "hash": "abc123", "message": "..."}
```

**doc agent：**
```json
{"status": "success", "files_written": ["docs/auth.md"]}
```

调度器根据 `status` 决定下一步：`changes_requested` → 打回 coding，`failed` → 报告用户，`unresolved` → 报告剩余 error。

---

## 五、调度器设计

### 5.1 入口

`bin/yu.ts` CLI（或 Web UI 服务器 `yu ui`）。

```
用户输入 (CLI / Web UI)
    │
    ▼
bin/yu.ts 路由
    ├── doctor, team, topic, search, graph, context, chat, ui → 直接处理
    └── 默认 → classifier.ts
           │
           ├── 非编程 (pass_through) → deepseek.js 直接 API
           │
           └── 编程 → scheduler.ts::executePlan()
```

### 5.2 意图分类

调度器 agent 是 LLM（v4-flash + max thinking），**不做编码、不改文件**。只做分类和输出 JSON 规划。

输入确认是编程任务后，输出结构化 JSON：

```json
{
  "intent": "fix|add|review|refactor|search|commit|lsp|doc|team",
  "reasoning": "判断理由",
  "agents": [
    {"type": "coding", "model": "v4-flash", "id": "coding-a", "files": ["src/auth/login.ts"]}
  ],
  "parallel_groups": [["coding-a", "coding-b"], ["review"]],
  "dependencies": {"review": ["coding-a", "coding-b"]}
}
```

### 5.3 输出解析流程

`extension/template.ts::parseSchedulerOutput()`：

1. 从 markdown 代码块提取 JSON
2. 清理 JS 注释（`//` `/* */`）
3. 标准化：单引号→双引号，True/None→true/null，非引号 key→引号
4. 移除 trailing commas，闭合不匹配的括号
5. `JSON.parse` → `SchedulerOutput`

失败时重试调度器（最多 2 次），仍失败降级为 pass_through。

### 5.4 派发与验证管线

```
Scheduler JSON 规划
    │
    ▼
hook 代码执行：
    │
    ├── 1. 按 parallel_groups 分组，每组内 Promise.all 并发 spawn
    │
    ├── 2. 等待所有 agent 返回 → 解析 JSON → 收集 files_modified
    │
    ├── 3. 对每个改动文件 spawn LSP agent（并行）
    │      error → 打回 coding 修复（最多 2 轮）
    │
    ├── 4. 跑相关测试（自动检测框架）
    │      失败 → 打回修复（最多 2 轮）
    │
    ├── 5. 写 decisions.json
    │
    ├── 6. 汇总结果
    │
    └── 错误处理：
         - 任何子 agent 超时 → 标记 failed，继续其他
         - spawn 失败 → 重试 1 次
         - 调度器输出非法 JSON → 重试调度器（最多 2 次）
         - LSP 工具不存在 → 跳过，警告用户
```

---

## 六、Prompt 系统

### 6.1 文件组织

```
~/yu-agent/prompts/
├── scheduler.md    # 调度器 — 意图分类 + JSON 规划输出
├── coding.md       # Coding Agent — Flash / Pro 分节
├── review.md       # Review Agent — 只读审查
├── plan.md         # Plan Agent — 架构规划
├── lsp.md          # LSP Agent — 诊断 + 修复
├── commit.md       # Commit Agent — 提交信息生成
├── doc.md          # Doc Agent — 文档生成
├── search.md       # Search Agent — 代码 + 网页搜索
└── team.md         # Team Mode — Architect / Coder / Reviewer / Searcher
```

另有独立副本在 `~/.yu/prompts/`（启动时从此目录加载）。

### 6.2 Scheduler Prompt（特殊）

调度器有严格格式规则：**只输出 JSON，任何非 JSON 输出触发错误重试**。

```
-- 非编程任务输出：
{"pass_through": true, "reasoning": "..."}

-- 编程任务输出：
{"intent": "...", "reasoning": "...", "agents": [...], "parallel_groups": [...], "dependencies": {}}
```

### 6.3 Coding Prompt

分 Flash / Pro 两模式：
- **Flash（v4-flash）**：单文件，小改动，精确 patch
- **Pro（v4-pro）**：多步/跨文件/重构，先出方案再执行

---

## 七、Session 生命周期与缓存模型

### 7.1 Session 生命周期

```
session_start
    │
    ▼
setSessionTag(id) — 设置 YU_SESSION_ID
setSessionAgent(agent) — 记录 agent type
setSessionModel(model) — 记录模型信息
setSessionParent(tag) — 记录父 session（fork 用）
    │
    ▼
loop: for each user turn
    │
    ├── before_agent_start hook
    │   ├── upsertSession() — 创建/更新 session 元数据
    │   └── insertMessage('user') — 保存用户消息
    │
    ├── pool.call(task, config)
    │   1. 获取序列化 mutex
    │   2. 上下文压缩检查 (>75% → compact)
    │   3. Session 重置检查 (>300 turns / >900k tokens)
    │   4. 构建完整 task: agentPrefix + userInput
    │   5. _promptWithTimeout(session, task, timeout)
    │   6. Extract assistant response + cache stats
    │   7. Turn-end compaction (截断 >3000 token)
    │
    ├── turn_end hook
    │   └── insertMessage('assistant') — 保存助手回复
    │
    ▼
session_shutdown
    ├── flushFinalStatus() — 写最终状态到 SQLite
    └── pool.dispose() — 释放 SessionPool
```

### 7.2 Cache-First Three-Region 模型

| Region | 内容 | 可变性 | 缓存行为 |
|--------|------|--------|---------|
| **Immutable Prefix** | System prompt + tool definitions + schemas | 创建时写入，永不修改 | 完美缓存命中 |
| **Append-Only Log** | 用户消息 + 助手回复 | 单调追加 | 可预测缓存 |
| **Volatile Scratch** | 工具调用结果 | 每轮结束自动压缩 | 不参与前缀缓存 |

**设计动机：** DeepSeek API 定价中缓存命中与未命中相差 10 倍。通过保持前缀不可变和日志只追加，每次调用复用缓存前缀。

### 7.3 数据存储

```sql
-- ~/.yu/sessions.db (SQLite)
sessions  — Session 元数据
messages  — 对话历史
agents    — 子 agent 状态
summary   — 聚合计数
cache     — 缓存命中/未命中统计
todos     — 每个 session 的任务列表
```

### 7.4 Session CLI

```bash
yu session list                    # 列出所有 session
yu session show <tag>              # 详情 + 历史
yu session resume <tag>            # 恢复 session
yu session fork <tag>              # 从历史分支新 session
yu session archive <tag>           # 软删除
yu session unarchive <tag>         # 恢复
yu session todo <tag> add "..."    # 添加任务
yu session backup [path]           # 备份
yu session restore <path>          # 恢复
yu session clean [--days N]        # 清理旧 session
```

---

## 八、Team Mode 编排

### 8.1 4 阶段管线

```
Phase 1: 研究                Phase 2: 编码
┌──────────────────┐         ┌──────────────────────┐
│  Architect (pro) │◄───────►│  Coder A (module 1)  │
│  Searcher (flash)│         │  Coder B (module 2)  │
│                  │         │  Coder C (module 3)  │
│  Output: plan.md  │         │  Output: 代码        │
│  + context.md     │         │                      │
└──────────────────┘         └──────────┬───────────┘
                                        │
                                        ▼
Phase 3: 审查                Phase 4: 集成
┌──────────────────┐         ┌──────────────────────┐
│  Reviewer A      │◄────────│ Git 冲突检测          │
│  Reviewer B      │         │ 自动合并（无冲突）    │
│  Reviewer C      │         │ 标记冲突（用户决策）  │
│                  │         │ 清理 temp 目录        │
│  Max 2 fix cycles│         │                      │
└──────────────────┘         └──────────────────────┘
```

### 8.2 关键机制

- **Mailbox 异步通信** — 团队成员通过原子 JSON 文件交换消息，每个成员在每次 prompt 前轮询 inbox
- **共享任务板** — `yu team task <runId> create/list`
- **冲突检测** — `git diff --name-only --diff-filter=U` 检测合并冲突
- **状态机** — 运行时状态转换（`creating → active → shutdown_requested → deleting → deleted`）严格校验
- **崩溃恢复** — 运行时状态持久化到 `~/.yu/runtime/{runId}/state.json`

### 8.3 Team CLI

```bash
yu team create <name> lead:plan coder:coding reviewer:review
yu team list                        # 列出活跃团队
yu team status <runId>              # 查看团队状态
yu team send <runId> <member> <msg> # 发送消息
yu team task <runId> create <title> # 创建任务
yu team shutdown <runId>            # 结束团队
```

---

## 九、Web UI

### 9.1 技术栈

- **Server：** Hono (v4) + Bun.serve 原生 HTTP/WebSocket
- **Frontend：** Vite + React 19 + TypeScript + Zustand
- **通信：** WebSocket（实时状态推送）+ HTTP SSE（事件流）+ fetch（聊天 API）
- **构建：** `bun run build` → dist/（CSS 11KB + JS 201KB + markdown 344KB）

### 9.2 API 端点

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/status` | GET | 全量状态快照（version/uptime/memory/topics/agentStats/ws/...） |
| `/api/chat` | POST | 发送消息，返回 AgentLoop 结果 |
| `/api/chat/stream` | POST | SSE 流式聊天 |
| `/api/topics` | GET | 列出所有 topic + active topic name |
| `/api/topic/:name` | GET | Topic 详情（info + file tree + git diff） |
| `/ws` | GET (upgrade) | WebSocket 实时状态推送（每 2s） |
| `/events` | GET | SSE 事件流（agent_complete） |
| `/api/terminals` | GET | 终端 session 列表 |
| `/api/ws/reset` | POST | 重置 WebSocket |
| `/` | GET | SPA 首页 (index.html) |
| `/assets/*` | GET | 静态资源 |

### 9.3 前端界面

```
┌─────────────────────────────────────────────────────────┐
│  侧栏 (260px)    │         聊天区域                       │
│ ┌───────────────┐ │  ┌─────────────────────────────────┐│
│ │ y             │ │  │                                 ││
│ │               │ │  │  空态/消息流                     ││
│ │ 搜索 topic…   │ │  │                                 ││
│ │               │ │  │  ┌─────────────────────────┐    ││
│ │ ▶ my-project  │ │  │  │ 用户 / 助手 消息气泡    │    ││
│ │ ○ another     │ │  │  │ markdown 渲染           │    ││
│ │ ⏳ long-task  │ │  │  └─────────────────────────┘    ││
│ │               │ │  │                                 ││
│ │               │ │  ├──────────────────────────────┤  ││
│ │⚙️ 管理        │ │  │ [输入消息…]          [发送]  │  ││
│ └───────────────┘ │  └──────────────────────────────┘  ││
└─────────────────────────────────────────────────────────┘

子窗口（点 ⚙️ → window.open()）：
┌─────────────────────────────────────────────────┐
│  y │ 状态 │ 子agent │ 后台 │ 规则 │ 技能  │ ✕  │
│    ├─────────────────────────────────────────────┤
│    │ 版本 / 运行时间 / RSS / Heap / WS / Agent    │
│    │ 状态卡片 + 详情表格                          │
└─────────────────────────────────────────────────┘
```

- **侧栏：** 260px，y 品牌 + 搜索 topic + topic 列表（状态图标▶/⏳/○ + 名称 + 轮次 + 终端按钮 $_）
- **聊天：** 全宽消息流，markdown 渲染（代码块/表格/列表），用户白/助手灰
- **子窗口：** 点 ⚙️ 弹出 900×680 独立浏览器窗口，状态/子agent/后台/规则/技能 5 tab
- **主题：** 纯黑 `#000`，极简暗色，Inter 字体

### 9.4 Web UI 前端文件

```
webui/frontend/src/
├── main.tsx                          # 入口
├── App.tsx                           # 路由 + WS 连接
├── lib/
│   ├── api.ts                       # API 调用（fetch/WS/SSE）
│   └── store.ts                     # Zustand 状态管理
├── components/
│   ├── Sidebar.tsx                   # 侧栏（topic 列表 + 搜索）
│   ├── ChatPanel.tsx                 # 聊天面板（消息流 + 输入）
│   ├── TopicsPanel.tsx               # 子 agent 表格
│   ├── BgTasksPanel.tsx             # 后台任务表格
│   ├── RulesPanel.tsx               # 规则表格
│   └── SkillsPanel.tsx              # 技能表格
├── pages/
│   └── AdminPage.tsx                # 管理子窗口页面
└── styles/
    └── global.css                   # 全局样式 (~11KB)
```

### 9.5 Topic 系统

Topic 是 yu-agent 的项目工作区。每个 topic 有自己的：
- 独立目录（`dir`）
- 终端 session
- 文件树 + git 历史
- 后台任务（通过 supervisor 管理）
- 事件通道（`events` 表）

**Topic 字段：**
`id`, `name`, `dir`, `summary`, `status`（idle/active/background/spawning/spawn_failed/restarting/degraded）, `turns`, `lastActive`, `createdAt`, `archived`, `pid`, `cmd`, `startedAt`

**CLI 管理：**
```bash
yu topic list [-a]           # 列出 topic（含归档）
yu topic new <name> <dir>    # 创建 topic
yu topic switch <name>       # 切换活跃 topic
yu topic rename <old> <new>  # 重命名
yu topic archive <name>      # 归档
yu topic bg <name> <prompt>  # 启动后台任务
yu topic status              # 查看后台任务状态
yu topic events [name]       # 查看事件
```

---

## 十、工具与集成

### 10.1 内置工具

每个 agent type 控制可用工具权限（通过 `builtinToolNames` + `mcpServers` 白名单）：

| Agent Type | 内置工具 | MCP 工具来源 | Skills |
|-----------|---------|-------------|--------|
| coding | bash, read, edit, write, grep, find, ls | codegraph | — |
| review | read, grep, find, ls | codegraph | — |
| plan | read, grep, find, ls, write | codegraph | — |
| lsp | bash | — | — |
| commit | bash | — | — |
| doc | read, edit | codegraph | — |
| search | bash, read, grep | codegraph | — |
| chat | read, grep, find, bash | — | character-rp |
| general-purpose | — | — | — |

### 10.2 MCP 集成

- 配置：`~/.yu/mcp.config.json`（可选）
- 协议：stdio JSON-RPC
- 生命周期：启动时验证配置 → spawn 子进程 → initialize → tools/list → 心跳 (10s)
- 安全：env 值正则校验，屏蔽危险环境变量
- 无配置文件时跳过，不报错
- **按 agent type 绑定：** 每个 type 在 `AGENT_TYPES` 中配 `mcpServers` 白名单（如 `coding` 配 `codegraph`），只有配了的 type 能在对话中看到对应的 MCP 工具。工具注册由 `registerMcpTools()` 在 bootstrap 第 6 步完成。

### 10.3 LSP 集成

- 自动检测项目类型：tsconfig.json → typescript-language-server, pyproject.toml → pyright, go.mod → gopls, Cargo.toml → rust-analyzer
- 完整生命周期：start → initialize → didOpen → 收集 diagnostics → shutdown
- 最大 2 轮修复循环
- 心跳检测 15s

### 10.4 终端集成

- 基于 Bun.spawn 的 PTY 终端
- 按 topic 隔离 session
- /term-ws WebSocket 终端
- 支持 SSH 连接

### 10.5 记忆系统

三层架构：
- **Ring Memory：** SQLite 环状缓冲区（1000 条上限，自动淘汰最旧）
- **Vector Memory：** ChromaDB 语义检索（all-MiniLM-L6-v2 本地 embedding）
- **Facts Store：** JSON 文件（结构化长期事实，支持 TTL）

### 10.6 知识库 RAG

- 引擎：SQLite FTS5 全文检索
- 零依赖，轻量
- 限制：不支持 embedding 语义检索

### 10.7 沙箱执行

- Docker 容器隔离（默认镜像 `node:24-slim`）
- 本地执行回退（Docker 不可用时）
- 超时 60s，内存 512MB

### 10.8 Skills 技能系统

Skills 是注入 agent system prompt 的可复用模块，位于 `~/.yu/skills/` 目录：

- **加载：** `loadSkills()`（bootstrap 第 5 步）扫描该目录下所有 `.ts` 文件，按 `SkillDef` 接口解析
- **绑定：** 每个 agent type 通过 `skillNames` 列表指定需要的 skill（如 `chat` → `character-rp`）
- **注入：** agent-loop 启动时读取匹配的技能，将对应的 `systemPrompt` 拼接到 agent 的 system prompt 中
- **示例：** `~/.yu/skills/character-rp.ts` 为 chat agent 注入予鱼角色扮演规则

---

## 十一、资源限制与配置

### 11.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `YU_SESSION_ID` | auto | Session 标识 |
| `YU_PROJECT_DIR` | `cwd()` | 项目目录 |
| `YU_NAME_CAPTURED` | — | 首次 prompt 捕获标记 |
| `PI_PROVIDER` | Pi 配置 | API 提供商覆盖 |

### 11.2 关键限制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `MAX_CONCURRENCY` | 4 | 最大并行子 agent |
| `AGENT_TIMEOUT_MS` | 120,000 | 每个 agent 超时 |
| `MAX_TURNS_PER_SESSION` | 300 | Session 自动重置阈值 |
| `MAX_TOKENS_PER_SESSION` | 900,000 | Token 自动重置阈值 |
| `CONTEXT_COMPRESSION_THRESHOLD` | 75% | 触发上下文压缩 |
| `RESULT_CAP_TOKENS` | 3,000 | 工具输出截断阈值 |
| `MAX_DECISIONS` | 50 | 调度器决策缓存上限 |
| `MAX_RETRY_LSP` | 2 | LSP 最大修复轮数 |

### 11.3 数据目录（~/.yu/）

```
~/.yu/
├── config.json              # 应用配置（可选）
├── mcp.config.json          # MCP 服务器定义
├── sessions.db              # SQLite session 数据库
├── knowledge.db             # FTS5 知识索引
├── prompts/                 # Agent system prompt 文件
├── pool-sessions/           # 磁盘持久化 SessionPool
├── checkpoints/             # 阶段恢复检查点
├── data/
│   ├── decisions.json       # 调度器决策缓存（最多 50 条）
│   └── temp/                # Team mode 临时目录
├── runtime/{runId}/         # Team mode 运行时数据
│   ├── state.json           # 状态机
│   ├── plan.md              # Architect 输出
│   ├── context.md           # Searcher 输出
│   └── inboxes/{member}/    # Mailbox 系统
└── teams/{name}/            # 团队规格保存
```

---

## 十二、健康度与测试

### 12.1 当前健康度（SELF_REVIEW v2）

| 指标 | 数值 | 评级 |
|------|------|------|
| 源文件 | 79 个 (含 webui) | — |
| 测试文件 | 29 个 | — |
| 测试数量 | 612 | ✅ |
| 测试通过率 | 100% | ✅ |
| 构建时间 | 190 模块 / 330ms | ✅ |
| 构建产物 | ~10MB 单文件 | ✅ |
| typecheck | 零错误 | ✅ |
| `node:*` 前缀 | 0 处 | ✅ |
| `child_process` 运行时调用 | 0 处 | ✅ 全部 Worker/Bun.spawn |
| `any` 类型 | 0 处 | ✅ 已清零 |
| `@ts-ignore` | 0 处 | ✅ |
| TODO/FIXME/HACK | 0 处 | ✅ |

### 12.2 诊断命令

```bash
yu doctor  # 一键检查：
           # 1. 数据目录 ~/.yu/ 存在且可读
           # 2. MCP 配置有效 JSON + Zod schema
           # 3. Prompt 目录 ≥ 8 个文件
           # 4. Ring buffer SQLite 可访问
           # 5. Facts store JSON 可读
           # 6. Scene state JSON 可读
           # 7. Session DB SQLite 可访问
           # 8. Checkpoint 状态检查
```

---

## 十三、灵感来源

| 功能 | 来源 | yu-agent 差异 |
|------|------|--------------|
| **Team Mode** | OMO Sisyphus 编排器 | 简化为 4 角色 4 阶段，纯 DeepSeek |
| **调度器+分类** | OMO Sisyphus + Prometheus | 分类执行合一，减少来回开销 |
| **子 agent 生命周期** | pi-subagents | 加 SessionPool + Three-Region cache |
| **Pi 扩展框架** | Pi Coding Agent | 深度嵌入 beforeChat hook |
| **Three-Region 缓存** | DeepSeek Reasonix | Immutable/Append-Only/Volatile 三层 |
| **Session 管理** | OpenCode SessionManager | 只存元数据，历史由 Pi 管理 |
| **LSP 诊断** | OMO + Claude Code | 独立 LSP agent，4 语言支持 |
| **Checkpoint** | OpenCode + OMO | 覆盖 agent_spawn/lsp_verify/commit 三阶段 |
| **知识库 RAG** | OMO Librarian | SQLite FTS5 零依赖 |
| **AST 重构** | Biome | 直接调用 CLI，不做额外封装 |

---

> **参见：** 各独立文件保留不变
> - 详细架构图 → `ARCHITECTURE.md`
> - 配置全参考 → `CONFIGURATION.md`
> - 快速入门 → `QUICKSTART.md`
> - 健康报告 → `SELF_REVIEW.md`
> - Web UI 差距分析 → `webui-gap-analysis.md`
