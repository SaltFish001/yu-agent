# yu-agent Configuration

> **Version 0.1.0** — Configuration reference for all yu-agent settings

---

## Table of Contents

- [Environment Variables](#environment-variables)
- [Data Directory Structure](#data-directory-structure)
- [Config File Paths](#config-file-paths)
- [Main Configuration (~/.yu/config.json)](#main-configuration-yuconfigjson)
- [Agent Type Configuration](#agent-type-configuration)
- [MCP Configuration (~/.yu/mcp.config.json)](#mcp-configuration-yumcpconfigjson)
- [Prompt Files](#prompt-files)
- [Session Configuration](#session-configuration)
- [Resource Limits](#resource-limits)
- [Health Diagnosis](#health-diagnosis)

---

## Environment Variables

yu-agent reads the following environment variables for session and project configuration.

| Variable | Default | Description |
|----------|---------|-------------|
| `YU_SESSION_ID` | Auto-generated (`sess_{timestamp}`) | Session tag for file isolation and SQLite session lookup. Set manually to reuse a specific session. |
| `YU_SESSION_NAME` | Auto-captured from first user prompt | Human-readable session display name (set internally by `session-store.ts`). |
| `YU_SESSION_AGENT` | `""` | Agent type for the current session (e.g., `"coding"`, `"review"`). Used for status tracking. |
| `YU_SESSION_MODEL` | `"{}"` | JSON string with model info for the current session. |
| `YU_SESSION_PARENT` | `""` | Parent session tag for fork/branch tracking. |
| `YU_PROJECT_DIR` | `process.cwd()` | Project directory for status file isolation. Session data is stored under `<YU_PROJECT_DIR>/.yu-agent/status/` when that directory exists. |
| `YU_RESUME_TAG` | — | Set by `yu session resume <tag>`. Injected into the resumer plugin for context recovery on next startup. |
| `PI_PROVIDER` | Provider from Pi settings | Override the API provider for all yu-agent API calls. |
| `YU_NAME_CAPTURED` | — | Internal flag set after first user prompt name capture (prevents re-capture). |
| `PI_CODING_AGENT_DIR` | `~/.yu/agent/` | Pi runtime agent directory. Set by `bin/yu.ts` to use yu-agent's isolated config. |
| `PI_SKIP_VERSION_CHECK` | — | Suppress Pi version check (set by `bin/yu.ts`). |

---

## Data Directory Structure

All yu-agent data is stored under `~/.yu/`. The directory is auto-created on first startup.

```
~/.yu/
├── config.json                    # Optional top-level configuration
├── mcp.config.json                # MCP server definitions
├── sessions.db                    # SQLite session database (IPC bus)
├── knowledge.db                   # SQLite FTS5 knowledge index (RAG)
├── resume_context.json            # Temp file for session resume
├── agent/                         # Pi coding-agent runtime (internal)
├── prompts/                       # Agent system prompt files (.md)
│   ├── scheduler.md
│   ├── coding.md
│   ├── review.md
│   ├── plan.md
│   ├── lsp.md
│   ├── commit.md
│   ├── doc.md
│   ├── search.md
│   └── team.md
├── checkpoints/                   # Phase-level recovery checkpoints
├── pool-sessions/                 # Cache-first agent session pools
│   ├── coding/
│   ├── review/
│   ├── plan/
│   ├── search/
│   ├── lsp/
│   ├── commit/
│   ├── doc/
│   └── general-purpose/
├── data/
│   ├── decisions.json             # Scheduler decision cache (max 50)
│   └── temp/                      # Team mode temp directories
├── runtime/{runId}/               # Team mode runtime data
│   ├── state.json                 # Runtime state machine
│   ├── plan.md                    # Architect output
│   ├── context.md                 # Searcher output
│   ├── inboxes/{member}/          # Per-member mailboxes
│   │   ├── pending/               # Unread messages
│   │   └── processed/             # Acknowledged messages
│   └── tasks/                     # Shared task board
├── teams/{name}/                  # Saved team specifications
│   └── spec.json                  # TeamSpec in Zod-validated JSON
├── status/                        # Legacy status files (deprecated, use SQLite)
└── .cache/                        # Internal cache directory
```

### Path Reference

All paths are defined centrally in `extension/paths.ts`:

| Constant | Path | Purpose |
|----------|------|---------|
| `YU_HOME` | `~/.yu/` | Base config and data directory |
| `PI_AGENT_DIR` | `~/.yu/agent/` | Pi runtime agent config |
| `PROMPTS_DIR` | `~/.yu/prompts/` | Agent system prompt files |
| `DATA_DIR` | `~/.yu/data/` | Persistent runtime data |
| `TEMP_DIR` | `~/.yu/data/temp/` | Temporary working directories |
| `DECISIONS_FILE` | `~/.yu/data/decisions.json` | Scheduler decision cache |
| `MCP_CONFIG_PATH` | `~/.yu/mcp.config.json` | MCP server definitions |
| `POOL_SESSIONS_DIR` | `~/.yu/pool-sessions/` | Disk-persisted session pools |

---

## Main Configuration (~/.yu/config.json)

Optional top-level configuration file. If the file doesn't exist, all options use their defaults. Loaded by `extension/config.ts::loadAppConfig()`.

### Configuration Structure

```json
{
}
```

### Field Reference

| JSON Path | Type | Default | Description |
|-----------|------|---------|-------------|

---

## Agent Type Configuration

Agent types are defined programmatically in `extension/config.ts::AGENT_TYPES`. Each type has the following fields:

### AgentTypeConfig Fields

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | `string` | Human-readable name shown in logs and UI. |
| `description` | `string` | One-line description of the agent's purpose. |
| `model` | `string` | Default model identifier. Overridable at spawn time. Examples: `"v4-flash"`, `"v4-pro"`. |
| `thinking` | `"max"` \| `"high"` | Thinking/effort level. Maps to pi-subagents' `xhigh` (for `"max"`) or `"high"`. |
| `maxTurns` | `number` | Maximum number of tool-calling turns before the agent auto-terminates. |
| `builtinToolNames` | `string[]` | Allowed built-in tools. Controls read/write permissions. |
| `systemPrompt` | `string` | Content of the system prompt (loaded from `~/.yu/prompts/{type}.md` at startup). |

### Built-in Agent Types

| Type Key | displayName | Default Model | Thinking | Max Turns | Allowed Tools | Description |
|----------|-------------|---------------|----------|-----------|---------------|-------------|
| `coding` | Coding Agent | `v4-pro` | max | 50 | bash, read, edit, write, grep, find, ls | Write and modify code. Full read/write access. |
| `review` | Review Agent | `v4-flash` | max | 30 | read, grep, find, ls | Code review. Read-only tools. |
| `plan` | Plan Agent | `v4-pro` | max | 30 | read, grep, find, ls | Technical architecture planning. Read-only. |
| `search` | Search Agent | `v4-flash` | high | 15 | bash, read, grep | Semantic code search + web search via MCP. |
| `lsp` | LSP Agent | `v4-flash` | high | 20 | bash | LSP diagnostics and auto-fix. Terminal only. |
| `commit` | Commit Agent | `v4-flash` | high | 10 | bash | Git commit message generation. Terminal only. |
| `doc` | Doc Agent | `v4-flash` | high | 20 | read, edit | Documentation generation. Read + write only. |
| `general-purpose` | General Purpose Agent | `v4-flash` | high | 3 | _(none)_ | Scheduler/intent classifier. No tools — only outputs JSON plans. |

### Model Routing Logic

The scheduler dynamically selects between `v4-flash` (default) and `v4-pro` based on:

- **v4-pro triggered when:**
  - User input contains keywords: `"仔细"`, `"深度"`, `"pro"`, `"完全审查"`, `"thorough"`, `"deep"`, `"expert"`
  - Task involves 5+ files or cross-module changes
  - Task touches security, authentication, encryption, payment modules
  - Intent is `refactor` or `team`
  - Review task is flagged for deep review

- **v4-flash used otherwise** (fast, cost-effective, sufficient for most tasks)

### Adding Custom Agent Types

Custom agent types can be registered programmatically:

```typescript
import { registerAgents } from '@tintinweb/pi-subagents/dist/agent-types.js';
import { readFileSync } from 'node:fs';

registerAgents(new Map([
  ['my-custom-type', {
    name: 'my-custom-type',
    displayName: 'My Custom Agent',
    description: 'Custom agent description',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 30,
    builtinToolNames: ['read', 'grep'],
    systemPrompt: readFileSync('~/.yu/prompts/my-custom.md', 'utf-8'),
    promptMode: 'replace',
    extensions: true,
    skills: true,
  }]
]));
```

---

## MCP Configuration (~/.yu/mcp.config.json)

Defines MCP (Model Context Protocol) servers. Each server runs as an independent child process, providing tools and resources to agents via stdio JSON-RPC.

### Configuration Structure

```json
{
  "servers": {
    "web-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-web-search"],
      "env": {
        "API_KEY": "your-api-key-here"
      }
    },
    "database": {
      "command": "python",
      "args": ["-m", "mcp_database_server"],
      "env": {}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
    }
  }
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `servers` | `object` | Yes | Map of server name to server configuration. |
| `servers.<name>.command` | `string` | Yes | Shell command to start the server process. |
| `servers.<name>.args` | `string[]` | No | Command-line arguments passed to the command. |
| `servers.<name>.env` | `object` | No | Environment variables for the server process. Keys and values are validated for safety. |

### Security Validation

MCP configuration is validated at startup with the following checks:

1. **Zod schema validation** — Config must match `McpConfigSchema`. Validation errors print a clear message and exit the process.
2. **Environment variable safety** — All env values must match the safe regex `/^[a-zA-Z0-9_\-.:/=@%+~,#! ]+$/`. Shell-sensitive characters (`;`, `|`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `[`, `]`, `&`, `>`, `<`, `\n`, `\r`, `\0`) are rejected.
3. **Blocked environment keys** — The following env vars cannot be overridden: `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_PATH`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `PERL5LIB`.

If the file doesn't exist, MCP manager skips server startup with a warning (no error).

### MCP Server Lifecycle

```
validateMcpConfig() at startup
       │
       ▼
startMCPManager() → for each server:
       │
       ├── spawn child process (stdio)
       │
       ├── JSON-RPC initialize + tools/list
       │       → confirm server is alive
       │
       ├── Heartbeat every 10s (PING_INTERVAL_MS)
       │
       └── Status written to SQLite agents table
       
On process exit:
       └── SIGTERM to each child process
```

---


## Prompt Files

`~/.yu/prompts/` contains Markdown files defining each agent type's system prompt. Prompts are loaded at startup by `extension/config.ts`.

### File Inventory

| File | Agent Type | Used By | Description |
|------|------------|---------|-------------|
| `scheduler.md` | general-purpose | `classifier.ts` | Intent classification + JSON plan output |
| `coding.md` | coding | `spawn.ts` | Code writing/modification (Flash/Pro sections) |
| `review.md` | review | `spawn.ts` | Code review (read-only) |
| `plan.md` | plan | `spawn.ts` | Technical architecture planning |
| `lsp.md` | lsp | `spawn.ts` | LSP diagnostics + auto-fix workflow |
| `commit.md` | commit | `spawn.ts` | Conventional commits generation |
| `doc.md` | doc | `spawn.ts` | Code documentation generation |
| `search.md` | search | `spawn.ts` | Code search + web search via MCP |
| `team.md` | team | `team-orchestrator.ts` | Role prompts for team mode (Architect/Coder/Reviewer/Searcher) |

### Customizing Prompts

Edit the corresponding `.md` file to modify agent behavior. Changes take effect on next yu-agent startup (prompts are loaded once at initialization).

Each prompt file defines:
- Agent role and behavior rules
- Output format specification (JSON schema)
- Mode-specific instructions (Flash vs Pro)
- Constraints and anti-patterns to avoid

### Scheduler Prompt (special case)

The `general-purpose` (scheduler) agent has a unique prompt with strict format rules:

```markdown
# Scheduler

**Iron rule: Only output JSON. Any non-JSON output causes an error retry.**
No markdown code blocks, no extra text, no greetings.

Output for non-programming tasks:
{"pass_through": true, "reasoning": "..."}

Output for programming tasks:
{"intent": "coding", "reasoning": "...", "agents": [...], "parallel_groups": [...], "dependencies": {}}
```

---

## Session Configuration

### Session Tag

Each session is identified by a `YU_SESSION_ID` tag (auto-generated or set manually):

```bash
# Auto-generated: sess_{timestamp}
# Manual override:
export YU_SESSION_ID="my-session-tag"
yu "fix the login bug"
```

### Session Storage

Session data is stored in `~/.yu/sessions.db` (SQLite). The database contains:

| Table | Purpose | Key Operations |
|-------|---------|----------------|
| `sessions` | Session metadata | `upsertSession()`, `listSessions()` |
| `messages` | Conversation history | `insertMessage()`, `getMessages()` |
| `agents` | Sub-agent statuses | `upsertAgents()`, `getAgents()` |
| `summary` | Aggregated counts | `upsertSummary()`, `getSummary()` |
| `cache` | Cache hit/miss stats | `upsertCache()`, `getCache()` |
| `todos` | Per-session task list | `insertTodo()`, `getTodos()` |

### Session CLI

```bash
yu session list                    # List all sessions
yu session show <tag>              # Show session details + history
yu session resume <tag>            # Resume from session (injects history)
yu session fork <tag>              # Create a new session branching from history
yu session archive <tag>           # Soft-delete a session
yu session unarchive <tag>         # Restore an archived session
yu session todo <tag> add "..."    # Add task to session
yu session todo <tag> list         # List session tasks
yu session info                    # Show DB path, session count
yu session backup [path]           # Backup sessions.db
yu session restore <path>          # Restore from backup
yu session clean [--days N]        # Remove sessions older than N days (default 7)
```

### Session Lifecycle

```
session_start
  → setSessionTag(id)          — Set YU_SESSION_ID env var
  → setSessionAgent(agent)     — Record agent type
  → setSessionModel(model)     — Record model info
  → setSessionParent(tag)      — Record parent tag (for forks)

Each user turn:
  → before_agent_start hook
     → upsertSession()          — Create/update session metadata
     → insertMessage('user')    — Save user message
  → turn_end hook
     → insertMessage('assistant') — Save assistant response (with dedup)

session_shutdown
  → flushFinalStatus()          — Write final status to SQLite
  → pool.dispose()              — Dispose session pool
```

### Fork/Branch Sessions

```bash
# Fork from an existing session
yu session fork <tag>
# A new session is created with the original as parent
# The new session's prompt is injected with historical context
```

### Backup & Restore

```bash
# Backup with auto-timestamp
yu session backup
# → ~/yu-agent/sessions-backup-20260603-143022.db

# Restore from backup
yu session restore /path/to/backup.db
```

---


## Resource Limits

> **Note:** Resource limits for sandbox execution, token budgets, and concurrency are planned for Phase 4. Current defaults are listed below as placeholders.

### Sandbox Execution

| Parameter | Default | Description |
|-----------|---------|-------------|
| Docker image | `node:24-slim` | Container image for sandbox execution |
| Timeout | 60,000ms | Maximum execution time per sandbox command |
| Memory limit | 512MB | Container memory limit (Docker mode only) |
| Fallback | Local execution with warning | Used when Docker is unavailable |

### Session Pool

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_TURNS_PER_SESSION` | 300 | Turns before automatic session reset |
| `MAX_TOKENS_PER_SESSION` | 900,000 | Input tokens before automatic session reset |
| `CONTEXT_COMPRESSION_THRESHOLD` | 75% | Context usage % that triggers compression |
| `RESULT_CAP_TOKENS` | 3,000 | Tool output truncation threshold |

### Concurrency

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_CONCURRENCY` | 4 | Maximum parallel sub-agents |
| `AGENT_TIMEOUT_MS` | 120,000 | Per-agent execution timeout |

### LSP Verification

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_RETRY_LSP` | 2 | Maximum LSP fix cycles |
| Diagnostics timeout | 10,000ms | Wait for `publishDiagnostics` |
| Heartbeat interval | 15,000ms | LSP server health check interval |

### Checkpoints

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_PENDING_AGE_MS` | 24 hours | Max age before checkpoint is considered stale |

### Decision Cache

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_DECISIONS` | 50 | Maximum cached scheduler decisions |

---



## Health Diagnosis

Run `yu doctor` for a one-click health check of all subsystems:

```bash
yu doctor
```

The diagnosis checks:

1. **Data directory** (`~/.yu/`) — Exists and readable
2. **MCP configuration** — File exists, valid JSON, valid Zod schema
3. **Prompt files** — Directory exists with ≥ 8 prompt files
4. **Ring buffer** — SQLite DB accessible, reports entries and size
5. **Facts store** — JSON file readable, reports entries and size
6. **Scene state** — JSON file readable
7. **Session DB** — SQLite DB accessible (auto-created if missing)
8. **Checkpoints** — Lists any pending (uncompleted) checkpoints

---

> **Last updated:** 2026-06-03
> **See also:** [ARCHITECTURE.md](ARCHITECTURE.md) for module dependency graph and data flow, [README.md](README.md) for quick start and overview
