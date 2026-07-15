# yu-agent

DeepSeek-native AI programming agent — CLI dispatcher + parallel sub-agent execution + Web UI + team mode. Zero runtime deps beyond Bun.

## Project

- **Stack:** TypeScript 6.x, Bun ≥1.2, ESM, Hono web server, bun:sqlite
- **Entry:** `bin/yu.ts` (CLI), `webui/server.ts` (Web UI on port 3000)
- **Build target:** single-file `dist/bin/yu.js` (190 modules, ~330ms)
- **Data dir:** `~/.yu/` — prompts, mcp config, sqlite dbs, checkpoints, pool sessions
- **Optional deps (not loaded at runtime):** `@earendil-works/pi-coding-agent`, `@tintinweb/pi-subagents`

## Commands

```bash
bun run build          # bun build → dist/ (also syncs prompts to ~/.yu/prompts)
bun run typecheck      # tsc --noEmit (project tsconfig.typecheck.json)
bun test               # bun:test — 380 tests in 29 files
bun run lint           # biome lint .
bun run lint:fix       # biome lint --apply .
bun run format:fix     # biome format --write .
```

After build, the CLI runs as: `bun dist/bin/yu.js <prompt>` (or symlink as `yu`).

## Architecture

```
bin/yu.ts (CLI entry) → routes: chat/ui/doctor/team/topic | default → classifier
classifier.ts          → intent classification (fast-path >200 chars or LLM)
scheduler.ts           → executePlan: parses JSON plan, orchestrates parallel groups
executor.ts            → runs parallel groups (max 4 concurrent), diff review
spawn.ts               → thin proxy → agent-loop.ts::runAgent()
agent-loop.ts          → core LLM + tool-use loop, context compression via context-manager.ts
verifier.ts            → LSP diagnostics (lsp-manager.ts) + test runner auto-detection
tracker.ts             → status tracking + decision persistence to decisions.json
deepseek.ts             → DeepSeek API (v4-flash/v4-pro), prefix cache aware
db/ (db-core, db-entities, db-analytics) → bun:sqlite, 10 tables
```

Subsystem modules: `team/` (mailbox/tasklist/runtime), `tools/` (bash/edit/read/write/grep/glob/ls/web), `mcp/` (stdio/SSE transports), `knowledge/` (FTS5 RAG), `sandbox/` (Docker), `terminal/` (PTY), `refactor/` (TS AST), `rules/`, `skills/`, `browser/`.

Agent types (defined in `bootstrap.ts`, prompts in `prompts/`): coding, review, plan, search, lsp, commit, doc, general-purpose.

## Conventions

- **ESM imports** always include `.js` extension: `import { x } from './module.js'`
- **Logger:** `const log = createLogger('moduleName')` — structured JSON-lines to stderr + DB
- **No semicolons**, single quotes, trailing commas (Biome — see `biome.json`)
- **No `node:*` import prefix** — bare `'fs'`, `'path'` etc. (Biome rule disabled)
- **Subprocesses:** `Bun.spawn` / `Bun.spawnSync` only — zero `child_process` usage
- **DB:** `bun:sqlite` synchronous API — all queries blocking, no async wrappers
- **File headers:** `/** yu-agent — short description */` comment block at top
- **Exports:** named exports from the file that defines them; interfaces co-located with implementations
- **Types:** strict mode enabled; zero `any`, zero `@ts-ignore` (enforced)
- **Error handling:** prefer `{ success: false, error: "..." }` return objects over thrown exceptions
- **Validation:** Zod schemas for external input (MCP config, team specs, LLM output)
- **Test files:** under `tests/`, named `*.test.ts`, use `bun:test` (`describe`/`it`/`expect`)

## Notes

- Graph index: `codebase-memory-mcp` at `.code-graph/` (gitignored) — run `index_repository` once, then file watcher keeps fresh
- Agent prompts live in `prompts/` at project root; postbuild copies them to `~/.yu/prompts/`
- CI: `.github/workflows/ci.yml` — PR → `bun install` → `bun run build` → `bun test`
