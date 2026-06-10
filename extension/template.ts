/**
 * yu-agent — Output format validation.
 *
 * Each sub-agent must return JSON in a predefined format.
 * This module validates the output and returns a normalized result.
 */

/** Coding agent output schema. */
export interface CodingOutput {
  status: 'success' | 'partial' | 'failed';
  files_modified: string[];
  summary: string;
  details: { file: string; change: string }[];
}

/** Review agent output schema. */
export interface ReviewOutput {
  status: 'approved' | 'changes_requested';
  findings: { severity: 'high' | 'medium' | 'low'; file: string; line: number; message: string }[];
}

/** Search agent output schema. */
export interface SearchOutput {
  results: { source: 'codebase' | 'web'; path?: string; line?: number; snippet?: string; title?: string }[];
}

/** LSP agent output schema. */
export interface LspOutput {
  status: 'clean' | 'fixed' | 'unresolved';
  errors_fixed: { file: string; error: string; line: number }[];
  errors_remaining: { file: string; error: string; line: number; level: string }[];
}

/** Commit agent output schema. */
export interface CommitOutput {
  status: 'committed' | 'nothing_to_commit';
  hash?: string;
  message?: string;
}

/** Doc agent output schema. */
export interface DocOutput {
  status: 'success';
  files_written: string[];
}

/** Plan agent output schema. */
export interface PlanOutput {
  status: 'complete';
  summary: string;
  modules: { name: string; files: string[]; independent: boolean }[];
  risks?: string[];
}

export type AgentOutput = CodingOutput | ReviewOutput | SearchOutput | LspOutput | CommitOutput | DocOutput | PlanOutput;

/**
 * Scheduler output format (different from sub-agent output).
 */
export interface SchedulerOutput {
  pass_through?: boolean;
  reasoning?: string;
  intent?: string;
  agents?: { type: string; model: string; id: string; files?: string[]; task?: string }[];
  parallel_groups?: string[][];
  dependencies?: Record<string, string[]>;
}

/**
 * 修复 LLM 输出的常见 JSON 格式问题。
 * 复刻 Reasonix 的思路——先修复再解析，而不是直接放弃。
 * 修复步骤覆盖 LLM 最常见的 7 种 JSON 错误。
 */
function repairJSON(text: string): string {
  let s = text.trim();

  // Step 0: 提取 JSON 代码块（如果有的话）
  const blockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    s = blockMatch[1].trim();
  }

  // Step 1: 定位 JSON 区域——找第一个 { 或 [ 和匹配的闭合
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  const jsonStart = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)
    ? firstBrace : firstBracket;
  if (jsonStart < 0) return text; // 没有 JSON 结构，返回原文

  // 从末尾往前找匹配的闭合
  const lastBrace = s.lastIndexOf('}');
  const lastBracket = s.lastIndexOf(']');
  const jsonEnd = lastBrace > lastBracket ? lastBrace + 1 : lastBracket + 1;
  if (jsonEnd <= jsonStart) return text;

  s = s.slice(jsonStart, jsonEnd);

  try {
    // Step 2: 去掉注释（// 行注释 和 /* 块注释）
    s = s.replace(/\/\/[^\n]*/g, '');
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');

    // Step 3: 单引号替换为双引号
    // 注意：这只在简单的场景下工作，不会处理转义的单引号
    s = s.replace(/'/g, '"');

    // Step 4: Python 风格的字面量修正
    s = s.replace(/\bTrue\b/g, 'true');
    s = s.replace(/\bFalse\b/g, 'false');
    s = s.replace(/\bNone\b/g, 'null');

    // Step 5: 未加引号的键名加引号
    // 匹配 {key: 或 ,key: 模式的未引号键
    s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // Step 6: 去掉尾部逗号（数组中最后一个元素后，对象中最后一个属性后）
    s = s.replace(/,\s*([}\]])/g, '$1');

    // Step 7: 补全被截断的括号
    const ob = (s.match(/\{/g) || []).length;
    const cb = (s.match(/\}/g) || []).length;
    const oa = (s.match(/\[/g) || []).length;
    const ca = (s.match(/\]/g) || []).length;
    for (let i = 0; i < ob - cb; i++) s += '}';
    for (let i = 0; i < oa - ca; i++) s += ']';

    // Step 8: JavaScript 风格 undefined → null
    s = s.replace(/: undefined/g, ': null');
    s = s.replace(/:\s*"undefined"/g, ': null');
  } catch {
    // 修复过程不抛异常
  }

  return s;
}

/**
 * 尝试解析 agent 输出。修复 → 解析 两步走。
 */
export function parseAgentOutput(text: string): AgentOutput | null {
  // 先直接解析
  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  // 修复后再试
  const repaired = repairJSON(text);
  if (repaired !== text) {
    try {
      return JSON.parse(repaired);
    } catch {
      // noop
    }
  }

  // 从代码块提取后修复并解析
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      const blockRepaired = repairJSON(match[1]);
      try {
        return JSON.parse(blockRepaired);
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * 尝试解析 scheduler 输出。修复 → 解析 → 验证 三步走。
 */
export function parseSchedulerOutput(text: string): SchedulerOutput | null {
  // 先直接解析原始文本
  try {
    const obj = JSON.parse(text);
    if (typeof obj === 'object' && obj !== null) return obj as SchedulerOutput;
  } catch {
    // noop
  }

  // 修复后再试
  const repaired = repairJSON(text);
  if (repaired !== text) {
    try {
      const obj = JSON.parse(repaired);
      if (typeof obj === 'object' && obj !== null) return obj as SchedulerOutput;
    } catch {
      // noop
    }
  }

  // 从代码块提取后修复并解析
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    const blockRepaired = repairJSON(match[1]);
    try {
      const obj = JSON.parse(blockRepaired);
      if (typeof obj === 'object' && obj !== null) return obj as SchedulerOutput;
    } catch {
      return null;
    }
  }

  return null;
}
