# yu-agent

> **DeepSeek-native sub-agent dispatcher for Pi** — intent classification, parallel sub-agent execution, LSP verification, test running, team mode orchestration, and a full memory subsystem, built on Pi's extension framework with the Cache-First Three-Region model for cost-efficient API usage.

[![npm](https://img.shields.io/npm/v/yu-agent)](https://www.npmjs.com/package/yu-agent)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Quick Start

### Installation

```bash
# As a Pi extension (requires GitHub Packages auth)
# Create ~/.npmrc with:
#   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
#   @saltfish001:registry=https://npm.pkg.github.com/
pi install @saltfish001/yu-agent

# Direct npm install from GitHub Packages
npm install @saltfish001/yu-agent

# Local development
git clone https://github.com/SaltFish001/yu-agent.git
cd yu-agent
npm install
npm run build
```

### Basic Usage

```bash
# One-shot programming task (automatic agent dispatch)
yu "fix the login bug in src/auth/login.ts"

# Direct agent invocation
yu coding "add input validation to the registration form"
yu review src/auth/
yu plan "implement OAuth2 support"
yu commit
yu doc "generate API docs for the auth module"

# Team mode — multi-agent collaboration
yu team create <name> lead:plan coder:coding reviewer:review

# Health diagnosis
yu doctor

# Interactive REPL
yu chat
```

---

## Architecture

```
┌──────────┐    ┌────────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Intent  │───▶│   Agent    │───▶│   LSP    │───▶│   Test   │───▶│  Result  │
│ Classify │    │  Dispatch  │    │  Verify  │    │  Runner  │    │ Persist  │
└──────────┘    └────────────┘    └──────────┘    └──────────┘    └──────────┘
                                                                   │
                                                           ~/.yu/data/decisions.json

Full architecture diagram → [ARCHITECTURE.md](ARCHITECTURE.md)
```

---

## Agent Types

| Type | Default Model | Thinking | Max Turns | Tools | Purpose |
|------|---------------|----------|-----------|-------|---------|
| `coding` | v4-pro | max | 50 | bash, read, edit, write, grep, find, ls | Write and modify code |
| `review` | v4-flash | max | 30 | read, grep, find, ls | Code review (read-only) |
| `plan` | v4-pro | max | 30 | read, grep, find, ls | Technical architecture planning |
| `search` | v4-flash | high | 15 | bash, read, grep | Semantic code + web search |
| `lsp` | v4-flash | high | 20 | bash | LSP diagnostics & auto-fix |
| `commit` | v4-flash | high | 10 | bash | Git commit message generation |
| `doc` | v4-flash | high | 20 | read, edit | Documentation generation |
| `general-purpose` | v4-flash | high | 3 | none | Intent classification (scheduler) |

Model routing logic: **v4-pro** is used when the input contains keywords like "仔细"/"深度"/"pro"/"完全审查", involves 5+ files or cross-module changes, touches security/crypto/payment, or the intent is `refactor` or `team`. Otherwise, **v4-flash** is used for speed and cost efficiency.

---

## Team Mode

yu-agent supports full 4-phase multi-agent team collaboration. Team members communicate asynchronously via filesystem mailboxes (`~/.yu/runtime/{runId}/inboxes/{member}/`), and the runtime state machine is persisted to disk for crash recovery.

### Team Flow

```
Phase 1: Research            Phase 2: Coding
┌──────────────────┐         ┌─────────────────────────┐
│  Architect (pro) │◄───────►│  Coder A (module 1)    │
│  Searcher (flash)│         │  Coder B (module 2)    │
│                  │         │  Coder C (module 3)    │
│  Output: plan.md │         │  Output: implementation │
│  + context.md    │         │                         │
└──────────────────┘         └──────────┬──────────────┘
                                        │
                                        ▼
Phase 3: Review              Phase 4: Integration
┌──────────────────┐         ┌─────────────────────────┐
│  Reviewer A      │◄────────│  Git conflict detection │
│  Reviewer B      │         │  Auto-merge (no conflict)│
│  Reviewer C      │         │  Mark conflicts for user │
│                  │         │                         │
│  Max 2 fix cycles│         │  Cleanup temp dir       │
└──────────────────┘         └─────────────────────────┘
```

### Key Features

- **Mailbox-based async messaging** — Team members exchange messages via atomic JSON files. Each member polls their inbox before every prompt turn.
- **Shared task board** — `yu team task <runId> create/subject` for cross-member coordination.
- **Conflict detection** — After all modules are implemented, `git diff --name-only --diff-filter=U` detects merge conflicts.
- **State machine** — Runtime state transitions (`creating → active → shutdown_requested → deleting → deleted`) are validated against a strict transition matrix.

```bash
# Create a team with explicit roles
yu team create <name> lead:plan coder:coding reviewer:review

# Check status
yu team status <runId>

# Send a message to a team member
yu team send <runId> coder "Please check task #abc123"

# Manage shared task board
yu team task <runId> create "Implement OAuth2 login"
yu team task <runId> list

# Shutdown when done
yu team shutdown <runId>
```

---

## Extension API

yu-agent can be used programmatically from other Pi extensions or Node.js scripts.

### As a Pi Extension

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  // yu-agent's beforeChat hook is automatically registered
  // through extension/index.ts
}
```

In your `package.json`:

```json
{
  "pi": {
    "extensions": ["./node_modules/yu-agent/extension/index.ts"]
  }
}
```

### Programmatic Agent Spawning

```typescript
import { spawnAgent } from 'yu-agent/extension/spawn.js';

const result = await spawnAgent({
  type: 'coding',
  model: 'v4-flash',
  thinking: 'max',
  maxTurns: 50,
  task: 'Fix the type error in src/auth/login.ts',
  files: ['src/auth/login.ts'],
  timeout: 120_000,
});

console.log(result.response);
// → { "status": "success", "files_modified": ["src/auth/login.ts"], ... }
```

### Session Pool (Cache-First)

```typescript
import { getSessionPool, getAllPoolsStats } from 'yu-agent/extension/spawn.js';

const pool = getSessionPool('coding');
const stats = getAllPoolsStats();
console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
```

### Team Mode Integration

```typescript
import { createTeamRun, sendMessage, listActiveTeams } from 'yu-agent/extension/team/index.js';
import { TeamSpecSchema } from 'yu-agent/extension/team/types.js';
```

---

## Configuration

See [CONFIGURATION.md](CONFIGURATION.md) for detailed documentation.

Key configuration files under `~/.yu/`:

| Path | Purpose |
|------|---------|
| `~/.yu/config.json` | Application configuration (optional) |
| `~/.yu/mcp.config.json` | MCP server definitions |
| `~/.yu/personality.json` | Agent identity & tone |
| `~/.yu/prompts/*.md` | Per-agent system prompts |
| `~/.yu/data/decisions.json` | Scheduler decision cache |
| `~/.yu/checkpoints/` | Phase-level recovery checkpoints |
| `~/.yu/pool-sessions/` | Disk-persisted cache-first session pools |
| `~/.yu/sessions.db` | SQLite session database |

---

## Architecture Deep Dive

See [ARCHITECTURE.md](ARCHITECTURE.md) for:

- Module dependency graph
- Complete data flow (Input → Pi hook → classify → plan → execute → LSP → test → persist)
- Session lifecycle (`session_start → setSessionTag → init → call → compress → dispose → shutdown`)
- Cache-First Three-Region Model design rationale
- SQLite IPC for cross-process communication
- All 30+ extension modules with descriptions

## Troubleshooting

### "MCP config not found"
Run `yu doctor` to validate your configuration. This command verifies that all required config files (`mcp.config.json`, `config.json`) exist and are parseable.

### "Agent not responding"
Check active session status with `yu session list`. If an agent has stalled, resume it with `yu session resume <sessionId>`. Sessions are persisted to disk, so no work is lost.

### "LSP/fix doesn't work"
Ensure an LSP server is installed for your project's language. For example, install `typescript-language-server` for TypeScript/JavaScript, `pyright` for Python, or `rust-analyzer` for Rust. Then verify with `yu doctor`.

### "Team creation fails"
Make sure all specified agent types are defined in your configuration. Check `~/.yu/prompts/` for per-agent system prompts and verify the role names match the available agent types.

### "Cache-first sessions not reusing"
The cache-first model requires identical task context, files list, and agent type. Slight differences in the prompt string invalidate the cache. Use `yu session list` to inspect active pools and `getAllPoolsStats()` to monitor hit rates.

---

---

## Inspirations & Credits

yu-agent 站在巨头的肩膀上。以下列出核心功能的灵感来源、原项目链接，以及 yu-agent 的差异化改进。

| 功能 | 灵感来源 | 原项目 | yu-agent 的差异 |
|------|---------|--------|----------------|
| **Team Mode 多 agent 协作** | OMO (Oh My OpenAgent) 的 Sisyphus 编排器 + 并行 agent 执行 | [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | OMO 有 11 个专业 agent、54+ 生命周期钩子、tmux 可视化、文件系统 mailbox IPC。yu-agent 简化为 4 角色（Architect/Coder/Reviewer/Searcher），4 阶段管线，共享目录做上下文交换——更轻、更针对 DeepSeek 生态。 |
| **调度器 + 意图分类** | OMO 的 Sisyphus orchestrator 模式 + Prometheus 战略规划器 | [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | OMO 用多模型路由（Claude/GPT/Gemini/Grok），yu-agent 纯 DeepSeek（v4-pro/v4-flash），调度器本身也是 sub-agent 而非独立服务。分类+执行合一，减少来回开销。 |
| **子 agent 生命周期** | pi-subagents 的 AgentConfig + spawn 机制 | [pi-subagents](https://github.com/tintinweb/pi-subagents) | yu-agent 在其之上加了：SessionPool 缓存池、Three-Region cache 优化、自动 context compression、per-agent-type 并发上限控制。 |
| **Pi 扩展框架** | Pi Coding Agent 的 extension 体系 | [Pi](https://github.com/earendil-works/pi) | yu-agent 深度嵌入 Pi 的 beforeChat hook + 斜杠命令 + TUI 监控面板，不是独立 CLI。 |
| **Cache-First Three-Region Model** | DeepSeek Reasonix 的 prefix cache 优化策略 + 三段式上下文分区 | [DeepSeek KV Cache](https://api-docs.deepseek.com/guides/kv_cache)、[Reasonix 文章](https://devlery.com/en/blog/reasonix-deepseek-prefix-cache-agent) | yu-agent 实现了 Immutable Prefix / Append-Only Log / Volatile Scratch 三层，使缓存命中率达 ~70-90%。每个 SessionPool 内部持久化 cache state 到磁盘。 |
| **Session 管理 + .jsonl 格式** | OpenCode 的 SessionManager + .jsonl 事件日志 | [OpenCode](https://github.com/sst/opencode) | yu-agent 只存元数据（agent type/model/timestamps），不存完整消息——对话历史由 Pi 的 SessionManager 管理，避免重复存储。 |
| **LSP 诊断 + 自动修复** | OMO 的 LSP lifecycle hooks + Claude Code 的 LSP 集成 | [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | yu-agent 实现了独立 LSP 子 agent 类型，支持 TS/Python/Go/Rust 四种语言，含心跳检测和 2 轮修复循环。 |
| **Checkpoint 恢复** | OpenCode 的 checkpoint 系统 + OMO 的 ulw-loop | [OpenCode](https://github.com/sst/opencode)、[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | yu-agent 覆盖 agent_spawn / lsp_verify / commit 三阶段，比 OpenCode 的纯操作级 checkpoint 更细。 |
| **知识库 RAG** | OMO 的 Librarian agent + 标准 RAG 模式 | [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | yu-agent 用 SQLite FTS5 做全文检索引擎，零依赖，轻量但功能受限（不支持 embedding 语义检索）。 |
| **AST 重构** | Biome 的 refactoring API（renameSymbol / extractInterface） | [Biome](https://biomejs.dev) | 直接调用 Biome CLI，不做额外封装。定位于"补刀"，不做大范围重构。 |
| **人格/身份系统** | 予鱼（quite_fish）角色设定——原创 | — | personality.json + identity.ts 驱动，可热替换，但暂不支持按项目级覆盖。 |
| **子 agent 结构化 JSON 输出** | OMO 的 agent 输出格式规范 + Claude Code structured tools | [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | yu-agent 的每种 agent type 有独立 JSON schema（coding/review/plan/commit/lsp/doc），调度器严格校验。 |
| **沙箱执行** | Docker 容器隔离模式（通用） | — | yu-agent 支持 Docker + 本地两种执行后端，通过 sandbox agent type 封装。 |

---

## License

MIT
