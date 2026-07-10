# yu-agent Architecture

> **Version 0.3.1** — DeepSeek-native sub-agent dispatcher
>
> Pi 底座已完全移除 (2026-06)。现在运行时完全独立，入口统一为 `bin/yu.ts` → `bootstrap.ts` → `classifier.ts` / `scheduler.ts`。

---

## 当前运行时路径

```
用户输入 (CLI / Web UI)
    │
    ▼
bin/yu.ts — CLI 入口 (解析子命令, 调用 bootstrap)
    │
    ▼
bootstrap.ts — 统一启动初始化
    │
    ├── injectApiKeys()    — 从 ~/.yu/config.json 注入 API key 到 env
    ├── validateAll()      — 校验 MCP config + env vars
    ├── registerTypes()    — 注册 agent type 定义 (9 types)
    ├── startMCP()         — 启动 MCP server manager (后台)
    ├── loadSkills()       — 扫描并缓存 ~/.yu/skills/ 下的技能
    ├── registerMcpTools() — 从 MCP server 注册工具到 ToolRegistry
    └── registerHooks()    — 注册 scheduler 输入钩子
    │
    ▼
classifier.ts — 意图分类 (fast path + LLM fallback)
    │
    ▼
scheduler.ts — 执行计划 (executePlan)
    │
    ├── pass_through → direct API (简单对话)
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

**核心差异：**
- 无 Pi SessionPool → 每次 spawn 新建 `runAgent()` 调用
- 工具全部原生实现 (`tools/registry.ts` 统一注册)
- 上下文管理自有 (`context-manager.ts`)
- AgentLoop 自带 tool retry、goal condition、token budget 检查
- MCP 工具按 agent type 绑定 (`config.ts` 中 mcpServers 字段)
- Skills 系统支持三作用域加载 (全局/用户/项目)
- 构建: `bun build` → 单文件 `dist/yu.js`
- 测试: `bun test`

---

## Module Dependency Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                        bin/yu.ts (CLI entry)                     │
│         ┌────────────┬───────────┬──────────┬───────────┐       │
│         │ yu <prompt>│ yu doctor │ yu team  │ yu session│       │
│         │ yu review  │ yu git   │ yu sandbox│ yu ui    │       │
│         └─────┬──────┴─────┬─────┴────┬─────┴─────┬─────┘       │
│               │            │          │           │             │
│               ▼            ▼          ▼           ▼             │
│         bootstrap() — unified startup entry                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    extension/ (core modules)                     │
│                                                                  │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────┐     │
│  │ config.ts     │  │ mcp-manager.ts │  │ monitor.ts      │     │
│  │ • register    │  │ • MCP server   │  │ • TUI widget    │     │
│  │   agent types │  │   lifecycle    │  │ • Poll SQLite   │     │
│  │ • validate    │  │ • Heartbeat    │  │ • Render status │     │
│  │   MCP config  │  │ • Security     │  │   panel in TUI  │     │
│  └───────┬───────┘  │   validation   │  └────────┬────────┘     │
│          │           └────────────────┘           │              │
│          ▼                                        │              │
│  ┌──────────────────────────────┐                 │              │
│  │      scheduler.ts            │                 │              │
│  │  Scheduler orchestration      │                 │              │
│  │                              │                 │              │
│  │  1. classifyIntent()         │                 │              │
│  │  2. Parse JSON plan          │────────────────►│              │
│  │  3. Execute parallel groups  │     writes      │              │
│  │  4. Diff review              │     status      │              │
│  │  5. LSP verification         │     to SQLite   │              │
│  │  6. Test runner              │                 │              │
│  │  7. Decision persistence     │                 │              │
│  └──┬───────┬───────┬───────┬───┘                 │              │
│     │       │       │       │                     │              │
│     ▼       ▼       ▼       ▼                     │              │
│  ┌────┐ ┌────┐ ┌────┐ ┌────────┐                  │              │
│  │class│ │exec│ │veri│ │tracker │                  │              │
│  │ifier│ │utor│ │fier│ │.ts     │                  │              │
│  │.ts  │ │.ts │ │.ts │ │        │                  │              │
│  └──┬──┘ └──┬──┘ └──┬─┘ └───┬───┘                 │              │
│     │       │       │        │                     │              │
│     ▼       ▼       ▼        ▼                     │              │
│  ┌──────────────────────────────────────┐          │              │
│  │           spawn.ts (SessionPool)      │          │              │
│  │                                       │          │              │
│  │  Cache-First Three-Region Model:      │          │              │
│  │  ┌──────────┐ ┌──────────┐ ┌───────┐  │          │              │
│  │  │Immutable │ │Append-  │ │Volatile│  │          │              │
│  │  │Prefix    │ │Only Log │ │Scratch │  │          │              │
│  │  └──────────┘ └──────────┘ └───────┘  │          │              │
│  │                                       │          │              │
│  │  getSessionPool(type) → SessionPool   │          │              │
│  │  pool.call() → SpawnResult            │          │              │
│  │  pool.callIsolated() → SpawnResult    │          │              │
│  └───────────────────────────────────────┘          │              │
│                                                     │              │
│  ┌───────────────────────────────────────┐          │              │
│  │           db.ts (SQLite IPC)          │          │              │
│  │                                       │          │              │
│  │  Tables: sessions, agents, mcp, lsp,  │          │              │
│  │  team, summary, cache, messages,      │◄─────────┤              │
│  │  todos, knowledge_fts                 │  read    │              │
│  │                                       │  write    │              │
│  │  ops: upsertSession, insertMessage,   │          │              │
│  │  getAgents, getCache, ...             │          │              │
│  └───────────────────────────────────────┘          │              │
│                                                     │              │
└─────────────────────────────────────────────────────┴──────────────┘
                              │
        ┌─────────┬───────────┼───────────┬──────────┐
        ▼         ▼           ▼           ▼          ▼
┌───────────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ team/     │ │lsp-  │ │mcp-      │ │knowledge/│ │sandbox/  │
│           │ │mana- │ │mana-     │ │          │ │          │
│ orchestr  │ │ger   │ │ger       │ │FTS5 RAG  │ │Docker    │
│ ator.ts   │ │.ts   │ │.ts       │ │index.ts  │ │index.ts  │
│           │ │      │ │          │ │          │ │          │
│ 4-phase   │ │LSP   │ │MCP       │ │Project   │ │Sandbox   │
│ team      │ │3.17  │ │stdio     │ │file      │ │execution │
│ workflow  │ │diag- │ │JSON-RPC  │ │indexing  │ │(Docker/  │
│           │ │nostic│ │lifecycle │ │          │ │local)    │
└───────────┘ └──────┘ └──────────┘ └──────────┘ └──────────┘

┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ memory/  │ │terminal/ │ │refactor/ │ │check-   │ │git-      │
│          │ │          │ │          │ │point.ts │ │commands  │
│ Ring     │ │PTY       │ │TypeScript│ │          │ │.ts       │
│ buffer   │ │attach    │ │AST       │ │Phase-   │ │          │
│ Facts    │ │read-only │ │refactor  │ │level    │ │gh CLI    │
│ Scene    │ │/proc     │ │rename/   │ │recovery │ │PR/branch │
│ state    │ │Linux     │ │extract   │ │          │ │/merge    │
└──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘

┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ session- │ │session-  │ │session-  │ │session-  │
│ store.ts │ │cmd.ts    │ │context   │ │cli.ts    │
│          │ │          │ │.ts       │ │          │
│ Message  │ │/session  │ │YU_SES-   │ │Session   │
│ persist  │ │command   │ │SION_ID   │ │list/show │
│          │ │handler   │ │env mgmt  │ │/resume/  │
└──────────┘ └──────────┘ └──────────┘ │clean     │
                                        │/backup   │
┌──────────┐ ┌──────────┐ ┌──────────┐ └──────────┘
│ identity │ │resumer   │ │ memory   │
│ .ts      │ │.ts       │ │ -plugin  │
│          │ │          │ │ .ts      │
│ Persona  │ │Session   │ │          │
│ lity     │ │resume    │ │Lifecycle │
│ inject   │ │context   │ │hooks     │
└──────────┘ └──────────┘ └──────────┘
```

---

## Data Flow

### Complete Request Pipeline

```
┌──────────────┐
│  User Input  │
│  "fix login  │
│   bug"       │
└──────┬───────┘
       │
       ▼
┌────────────────────────────────────────────────┐
│  classifyIntent() — extension/classifier.ts    │
│                                                 │
│  Spawn scheduler agent (general-purpose type):  │
│  • model: v4-flash, thinking: max, maxTurns: 3 │
│  • Prompt: prompts/scheduler.md                 │
│  • Output: JSON plan (SchedulerPlan)            │
│                                                 │
│  Fast-path: if input >200 chars or role-play    │
│  → pass_through: true (skip scheduler)          │
│                                                 │
│  On parse failure: retry 0 times (configurable),│
│  fallback to pass_through                       │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  Scheduler Plan Parsing                         │
│  extension/template.ts::parseSchedulerOutput() │
│                                                 │
│  Steps:                                         │
│  1. Extract JSON from markdown code block       │
│  2. Strip JS comments (// /* */)               │
│  3. Normalize: single quotes → double,          │
│     True/None → true/null, unquoted keys→quoted │
│  4. Remove trailing commas, close unmatched     │
│     braces/brackets                             │
│  5. JSON.parse → SchedulerOutput                │
└──────────────────┬─────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
  ┌────────────┐     ┌────────────────┐
  │ pass_through │     │ Programming     │
  │ = true      │     │ (plan.intent    │
  │             │     │  exists)        │
  │ Return null │     │                 │
  │ → direct    │     │ Continue to     │
  │   API       │     │ execution       │
  └────────────┘     └────────┬─────────┘
                              │
                              ▼
┌────────────────────────────────────────────────┐
│  Plan Interpretation                            │
│                                                 │
│  plan = {                                       │
│    intent: "fix",                               │
│    agents: [                                    │
│      {type:"coding",model:"v4-flash",id:"c-1"} │
│    ],                                           │
│    parallel_groups: [["c-1"]],                  │
│    dependencies: {}                             │
│  }                                              │
│                                                 │
│  • Build agentMap from plan.agents              │
│  • Load decisions from decisions.json           │
│  • Inject knowledge context (RAG) if available  │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  Parallel Group Execution                       │
│  extension/executor.ts::runParallelGroup()     │
│                                                 │
│  For each group in plan.parallel_groups:        │
│  ┌───────────────────────────────────────────┐  │
│  │  runWithConcurrencyLimit(tasks, 4)        │  │
│  │                                           │  │
│  │  For each agent in group (parallel):      │  │
│  │  1. checkpointGuard('agent_spawn')        │  │
│  │  2. trackAgent(id, 'running')             │  │
│  │  3. spawnAgentWithTimeout(config)         │  │
│  │     → spawn.ts::spawnAgent()              │  │
│  │  4. trackAgent(id, 'completed'|'failed')  │  │
│  │  5. Collect results in Map<id, Result>    │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  Concurrency limit: 4 (MAX_CONCURRENCY)         │
│  Per-agent timeout: 120s (AGENT_TIMEOUT_MS)     │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  spawnAgent() — extension/spawn.ts             │
│                                                 │
│  1. Get or create SessionPool for agent type   │
│     (type-isolated, disk-persisted sessions)    │
│                                                 │
│  2. If teamRunId + memberName:                  │
│     → TeamSession.call()                        │
│        (polls mailbox, injects peer messages)   │
│                                                 │
│  3. If isolated:                                 │
│     → pool.callIsolated()                       │
│        (temporary session, no cache pollution)  │
│                                                 │
│  4. pool.call(task, config):                     │
│     → Serialize via mutex (one call at a time)  │
│     → Context compression if >75% usage         │
│     → Reset if >300 turns or >900k tokens       │
│     → Append agent prefix to user message       │
│       (never modify immutable prefix)           │
│     → _promptWithTimeout(session, task, timeout)│
│     → Extract assistant response                │
│     → Turn-end compaction of tool results       │
│       (truncate >3000 token results)            │
│     → Return SpawnResult with cache stats       │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  Collect Modified Files & Diff Review           │
│                                                 │
│  For each agent result:                         │
│  • parseAgentOutput(response) → CodingOutput    │
│  • Extract files_modified from each result      │
│                                                 │
│  reviewDiff() — git diff --stat + git diff      │
│  printDiffSummary() — log changes to console    │
│                                                 │
│  confirmDiff() — Interactive user approval      │
│  • prompt "Apply these changes? (y/N)"          │
│  • timeout: 60s, default: reject               │
│  • On reject: `git checkout -- .` to revert    │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  LSP Verification                               │
│  extension/verifier.ts::verifyWithLsp()        │
│                                                 │
│  1. findProjectRoot(files) — walk up for        │
│     package.json / pyproject.toml / ...         │
│                                                 │
│  2. detectLspServer(root):                       │
│     tsconfig.json → typescript-language-server  │
│     pyproject.toml → pyright-langserver         │
│     go.mod → gopls                              │
│     Cargo.toml → rust-analyzer                  │
│                                                 │
│  3. Start LspManager → spawn LSP server         │
│     → Initialize + didOpen for each file        │
│     → Collect publishDiagnostics                │
│                                                 │
│  4. If errors: spawn coding agent to fix        │
│     (up to 2 rounds, pass previous errors)      │
│                                                 │
│  5. Stop LspManager → shutdown + exit           │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  Test Runner                                   │
│  extension/verifier.ts::runTests()              │
│                                                 │
│  Auto-detect framework at project root:         │
│  ┌─────────────────────────────────────────┐    │
│  │ package.json → vitest/jest/mocha        │    │
│  │ pyproject.toml → pytest (poetry/uv/pip)  │    │
│  │ requirements.txt → pytest               │    │
│  │ No detection → skip with warning        │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  If tests fail: spawn coding agent to fix       │
│  (up to 2 rounds) — same pattern as LSP         │
│                                                 │
│  Skip tests if LSP has unresolved errors        │
│  (tests would likely fail anyway)               │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  Decision Persistence                           │
│  extension/tracker.ts::saveDecision()           │
│                                                 │
│  Write decisions.json (most recent 50 entries)  │
│  Key: timestamp-intent                          │
│  Value: { intent, agents, files }               │
│                                                 │
│  Used by scheduler to avoid redundant           │
│  LLM calls for similar requests in same session │
└────────────────────────────────────────────────┘
```

---

## Session Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│  Session Lifecycle (per SessionPool)                             │
│                                                                  │
│  session_start                                                   │
│       │                                                          │
│       ▼                                                          │
│  setSessionTag(id) — Set YU_SESSION_ID env var                  │
│       │                                                          │
│       ▼                                                          │
│  setSessionAgent(agent) — Record agent type                     │
│  setSessionModel(model) — Record model info                     │
│  setSessionParent(tag) — Record parent session tag               │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  pool.init(options)                                      │     │
│  │  • Create AgentSession with SessionPool                      │     │
│  │  • IMMUTABLE PREFIX: system prompt + tools + schemas    │     │
│  │  • Disk persistence: SessionManager.continueRecent()    │     │
│  │  • Reload DefaultResourceLoader                         │     │
│  └─────────────────────────────────────────────────────────┘     │
│       │                                                          │
│       ▼                                                          │
│  loop: for each user turn                                       │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  pool.call(task, config)                                 │     │
│  │                                                           │     │
│  │  1. Acquire serialization mutex                           │     │
│  │     (prevents concurrent writes to same session)          │     │
│  │                                                           │     │
│  │  2. Context compression check                              │     │
│  │     If usage > 75% of context window →                    │     │
│  │     session.compact('keep key context...')                │     │
│  │                                                           │     │
│  │  3. Session reset check                                   │     │
│  │     If turnCount >= 300 OR totalTokens >= 900k →         │     │
│  │     pool.dispose() → pool.init(options)                   │     │
│  │                                                           │     │
│  │  4. Build full task: agentPrefix + userInput + suffix     │     │
│  │     (APPEND-ONLY LOG: only append, never modify)          │     │
│  │                                                           │     │
│  │  5. _promptWithTimeout(session, task, timeout)            │     │
│  │     → session.prompt()                                    │     │
│  │     → Timeout guard: abort + reject after timeout_ms      │     │
│  │                                                           │     │
│  │  6. Extract assistant response from new messages          │     │
│  │     → Cache stats (cacheRead, input, output, cost)        │     │
│  │                                                           │     │
│  │  7. Turn-end compaction                                    │     │
│  │     compactResult(response, 3000 tokens)                   │     │
│  │     → Truncate long tool output: head + tail + watermark  │     │
│  │     (VOLATILE SCRATCH: tool results don't inflate cache)  │     │
│  │                                                           │     │
│  │  8. Update pool stats: turnCount++, totalTokensUsed       │     │
│  └─────────────────────────────────────────────────────────┘     │
│       │                                                          │
│       ▼                                                          │
│  session_shutdown                                                │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  pool.dispose()                                          │     │
│  │  • Dispose AgentSession                                  │     │
│  │  • Flush summary + cache stats to SQLite                 │     │
│  │  • Clear in-memory turn count and token tracking         │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  On process restart:                                             │
│  SessionManager.continueRecent() → Resume from disk              │
│  → API layer cache still hot (prefix cache from disk replay)    │
└──────────────────────────────────────────────────────────────────┘
```

### Team Session Lifecycle (TeamSession)

For team-aware spawns, the `TeamSession` wrapper adds mailbox polling on top of the standard `SessionPool.call()`:

```
TeamSession.call(originalCall)
   │
   ├── 1. pollAndInject(teamRunId, memberName, turnKey)
   │       → Read inbox files from ~/.yu/runtime/{runId}/inboxes/{member}/
   │       → Sort by timestamp
   │       → Build <peer_message> XML for prompt injection
   │       → Return injected content + unclaimed message IDs
   │
   ├── 2. Prepend injected content to task (if any)
   │
   ├── 3. Execute originalCall() → pool.call(task, config)
   │
   ├── 4. ackMessages() — Move processed messages to processed/
   │
   └── 5. Return SpawnResult with injectedMessages metadata
```

---

## Key Design Decisions

### 1. Cache-First Three-Region Model

Inspired by [Reasonix](https://reasonix.ai/), the session context is divided into three regions to maximize API-level prefix caching:

| Region | Content | Mutability | Cache Behavior |
|--------|---------|------------|----------------|
| **Immutable Prefix** | System prompt + tool definitions + tool schemas | Written once at session creation, never modified | Perfect cache hit — identical prefix across all calls |
| **Append-Only Log** | User messages (agent prefix + task) + assistant responses | Monotonic append only — no insertion, no modification | Predictable cache — each new turn appends to the log, previous content remains cached |
| **Volatile Scratch** | Tool call results (large stdout, file contents, search results) | Auto-compacted at turn end — truncated to 3000 tokens | Does not participate in prefix caching — scrubbed before next API call |

**Why this matters:** DeepSeek API pricing has a 10× difference between cache hit and cache miss rates. By keeping the prefix immutable and the log append-only, every call after the first reuses the cached prefix at the reduced rate.

**Implementation:**
- All session pools share the same tool set (`UNIFIED_TOOLS`) — the system prompt is identical across all types, enabling cross-type cache hits.
- Per-type behavior is injected via `appendSystemPromptOverride()` (a per-session customization that is part of the immutable prefix).
- Session persistence to disk (`pool-sessions/`) enables cache replay across process restarts — the API provider can reconstruct the prefix cache without re-encoding.

### 2. Type-Isolated Sessions

Each agent type (`coding`, `review`, `plan`, etc.) gets its own `SessionPool` instance with a separate disk-persisted session:

```
globalPools = Map<string, SessionPool>
  "coding"       → SessionPool (persist: ~/.yu/pool-sessions/coding/)
  "review"       → SessionPool (persist: ~/.yu/pool-sessions/review/)
  "plan"         → SessionPool (persist: ~/.yu/pool-sessions/plan/)
  "search"       → SessionPool (persist: ~/.yu/pool-sessions/search/)
  "lsp"          → SessionPool (persist: ~/.yu/pool-sessions/lsp/)
  "commit"       → SessionPool (persist: ~/.yu/pool-sessions/commit/)
  "doc"          → SessionPool (persist: ~/.yu/pool-sessions/doc/)
  "chat"         → SessionPool (persist: ~/.yu/pool-sessions/chat/)
  "general-purpose" → SessionPool (persist: ~/.yu/pool-sessions/general-purpose/)
```

**Rationale:**
- Each type has a distinct system prompt + behavior pattern. Isolating sessions prevents cross-type context pollution.
- The immutable prefix (tools + tool schemas) is identical across all pools, maximizing cross-type cache hits at the API layer.
- Serialization mutex per pool ensures type-level concurrent access safety without global locking.

### 3. SQLite IPC for Cross-Process Communication

Instead of JSON files, yu-agent uses **SQLite** (`bun:sqlite` Database) as the IPC mechanism between the scheduler process and external monitoring/CLI processes.

**Tables:**
| Table | Purpose | Written By | Read By |
|-------|---------|------------|---------|
| `sessions` | Session metadata (tag, cwd, agent, model, parent) | `session-store.ts` | `session-cli.ts`, `monitor.ts` |
| `agents` | Sub-agent statuses (id, type, status, duration) | `status.ts` | `monitor.ts`, `session-cli.ts` |
| `mcp` | MCP server connection states | `status.ts` | `monitor.ts` |
| `lsp` | LSP server states | `status.ts` | `monitor.ts` |
| `team` | Team mode runtime state | `status.ts` | `monitor.ts` |
| `summary` | Aggregated counts (running, completed, failed) | `status.ts` | `monitor.ts` |
| `cache` | Cache hit/miss stats | `status.ts` | `monitor.ts`, `bin/yu.ts` |
| `messages` | Conversation history (session_id, role, content) | `session-store.ts` | `session-cli.ts` |
| `todos` | Per-session task list | `session-cli.ts` | `session-cli.ts` |
| `knowledge_fts` | FTS5 full-text index of project files | `knowledge/index.ts` | `knowledge/index.ts` |

**Why SQLite:**
- Zero external dependencies (built into Node 24).
- ACID guarantees for concurrent readers.
- FTS5 for RAG knowledge search without external search services.
- Single file for easy backup/restore (`yu session backup/restore`).
- Schema-enforced type safety vs. ad-hoc JSON files.

### 4. JSON Repair Pipeline

LLM output is notoriously unreliable for structured formats. yu-agent implements a multi-stage repair pipeline in `template.ts`:

```
Input (raw LLM text) →
  1. Extract JSON from markdown code block (```json ... ```)
  2. Strip JS-style comments (// /* */)
  3. Normalize: single quotes → double quotes
  4. Fix Python literals: True/False/None → true/false/null
  5. Quote unquoted keys: {key: value} → {"key": value}
  6. Remove trailing commas in arrays/objects
  7. Close unmatched braces and brackets
  → JSON.parse
```

This pipeline handles ~95% of common LLM JSON formatting errors without requiring API retries.

### 5. Checkpoint Recovery

Phase-level checkpoints are saved before each critical step, enabling recovery from interrupted workflows:

| Checkpoint Step | Saved Before | Recovery Action |
|----------------|--------------|-----------------|
| `agent_spawn` | Spawning a sub-agent | Resume from last completed agent |
| `lsp_verify` | LSP diagnosis | Re-run LSP on modified files |
| `commit` | Writing decisions.json | Verify decisions file integrity |

Checkpoints are stored in `~/.yu/checkpoints/<timestamp>-<step>.json`. Stale checkpoints (>24h) are automatically skipped. The `yu doctor` command lists pending checkpoints for user attention.

### 6. Model Routing Logic

See CONFIGURATION.md for the full model routing conditions table.

### 7. MCP Per-Agent-Type Binding

Tools from MCP servers are not globally available — each agent type declares which MCP servers it needs via the `mcpServers` field in `config.ts`:

```ts
coding: {
  builtinToolNames: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'],
  mcpServers: ['codegraph'],   // only codegraph tools for coding agent
  ...
}
```

**Implementation:**
- `tools/registry.ts::listToolsByType(builtinToolNames, mcpServers)` filters the global tool registry by both built-in tool names and MCP server sources.
- `tools/mcp-tools.ts` handles MCP protocol init, tool list caching, and dynamic registration to the ToolRegistry.
- Per-server refresh interval: 30s. Failed servers are skipped per-agent without blocking other agents.

**Rationale:** Prevents context pollution from irrelevant MCP tools and keeps the per-agent system prompt focused.

### 8. Skills System

Skills are reusable, externally-loadable prompt + tool bundles scoped to three directories:

| Scope | Path | Priority |
|-------|------|----------|
| Global | `/etc/yu/skills/` | Lowest |
| User | `~/.yu/skills/` | Medium |
| Project | `.yu/skills/` (cwd) | Highest |

**Load order:** Project overrides User, User overrides Global (same-name skills are replaced).

**Implementation:**
- `skills/registry.ts` scans all three scope directories (glob `*.ts`), imports each module, and extracts `SkillDef` or `LoadedSkill` exports.
- Mtime-aware caching prevents re-importing unchanged files.
- Agent types reference skills via `skillNames: ['character-rp']` in `config.ts`.
- Skills are loaded at startup by `bootstrap.ts::loadSkills()` and injected into the agent's system prompt by `agent-loop.ts::loadSkillsByName()`.

### 9. AgentLoop runAgent()

The `AgentLoop` class in `agent-loop.ts` is the universal agent execution engine, providing a self-contained replacement for the old `session.prompt()` pattern:

```
runAgent(task, config?) → AgentLoopResult

1. Initialize ContextManager (message history + tool registry)
2. Load agent type config (system prompt, tools, MCP servers, skills)
3. Loop:
   a. Call LLM API (chatCompletion with tool definitions)
   b. Parse tool_calls from response
   c. Execute each tool via tools/registry.ts::executeTool()
   d. On 'stop' finish reason: check stop condition (goal met / min turns)
   e. On 'tool_use': collect results, continue loop
4. Return result with token usage stats
```

**Key features:**
- **Goal condition:** Optional async evaluator that checks if the task is complete after each turn.
- **Token budget:** Hard limit on total tokens consumed; agent exits gracefully on budget exceeded.
- **Checkpoint injection:** Every 5 turns, inject a progress summary to prevent attention drift in long contexts.
- **Write reminder:** Injects a "use write/edit tools" reminder if the agent hasn't written any files by iteration 10.
- **Tool retry:** `executeTool()` includes internal retry for transient failures.
- **Event hooks:** `onEvent` callback for real-time monitoring (tool calls, results, goal checks).

---

## Error Handling & Failure Modes

### Sub-agent Crash Recovery

If a sub-agent process crashes or becomes unresponsive, the scheduler detects the missing agent via timeout or process exit code, marks it as `failed` in the status tracker, and continues executing remaining agents in the parallel group. No cascade failure — other agents in the same group proceed independently.

### LSP Server Failure

When an LSP server crashes or returns a protocol error, `mcp-manager.ts` marks the server as `error` in the SQLite status table and disconnects it. Other LSP servers and MCP connections continue unaffected. The scheduler falls back to running tests without LSP verification for affected files.

### JSON Parse Failure Recovery

If the scheduler agent's output cannot be parsed as a valid `SchedulerPlan` JSON, the 7-step repair pipeline in `template.ts` attempts to fix common LLM formatting errors (missing quotes, trailing commas, unclosed braces). If repair fails after all steps, the system falls back to `pass_through: true` — the original request is sent directly to the LLM API without scheduling.

### Timeout Handling

Each sub-agent has a configurable per-agent timeout (default: 120s, `AGENT_TIMEOUT_MS`). When the timeout fires:
  1. The agent's session prompt is aborted via `AbortController`.
  2. The agent is marked as `failed` in the status tracker.
  3. The error is logged with duration information.
  4. Execution continues with the next agent/group.

### Graceful Shutdown (Planned for Phase 4)

On `SIGTERM`/`SIGINT`, the scheduler will:
  1. Signal running agents to complete their current turn.
  2. Wait for in-flight agents with a grace period (configurable, default 30s).
  3. Save partial results and checkpoint state.
  4. Flush status data to SQLite.
  5. Exit cleanly.

Current behavior: processes exit immediately on signal, potentially losing in-flight agent results.

---

## Complete Module Reference

### Core Extension Modules (`extension/*.ts`)

| Module | File | Description |
|--------|------|-------------|
| **Bootstrap** | `bootstrap.ts` | Unified startup initialization. 7-step sequence: injectApiKeys → validateAll → registerTypes → startMCP → loadSkills → registerMcpTools → registerHooks. Independent of Pi. |
| **Config** | `config.ts` | Agent type definitions (9 types), MCP config validation (Zod), app config loading. |
| **Scheduler** | `scheduler.ts` | Scheduler orchestration handler. Intent classification → parallel execution → diff review → LSP → tests → decision persistence. |
| **Spawn** | `spawn.ts` | Cache-First SessionPool implementation. Type-isolated pools with disk persistence, context compression, turn-end compaction. |
| **Classifier** | `classifier.ts` | Intent classification via scheduler agent. Spawns `general-purpose` agent with `scheduler.md` prompt, returns `SchedulerPlan`. |
| **Executor** | `executor.ts` | Parallel group execution with concurrency limit (4). Diff review utilities (`reviewDiff`, `printDiffSummary`, `confirmDiff`). |
| **Verifier** | `verifier.ts` | LSP verification loop (LspManager → diagnose → fix → recheck, max 2 rounds). Test runner with auto-detection (vitest/jest/mocha/pytest). |
| **Template** | `template.ts` | LLM output JSON repair pipeline (extract → strip comments → normalize → parse). Validation per agent type schema. |
| **Tracker** | `tracker.ts` | In-memory agent status tracking + disk flush. Decision persistence to `decisions.json` (most recent 50). |
| **Status** | `status.ts` | TypeScript interfaces for status objects. SQLite write functions for agents/mcp/lsp/team/summary/cache tables. |
| **Paths** | `paths.ts` | Canonical path constants (`YU_HOME`, `PROMPTS_DIR`, `DATA_DIR`, `POOL_SESSIONS_DIR`, etc.). |
| **Types** | `types.ts` | Shared type definitions: memory interfaces (`IMemoryRing`, `IFactStore`, `ISceneManager`), hook context types. |
| **Checkpoint** | `checkpoint.ts` | Phase-level recovery checkpoints (save → complete → cleanup). `checkpointGuard()` for automatic `try/finally` management. |
| **LSP Manager** | `lsp-manager.ts` | LSP 3.17 server lifecycle: spawn → initialize → didOpen → publishDiagnostics → shutdown. Heartbeat interval: 15s. |
| **MCP Manager** | `mcp-manager.ts` | MCP stdio JSON-RPC server lifecycle: config validation → spawn → initialize → tools/list → heartbeat. Security: env var whitelist + blocked keys. |
| **AgentLoop** | `agent-loop.ts` | Core agent execution loop. LLM call → parse tool_calls → execute tools → continue → return result. Supports goal conditions, token budget, checkpoint injection. |
| **Tool Registry** | `tools/registry.ts` | Unified tool registration, discovery and execution. `registerTool()`, `listToolsByType()`, `executeTool()`, `getToolSchemas()`. MCP tool sub-registry. |
| **MCP Tools** | `tools/mcp-tools.ts` | MCP tool adapter. Protocol init handshake, tool list caching, dynamic registration to ToolRegistry. Per-server refresh interval: 30s. |
| **Skills Registry** | `skills/registry.ts` | Three-scope skill scanning (global/user/project). Mtime-aware caching. Async load with error isolation per file. |
| **Monitor** | `monitor.ts` | TUI monitor widget. Polls SQLite every 500ms. Shows agent status, MCP connections, cache stats. |
| **Session Store** | `session-store.ts` | Session metadata + message persistence. Captures first user prompt as session name. Saves user/assistant messages to SQLite. |
| **Resumer** | `resumer.ts` | Session resume context injection. Reads `resume_context.json` (written by `yu session resume`), injects historical messages as `<history>` XML. |
| **Session Cmd** | `session-cmd.ts` | `/session` command handler. Dispatches to `session-cli.ts`. |
| **Session CLI** | `session-cli.ts` | Full session management CLI: `list`, `show`, `resume`, `archive`, `unarchive`, `fork`, `todo`, `info`, `backup`, `restore`, `clean`. |
| **Session Context** | `session-context.ts` | Per-process session identity. `getSessionTag()` / `setSessionTag()`, project directory detection, status directory resolution. |
| **DB** | `db.ts` | SQLite database abstraction (800+ lines). 10 tables, all operations synchronous (`bun:sqlite` Database API). |

### Team Mode (`extension/team/`)

| Module | File | Description |
|--------|------|-------------|
| **Mailbox** | `mailbox.ts` | Filesystem async messaging. Atomic JSON file delivery via `sendMessage`, `listUnread`, `ackMessages`, `pollAndInject`. |
| **Tasklist** | `tasklist.ts` | Shared task board. Methods: `createTask`, `getTask`, `listTasks`, `updateTaskStatus`, `claimTask`. State machine with status transitions. |
| **Runtime** | `runtime.ts` | Team run lifecycle: `createTeamRun`, `getTeamStatus`, `requestShutdown`, `deleteTeamRun`. State transition matrix. |
| **Registry** | `registry.ts` | Team spec persistence: `saveTeamSpec`, `listTeamSpecs`, `buildInlineSpec`. |
| **Session** | `session.ts` | `TeamSession` — wraps SessionPool with mailbox polling + ack lifecycle for team-aware agent spawns. |
| **Integration** | `integration.ts` | (removed in v0.3.0 — previously Pi hook glue for team mode). |
| **Types** | `types.ts` | Zod schemas: `TeamSpec`, `Member`, `Message`, `Task`, `RuntimeState`. |
| **Index** | `index.ts` | Re-exports + `teamCommand()` CLI dispatcher. |

### Subsystem Modules

| Module | File | Description |
|--------|------|-------------|
| **Knowledge (RAG)** | `knowledge/index.ts` | SQLite FTS5 full-text search. Indexes `.md`, `.ts`, `.tsx` files. Extracts JSDoc/TSDoc comments. Zero external dependencies. |
| **Sandbox** | `sandbox/index.ts` | Isolated execution via Docker (`node:24-slim`) or local fallback. 512MB memory limit, 60s timeout. |
| **Terminal** | `terminal/index.ts` | PTY attach via `/proc` (Linux read-only). List processes, read stdout, live-tail. 300s auto-disconnect. |
| **Refactor** | `refactor/index.ts` | AST-aware TypeScript refactoring via TypeScript Compiler API. `renameSymbol`, `extractInterface`. Biome formatting. |
| **Git Commands** | `git-commands.ts` | `gh` CLI wrapper. `prCreate`, `prList`, `createBranch`, `mergeBranch` with conflict detection. |

### CLI Entry

| Module | File | Description |
|--------|------|-------------|
| **CLI** | `bin/yu.ts` | Standalone CLI entry. Dispatches subcommands, invokes `bootstrap()` startup, then routes to classifier/scheduler or direct subcommand handler. Includes cost estimation, health diagnosis, help system. |

---

## Data Directory Layout

See CONFIGURATION.md for the full data directory layout.

---

---

## Inspirations & Credits

yu-agent 继承了多个开源项目的思想和架构。以下汇总核心借鉴来源及与原始项目的差异对比。

### OMO / Oh My OpenAgent

> GitHub: [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)  
> Stars: 60k+ | 定位：OpenCode 的多 agent 编排插件

OMO 是 yu-agent 最大的灵感来源。以下逐项对比：

| 维度 | OMO | yu-agent |
|------|-----|----------|
| **Agent 数量** | 11 个专业 agent（Sisyphus/Hephaestus/Prometheus/Oracle/Librarian/Atlas 等） | 9 种 agent type（coding/review/plan/search/commit/lsp/doc/chat/general-purpose） |
| **编排器** | Sisyphus 独立 orchestrator agent | `classifier.ts` + `scheduler.ts` 合一的调度器 sub-agent |
| **Team mode** | 最多 8 个并行成员，tmux 实时可视化，文件系统 mailbox，12 个 team 工具 | 4 角色（Architect/Coder/Reviewer/Searcher），4 阶段管线，共享目录做上下文交换 |
| **模型路由** | 多 provider（Claude/GPT/Gemini/Grok）按角色配置 | 纯 DeepSeek（v4-pro 强模型 / v4-flash 快模型），按输入特征路由 |
| **生命周期钩子** | 54+ lifecycle hooks，覆盖几乎所有事件点 | ~15 个关键钩子（beforeChat / before_agent_start / turn_end / session_start） |
| **测试** | 无内置测试框架 | ~43 个测试用例（vitest），集成测试 mock LLM 注入 |
| **LSP 集成** | hook 级别的 LSP 事件 | 独立 LSP agent type，含心跳 + 2 轮修复循环，4 语言支持 |
| **Checkpoint** | ulw-loop 操作级 checkpoint | 3 阶段 checkpoint（spawn / lsp_verify / commit） |
| **记忆系统** | 无内置记忆 | ContextManager (context-manager.ts) 管理消息历史与压缩 |
| **日志** | 无结构化日志 | JSON Lines + SQLite 持久化，5 级日志 |

**yu-agent 的核心差异理念：** 更轻、更专注 DeepSeek 生态、无多余抽象。OMO 追求"全功能编排平台"，yu-agent 追求"DS 定制化编程助手"——调度器即 agent，不引入独立编排服务。

### Pi (Historical)

> Pi: [earendil-works/pi](https://github.com/earendil-works/pi)  \
> pi-subagents: [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)

Pi 曾是 yu-agent 的原始运行底座 (removed 2026-06)。现在 yu-agent 完全独立运行：

- Pi 曾提供 `extension API`（beforeChat hook、斜杠命令、TUI widget）
- pi-subagents 曾提供 `SessionPool` 和 session 管理
- yu-agent 在其上叠加了调度器分类、Cache-First Three-Region 模型、context compression、per-type 并发上限
- v0.3.0+ 完全移除 Pi 依赖，AgentLoop + bootstrap 替代了所有 Pi 功能

### DeepSeek Reasonix / KV Cache

> [DeepSeek KV Cache 文档](https://api-docs.deepseek.com/guides/kv_cache)  
> [Reasonix 三段式缓存分析](https://devlery.com/en/blog/reasonix-deepseek-prefix-cache-agent)

DeepSeek 的 prefix cache 机制（相同前缀命中时成本降至 ~1%）直接启发了 yu-agent 的 SessionPool 设计。

**Three-Region 模型：**

| Region | 内容 | 缓存命中 | 更新频率 |
|--------|------|---------|---------|
| **Immutable Prefix** | system prompt + agent type config + 工具定义 | ✅ 100% 命中 | 从不更新 |
| **Append-Only Log** | 历史消息（按轮次追加） | ✅ 前缀连续命中 | 只追加不修改 |
| **Volatile Scratch** | 当前轮的 tool output / 临时消息 | ❌ 不缓存 | 每轮清空 |

yu-agent 的 SessionPool 在 disk 上持久化每个 session 的三层结构，下次同类型 task 复用前缀。

### OpenCode (Session 格式)

> [sst/opencode](https://github.com/sst/opencode)

OpenCode 的 `.jsonl` session 文件格式和 SessionManager API 是 yu-agent session resume 的参考来源。

- OpenCode 把完整消息树存为 `.jsonl`（含 branch/resume/compact）
- yu-agent 只存 session 元数据，对话消息由 SessionPool 管理
- Session resume 时从 SessionPool 的持久化 session 中提取最近 30 条消息注入上下文

### 其他

| 能力 | 来源 | 说明 |
|------|------|------|
| AST 重构 | [Biome](https://biomejs.dev) | renameSymbol / extractInterface 直接调 Biome CLI |
| 沙箱 | Docker 容器模式 | 通用模式，无直接参考项目 |
| Structured Output | OMO + Claude Code | 每种 agent type 独立 JSON schema，调度器严格校验 |

---

## SEE ALSO

- [CONFIGURATION.md](CONFIGURATION.md) — Configuration reference (env vars, config files, agent types, MCP)
- [README.md](README.md) — Quick start, agent types table, team mode overview, extension API
- [DESIGN.md](DESIGN.md) — Original design document (v7) with detailed prompt contents and historical context
