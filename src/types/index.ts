/**
 * 核心类型定义模块
 * 定义 agent、tool、llm、memory 等核心模块的公共类型
 */

/** LLM 提供商配置 */
export interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Agent 配置 */
export interface AgentConfig {
  name: string;
  llm: LLMConfig;
  tools: ToolDefinition[];
  systemPrompt?: string;
  maxIterations?: number;
}

/** 记忆条目 */
export interface MemoryItem {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Agent 执行状态 */
export type AgentStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';

/** Agent 执行结果 */
export interface AgentResult {
  status: AgentStatus;
  output: string;
  memory: MemoryItem[];
  error?: Error;
  duration: number;
}
