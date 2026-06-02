/**
 * yu-agent — Agent type configuration.
 *
 * Defines the 7 custom sub-agent types.
 * Each type has a default model, thinking level, tool set, and system prompt.
 *
 * In standalone mode, agent types are registered with the Pi runtime
 * through pi-subagents' API. This config provides the type definitions.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { registerAgents as registerPiSubagents } from '@tintinweb/pi-subagents/dist/agent-types.js';
import { PROMPTS_DIR } from './paths.js';

// ── Agent type definition ─────────────────────────────

export interface AgentTypeConfig {
  displayName: string;
  description: string;
  model: string;
  thinking: 'max' | 'high';
  maxTurns: number;
  builtinToolNames: string[];
  systemPrompt: string;
}

// ── Prompt loader ──────────────────────────────────────

function loadPrompt(name: string): string {
  try {
    const path = resolve(PROMPTS_DIR, `${name}.md`);
    return readFileSync(path, 'utf-8');
  } catch (err) {
    console.warn(`[yu-agent] Prompt file not found for agent type "${name}", using fallback:`, err);
    return `You are a ${name} agent. Complete the assigned task.`;
  }
}

// ── Agent type definitions ─────────────────────────────

export const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  coding: {
    displayName: 'Coding Agent',
    description: '编写和修改代码',
    model: 'v4-flash',
    thinking: 'max',
    maxTurns: 50,
    builtinToolNames: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'],
    systemPrompt: loadPrompt('coding'),
  },

  review: {
    displayName: 'Review Agent',
    description: '审查代码，只读不改',
    model: 'v4-flash',
    thinking: 'max',
    maxTurns: 30,
    builtinToolNames: ['read', 'grep', 'find', 'ls'],
    systemPrompt: loadPrompt('review'),
  },

  plan: {
    displayName: 'Plan Agent',
    description: '出技术方案，只读不改',
    model: 'v4-flash',
    thinking: 'max',
    maxTurns: 30,
    builtinToolNames: ['read', 'grep', 'find', 'ls'],
    systemPrompt: loadPrompt('plan'),
  },

  lsp: {
    displayName: 'LSP Agent',
    description: 'LSP 诊断与自动修复',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 20,
    builtinToolNames: ['bash'],
    systemPrompt: loadPrompt('lsp'),
  },

  commit: {
    displayName: 'Commit Agent',
    description: 'git commit',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 10,
    builtinToolNames: ['bash'],
    systemPrompt: loadPrompt('commit'),
  },

  doc: {
    displayName: 'Doc Agent',
    description: '生成文档',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 20,
    builtinToolNames: ['read', 'edit'],
    systemPrompt: loadPrompt('doc'),
  },

  search: {
    displayName: 'Search Agent',
    description: '语义代码搜索 (CodeGraph) + 网页搜索',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 15,
    builtinToolNames: ['bash', 'read', 'grep'],
    systemPrompt: loadPrompt('search'),
  },

  'general-purpose': {
    displayName: 'General Purpose Agent',
    description: '通用意图识别与任务分发',
    model: 'v4-flash',
    thinking: 'high',
    maxTurns: 3,
    builtinToolNames: [],
    systemPrompt: loadPrompt('scheduler'),
  },
};

/** Get all registered agent type names. */
export function getAgentTypeNames(): string[] {
  return Object.keys(AGENT_TYPES);
}

/** Get agent type config by name (case-insensitive). */
export function getAgentTypeConfig(name: string): AgentTypeConfig | undefined {
  const key = Object.keys(AGENT_TYPES).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? AGENT_TYPES[key] : undefined;
}

/**
 * Register all agent types with pi-subagents.
 * Called during Pi extension initialization.
 */
export function registerAgents(): void {
  try {
    const agentConfigs = new Map(
      Object.entries(AGENT_TYPES).map(([name, cfg]) => [
        name,
        {
          name,
          displayName: cfg.displayName,
          description: cfg.description,
          model: cfg.model,
          thinking: cfg.thinking === 'max' ? ('xhigh' as const) : ('high' as const),
          maxTurns: cfg.maxTurns,
          builtinToolNames: cfg.builtinToolNames,
          systemPrompt: cfg.systemPrompt,
          promptMode: 'replace' as const,
          extensions: true as const,
          skills: true as const,
        },
      ]),
    );

    registerPiSubagents(agentConfigs);
    console.log(`[yu-agent] Registered ${agentConfigs.size} agent types with pi-subagents`);
  } catch (err) {
    console.warn('[yu-agent] Failed to register agent types with pi-subagents:', err);
  }
}
