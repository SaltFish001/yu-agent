/**
 * yu-agent — Unified path constants.
 *
 * All yu-agent configuration and data is stored under ~/.yu/.
 * This module provides the canonical path constants so every
 * module uses the same base directory.
 *
 * Directory layout:
 *   ~/.yu/                    — YU_HOME (base directory)
 *   ~/.yu/agent               — Pi coding agent config (used by Pi runtime)
 *   ~/.yu/prompts             — Agent type system prompts (markdown files)
 *   ~/.yu/data                — Persistent data (decisions, temp files)
 *   ~/.yu/data/temp           — Temporary team-mode working directories
 *   ~/.yu/mcp.config.json     — MCP server configuration
 *   ~/.yu/pool-sessions       — Cache-first agent session pools (disk persistence)
 *   ~/.yu/runtime/{runId}/    — Team runtime directories (mailboxes, state)
 *   ~/.yu/teams/{name}/       — Saved team specs
 *   ~/.yu/sessions.db         — SQLite session database
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** ~/.yu — base directory for all yu-agent data, config, and state */
export const YU_HOME = resolve(homedir(), '.yu');

/** ~/.yu/agent — Pi coding-agent directory (used internally by Pi runtime) */
export const PI_AGENT_DIR = resolve(YU_HOME, 'agent');

/** ~/.yu/prompts — markdown prompt files for each agent type */
export const PROMPTS_DIR = resolve(YU_HOME, 'prompts');

/** ~/.yu/data — persistent scheduler decisions and other runtime data */
export const DATA_DIR = resolve(YU_HOME, 'data');

/** ~/.yu/data/temp — temporary working directories (team-mode, etc.) */
export const TEMP_DIR = resolve(DATA_DIR, 'temp');

/** ~/.yu/data/decisions.json — scheduler decision history */
export const DECISIONS_FILE = resolve(DATA_DIR, 'decisions.json');

/** ~/.yu/mcp.config.json — MCP server definitions */
export const MCP_CONFIG_PATH = resolve(YU_HOME, 'mcp.config.json');

/** ~/.yu/pool-sessions — disk-persisted agent session pools (cache-first) */
export const POOL_SESSIONS_DIR = resolve(YU_HOME, 'pool-sessions');
