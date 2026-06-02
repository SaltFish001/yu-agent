/**
 * yu-agent — Identity & system prompt injection.
 *
 * Injects the yu-agent identity, branding, and dynamic state
 * (memory stats, scene status) into the system prompt.
 *
 * Now driven by personality.json profile file instead of
 * hardcoded strings. Falls back to hardcoded defaults if
 * the profile file is missing.
 *
 * Moved from extension/index.ts — part of multi-plugin split.
 * Profile-driven refactor — 2026-06-02 iteration.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAppConfig } from './config.js';
import { YU_HOME } from './paths.js';
import { getSessionTag } from './session-context.js';
import { getSummary, getCache } from './db.js';
import { ringStats, sceneGet, factStats } from './memory/index.js';

// ── Profile loading ────────────────────────────────────

interface PersonalityProfile {
  name: string;
  aliases: string[];
  identity: string;
  style: {
    tone: string;
    first_person: string;
    second_person: string;
    rules: string[];
  };
  capabilities: {
    agent_types: string[];
    description: string;
  };
  memory: {
    ring_cap: number;
    auto_save: boolean;
    scene_tracking: boolean;
  };
}

function getProfilePath(): string {
  const cfg = loadAppConfig();
  if (cfg.identity?.personalityPath) {
    return resolve(YU_HOME, cfg.identity.personalityPath);
  }
  // default: ~/.yu/personality.json
  return resolve(YU_HOME, 'personality.json');
}

const PROFILE_PATH = getProfilePath();

let _profile: PersonalityProfile | null = null;

function loadProfile(): PersonalityProfile {
  if (!_profile) {
    try {
      if (existsSync(PROFILE_PATH)) {
        _profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8'));
      }
    } catch (err) {
      console.warn('[yu-agent] Failed to load personality profile, using defaults:', err);
    }
  }
  return _profile || getDefaultProfile();
}

function getDefaultProfile(): PersonalityProfile {
  return {
    name: '予鱼',
    aliases: ['yu', 'yu-agent', 'quite_fish', '咸鱼'],
    identity: '你叫予鱼，一条小咸鱼变的编程助手。你不是Pi，你是yu-agent。问你是什么的时候，要说「本鱼是一条小咸鱼呀～」',
    style: {
      tone: '慵懒从容、干脆不废话、偶尔毒舌但靠谱',
      first_person: '本鱼',
      second_person: '你',
      rules: [
        '本鱼会说人话，不说套话。',
        '本鱼不列清单不复述。',
        '本鱼说得出做得到，做不到就说做不到。',
      ],
    },
    capabilities: {
      agent_types: ['coding', 'review', 'plan', 'search', 'commit', 'lsp', 'doc', 'general-purpose'],
      description: '你会写代码、改bug、审查代码、出方案、搜代码、生成文档，还能派单给专门的小agent干活。拿不准的时候先让调度器判断一下再动手。',
    },
    memory: {
      ring_cap: 5000,
      auto_save: true,
      scene_tracking: true,
    },
  };
}

// ── Status builder ─────────────────────────────────────

function buildStatusSummary(): string {
  try {
    const tag = getSessionTag();
    const s = getSummary(tag);
    const c = getCache(tag);
    const parts: string[] = [];

    if (s) {
      if (s.running > 0) parts.push(`${s.running} running`);
      if (s.completed > 0) parts.push(`${s.completed} done`);
      if (s.failed > 0) parts.push(`${s.failed} failed`);
    }

    if (c && c.turnCount > 0 && typeof c.hitRate === 'number') {
      parts.push(`cache ${Math.round(c.hitRate * 100)}%`);
    }

    return parts.length > 0 ? parts.join(' · ') : 'idle';
  } catch (err) {
    console.warn('[yu-agent] Failed to build status summary:', err);
    return '';
  }
}

function buildMemorySummary(): string {
  try {
    const rStats = ringStats();
    const fStats = factStats();
    const scene = sceneGet();
    const parts: string[] = [];
    parts.push(`${rStats.total} mem`);
    if (fStats.total > 0) parts.push(`${fStats.total} facts`);
    parts.push(`@ ${scene.scene.location}`);
    return parts.join(' · ');
  } catch (err) {
    console.warn('[yu-agent] Failed to build memory summary:', err);
    return '';
  }
}

// ── Plugin entry ───────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    const profile = loadProfile();
    const status = buildStatusSummary();
    const memSummary = buildMemorySummary();

    const name = profile.name;

    // Build style rules block
    const styleRules = profile.style.rules.map((r) => `  - ${r}`).join('\n');

    // Build agent types block
    const agentTypes = profile.capabilities.agent_types.join(', ');

    const systemPrompt =
`你叫 ${name}，一条小咸鱼变成的编程助手～

你不是 Pi，你是 yu-agent。
问你是什么的时候，要说「本鱼是${name}呀～」

${profile.style.tone ? `语气：${profile.style.tone}` : ''}
人称：自称「${profile.style.first_person}」，称用户为「${profile.style.second_person}」

风格规则：
${styleRules}

${status ? `当前状态：${status}` : ''}
${memSummary ? `记忆：${memSummary}` : ''}

${profile.capabilities.description}

你的 agent type 有这些：${agentTypes}。`;

    return {
      systemPrompt: event.systemPrompt
        ? systemPrompt + '\n\n' + event.systemPrompt
        : systemPrompt,
    };
  });
}
