#!/usr/bin/env node
/**
 * yu-agent — Help text and command help.
 *
 * Extracted from bin/yu.ts to reduce file size and improve maintainability.
 */

import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Project root: dist/bin/ -> dist/ -> project root
const PROJECT_ROOT = resolve(__dirname, '..', '..')

let _version: string | null = null

export function getVersion(): string {
  if (!_version) {
    try {
      _version = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8')).version || '0.1.0'
    } catch {
      _version = '0.1.0'
    }
  }
  return _version as string
}

export const HELP_TEXT = `yu-agent — AI-powered programming agent  (v${getVersion()})

Usage:
  yu <prompt>                  One-shot programming task (automatic dispatch)
  yu chat                      Interactive REPL (Pi interactive mode)

Agent Commands:
  yu coding <prompt>           Start a coding task
  yu review <path>             Review code (read-only)
  yu plan <task>               Generate implementation plan
  yu commit <msg>              Generate commit message
  yu doc <task>                Generate documentation
  yu lsp <path>                LSP type check & fix

Refactoring:
  yu refactor rename <from> <to> [files...]  Rename a symbol (AST-safe)
  yu refactor extract <type> <file>          Extract inline type to interface

Diagnostics:
  yu doctor                    One-click health diagnosis

Scheduler & Monitor:
  yu run <prompt>              Spawn coding agent directly
  yu monitor [--once]          Live status dashboard (--once for single snapshot)

Knowledge Base (RAG):
  yu knowledge search <query>  Full-text search across project files (FTS5)
  yu knowledge index [dir]     Index/reindex project files
  yu knowledge status          Show knowledge base stats


Terminal Integration:
  yu terminal list             List current user's terminal processes
  yu terminal attach <pid>     Read process stdout buffer (one-shot)
  yu terminal watch <pid>      Live-tail process stdout (Linux only)

Sandbox Execution:
  yu sandbox <command>         Run command in isolated Docker container
  yu sandbox status            Check sandbox availability

Code Search (CodeGraph):
  yu search <query>            Semantic code search across the project
  yu graph <symbol>            Show callers/callees for a symbol
  yu context <task>            Build context for a task

Tool Registry:
  yu tool list                 List all registered tools
  yu tool inspect <name>       Inspect a specific tool's schema, auth, and hooks

Rule Management (Orchestrator):
  yu rule list                 List all active rules from orchestrator
  yu rule inspect <name>       Show rule details

Legacy (use \`yu rule\` instead):
  yu role list                 List all loaded roles (deprecated)

Skill Management:
  yu skill list                List all loaded skills
  yu skill get <name>          Show skill details
  yu skill activate <name>     Activate a skill for the session
  yu skill deactivate <name>   Deactivate a skill
  yu skill active              Show currently active skills

Team Mode:
  yu team create <name> ...    Create a team for multi-agent work
  yu team list                 List active teams
  yu team status <runId>       Show team status
  yu team send <runId> <to>    Send message to team member
  yu team task <runId> <act>   Manage shared task board
  yu team shutdown <runId>     Request team shutdown
  yu team delete <runId>       Delete team run
  yu team specs                List saved team specs

Git Integration:
  yu git pr create [branch]    Create PR from current branch (needs gh CLI)
  yu git pr list               List open PRs
  yu git branch <name>         Create and switch to branch
  yu git merge <branch>        Merge branch with conflict detection

Package Management:
  yu install <pkg>             Install MCP server package
  yu update                    Self-update
  yu uninstall                 Remove yu-agent

Topic Management:
  yu topic list                List all topics
  yu topic switch <name>       Switch to a topic
  yu topic new <name> <dir>    Create a new topic
  yu topic rename <old> <new>  Rename a topic
  yu topic archive <name>      Archive a topic (soft-delete)
  yu topic bg <name> <prompt>  Start a background task on a topic
  yu topic status              Show background task progress

Supervisor:
  yu supervisor status [<topic>]  Show child process statuses
  yu supervisor stop <topic>      Stop a child process
  yu supervisor restart <topic>   Restart a child process
  yu supervisor logs <topic> [n]  Show last n lines of child log

General:
  yu help [command]            Show this help, or help for a specific command
  yu --help / -h               Same as "yu help"
  yu --version / -v            Show version

Environment:
  YU_SESSION_ID                Session tag (auto-generated, or set manually)
  YU_PROJECT_DIR               Project directory (default: process.cwd())

Data Directory:  ~/.yu/
  ~/.yu/prompts/               Agent type system prompts
  ~/.yu/mcp.config.json        MCP server configuration
  ~/.yu/runtime/{runId}/       Team runtime data (mailboxes, state)
  ~/.yu/teams/{name}/          Saved team specs
  ~/.yu/topics.db              SQLite topic database

Agent Types (auto-dispatched by scheduler):
  coding    — 编写和修改代码
  review    — 审查代码，只读不改
  plan      — 出技术方案，只读不改
  search    — 代码库搜索 + 网页搜索
  commit    — git commit 信息生成
  lsp       — LSP 诊断与自动修复
  doc       — 文档生成
  general-purpose — 通用意图识别与任务分发

Team Examples:
  yu team create my-team                           Single-member team
  yu team create squad lead:plan coder:coding reviewer:review
  yu team task <runId> create "Fix login bug"
  yu team send <runId> coder "Check task #abc123"
`

export function showHelpForCommand(command: string): string {
  switch (command) {
    case 'help':
      return 'yu help [command]  —  Show this help, or help for a specific command.'

    case 'doctor':
      return `yu doctor — One-click health diagnosis

Checks all yu-agent subsystems:
  - Data directory (~/.yu/)
  - MCP configuration file
  - Prompt files
  - Memory subsystem (ring buffer)
  - Session database (integrity check)
  - Token usage statistics
  - Agent run statistics

Options:
  --json    Output results as structured JSON

Reports any issues found. No arguments needed.`

    case 'team':
      return `yu team — Multi-agent team mode

Usage:
  yu team create <name> [member:role ...]   Create a team
  yu team list                              List active teams
  yu team status <teamRunId>                Show team details & member status
  yu team send <teamRunId> <to> <msg>       Send a message to a team member
  yu team task <teamRunId> <action> [...]   Manage shared task board
  yu team shutdown <teamRunId>              Request team shutdown
  yu team delete <teamRunId> [--force]      Delete a team run
  yu team specs                             List saved team specs

Actions for "yu team task":
  create <subject> [description]   Create a new task
  list                              List all tasks
  get <taskId>                      Get task details
  update <taskId> <status>          Update task status
  delete <taskId>                   Delete a task

Team data stored in ~/.yu/runtime/{runId}/`

    case 'monitor':
      return `yu monitor [--once] — Live status dashboard

Shows real-time status of sub-agents, MCP servers, LSP servers,
and team mode activity.

Options:
  --once    Print a single snapshot and exit (no live refresh)

Reads from SQLite databases in ~/.yu/.`

    case 'coding':
    case 'review':
    case 'plan':
    case 'commit':
    case 'doc':
    case 'search':
    case 'lsp':
      return `yu ${command} <prompt> — Agent command

Dispatches a ${command} sub-agent task.
Examples:
  yu ${command} <your task description>
  yu ${command} <path or query>

The scheduler automatically routes to the ${command} agent type.`

    case 'run':
      return `yu run <prompt> — Direct scheduler invocation

Bypasses Pi's command routing and calls the yu-agent scheduler directly.
Useful for testing or when Pi's dispatch doesn't match your intent.`

    case 'install':
      return `yu install <package> — Install an MCP server package

Installs a new MCP server and adds it to ~/.yu/mcp.config.json.`

    case 'supervisor':
      return `yu supervisor — Supervisor management

Manages child processes (agents) forked by the supervisor daemon.
Allows checking status, stopping, restarting, and viewing logs.

Usage:
  yu supervisor status [<topic>]      Show child process(es) status
  yu supervisor stop <topic>          Gracefully stop a child process
  yu supervisor restart <topic>       Restart a child process
  yu supervisor logs <topic> [n]      Show last n lines of child log (default: 10)

Data read from ~/.yu/topics.db (child_processes table).`

    case 'topic':
      return `yu topic — Topic management

Manages named topics (contexts) with their own working directory,
summary, status tracking, and turn counting.

Usage:
  yu topic list                    List all topics
  yu topic list --all              List all topics including archived
  yu topic switch <name>           Switch to a topic (changes cwd)
  yu topic new <name> <dir>        Create a new topic at <dir>
  yu topic rename <old> <new>      Rename a topic
  yu topic archive <name>          Archive a topic (soft-delete)
  yu topic bg <name> <prompt>      Start a background task on a topic
  yu topic status                  Show background task progress

Background limits:
  Config key: topic.maxBackground in ~/.yu/config.json
  Default: 3 concurrent background tasks

Data stored in ~/.yu/topics.db (SQLite).`

    case 'update':
      return 'yu update — Self-update yu-agent to the latest version.'

    case 'uninstall':
      return 'yu uninstall — Remove yu-agent from the system.'

    case 'rule':
      return `yu rule — Rule (orchestrator) management

Reads rules from ~/.yu/orchestrator.json.

Usage:
  yu rule list                    List all active rules
  yu rule inspect <name>          Show rule details (trigger, actions, conditions)

Rules define auto-triggered actions across topics.
Example orchestrator.json:
  { "rules": [{ "name": "测试通过→部署", "trigger": "test:pass", "action": "deploy" }] }`

    case 'role':
      return `yu role — Role management (deprecated, use 'yu rule' instead)

Legacy role-based access control for tools.
Still available for compatibility.

Usage:
  yu role list                    List all loaded roles (deprecated)
  yu role get <name>              Show role details
  yu role resolve <name>          Show resolved (inherited) role
  yu role compose <n1> [<n2>...]  Compose multiple roles

Note: This system is being replaced by the new Rule (orchestrator) system.
Use \`yu help rule\` for the new system.`

    case 'skill':
      return `yu skill — Skill management

Manages skills (extensible agent capabilities with lifecycle hooks).

Usage:
  yu skill list                    List all loaded skills
  yu skill get <name>              Show skill details
  yu skill activate <name>         Activate a skill (for current session)
  yu skill deactivate <name>       Deactivate a skill
  yu skill active                  Show currently active skills
  yu skill refresh                 Re-scan skills directory

Skill files: ~/.yu/skills/*.ts`

    case 'tool':
      return `yu tool — Tool registry inspection

Usage:
  yu tool list              List all registered tools with their descriptions
  yu tool inspect <name>    Show detailed info for a specific tool (schema, auth, hooks, timeout)`

    default:
      return `Unknown command: ${command}\nRun "yu help" to see all available commands.`
  }
}
