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
  yu <prompt>                  One-shot task (auto dispatch)
  yu chat                      Interactive REPL

Coding:
  yu coding <prompt>           Write or modify code
  yu review <path>             Review code (read-only)
  yu plan <task>               Generate an implementation plan
  yu lsp <path>                LSP type check & fix
  yu commit <msg>              Generate commit message
  yu doc <task>                Generate documentation

Code Search & Refactor:
  yu search <query>            Semantic code search
  yu graph <symbol>            Show callers/callees
  yu context <task>            Build context for a task
  yu refactor rename <from> <to> [files...]
  yu refactor extract <type> <file>

Team & Rules:
  yu team create <name> [member:role ...]   Create a multi-agent team
  yu team list/status/send/task/shutdown/delete
  yu rule list                 List orchestrator rules
  yu rule inspect <name>       Show rule details

Knowledge Base:
  yu knowledge search <query>  FTS5 full-text search
  yu knowledge index [dir]     Index/reindex files
  yu knowledge status          Show index stats

Skills & Tools:
  yu skill list/get/activate/deactivate/active
  yu tool list                 List registered tools
  yu tool inspect <name>       Inspect a tool's schema

System:
  yu doctor                    Health diagnosis
  yu run <prompt>              Direct scheduler invocation
  yu monitor [--once]          Live dashboard
  yu supervisor status         Show child process statuses
  yu supervisor stop/restart/logs <topic>

Topics:
  yu topic list/switch/new/rename/archive/bg/status

Git:
  yu git pr create/list        Pull requests
  yu git branch/merge          Branch & merge with conflict detection

Terminal & Sandbox:
  yu terminal list/attach/watch
  yu sandbox <command>         Run in Docker container

General:
  yu help [command] / --help / -h
  yu --version / -v

Data:  ~/.yu/
  prompts/  mcp.config.json  runtime/{runId}/  teams/{name}/  topics.db`

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

Bypasses intent classification and calls the scheduler directly.
Useful for testing or when auto-dispatch doesn't match your intent.`

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
