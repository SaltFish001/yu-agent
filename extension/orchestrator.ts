/**
 * yu-agent — Orchestrator engine (Phase 3).
 *
 * Reads rules from ~/.yu/orchestrator.json and auto-triggers cross-topic
 * tasks based on events from the SQLite event bus.
 *
 * Rule format:
 * {
 *   "rules": [
 *     {
 *       "name": "trigger-api-backend",
 *       "when": {
 *         "topic": "frontend",        // exact match, or '*' for any topic
 *         "event": "child_task_done",
 *         "condition": "payload.status === 'completed'"
 *       },
 *       "then": {
 *         "action": "spawn_child",
 *         "topic": "backend",
 *         "prompt": "Build API endpoints based on {{payload}}"
 *       }
 *     }
 *   ]
 * }
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { get, writeEvent, ensureDaemonRunning } from './topic.js';
import { DatabaseSync } from 'node:sqlite';

// ── Types ─────────────────────────────────────────────────

interface OrchestratorCondition {
  topic: string;
  event: string;
  condition?: string;
}

interface OrchestratorAction {
  action: 'spawn_child';
  topic: string;
  prompt: string;
}

interface OrchestratorRule {
  name: string;
  when: OrchestratorCondition;
  then: OrchestratorAction;
}

interface OrchestratorConfig {
  rules: OrchestratorRule[];
}

// ── Internal helpers ──────────────────────────────────────

const ORCHESTRATOR_PATH = resolve(homedir(), '.yu', 'orchestrator.json');

function loadRules(): OrchestratorRule[] {
  if (!existsSync(ORCHESTRATOR_PATH)) return [];
  try {
    const raw = readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    const config = JSON.parse(raw) as OrchestratorConfig;
    return Array.isArray(config.rules) ? config.rules : [];
  } catch {
    return [];
  }
}

/**
 * Open a dedicated DB connection for orchestration writes.
 */
function getOrchDb(): DatabaseSync {
  const dbPath = resolve(homedir(), '.yu', 'topics.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

/**
 * Evaluate a condition expression against the payload.
 * The condition is a JS expression string evaluated where `payload` is
 * the event payload object. Returns true if condition is absent/empty
 * or if the expression evaluates truthy.
 */
function evaluateCondition(condition: string | undefined, payload: Record<string, unknown>): boolean {
  if (!condition || condition.trim() === '') return true;
  try {
    const fn = new Function('payload', `return (${condition})`);
    return !!fn(payload);
  } catch {
    return false;
  }
}

/**
 * Replace {{payload}} and {{payload.key}} placeholders in a template string.
 */
function interpolatePrompt(template: string, payload: Record<string, unknown>): string {
  let result = template;
  if (result.includes('{{payload}}')) {
    result = result.replace(/\{\{payload\}\}/g, JSON.stringify(payload));
  }
  result = result.replace(/\{\{payload\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_match, key) => {
    const val = payload[key];
    if (val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
  return result;
}

/**
 * Execute a spawn_child action: find or create the target topic, then
 * set it to background with the given prompt.
 */
function actionSpawnChild(topicName: string, promptTemplate: string, eventPayload: Record<string, unknown>): void {
  const prompt = interpolatePrompt(promptTemplate, eventPayload);
  const db = getOrchDb();
  const dir = resolve(homedir(), '.yu', 'topics', topicName);

  // Ensure topic directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Find or create the target topic
  const existing = get(topicName);
  if (existing) {
    // Already exists — set it to background if it's idle
    if (existing.status === 'idle') {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE topics
        SET status = 'background',
            summary = ?,
            turns = turns + 1,
            last_active = ?,
            cmd = ?,
            started_at = ?
        WHERE name = ? AND status = 'idle'
      `).run(`Running: ${prompt}`, now, prompt, now, topicName);
    }
  } else {
    // Create new topic
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO topics (id, name, dir, summary, status, turns, last_active, created_at, archived)
      VALUES (?, ?, ?, ?, 'background', 1, ?, ?, 0)
    `).run(id, topicName, dir, `Running: ${prompt}`, now, now);
  }

  db.close();

  // Write orchestrator event for traceability
  writeEvent(topicName, 'child_spawned', { source: 'orchestrator', prompt });

  // Ensure the supervisor daemon is running to pick up the new task
  ensureDaemonRunning();
}

// ── Public API ────────────────────────────────────────────

/**
 * Check orchestrator rules and trigger any matching actions.
 * Called after every event write in supervisor.ts.
 *
 * @param eventTopic   The topic name that the event occurred on
 * @param eventType    The event type (child_spawned, child_task_done, etc.)
 * @param eventPayload The event payload object
 */
export function checkAndTriggerOrchestrator(
  eventTopic: string,
  eventType: string,
  eventPayload: Record<string, unknown>,
): void {
  const rules = loadRules();
  if (rules.length === 0) return;

  for (const rule of rules) {
    // Topic match: exact or '*'
    if (rule.when.topic !== '*' && rule.when.topic !== eventTopic) continue;

    // Event type match
    if (rule.when.event !== eventType) continue;

    // Condition evaluation
    if (!evaluateCondition(rule.when.condition, eventPayload)) continue;

    // Execute action
    console.log(`[orchestrator] Rule "${rule.name}" triggered: ${rule.then.action} on topic "${rule.then.topic}"`);

    switch (rule.then.action) {
      case 'spawn_child':
        actionSpawnChild(rule.then.topic, rule.then.prompt, eventPayload);
        break;
      default:
        console.warn(`[orchestrator] Unknown action "${rule.then.action}" in rule "${rule.name}"`);
    }
  }
}
