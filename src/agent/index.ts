/**
 * Agent 核心模块
 * 负责 Agent 的生命周期管理、执行循环和状态控制
 */

import type { AgentConfig, AgentResult, AgentStatus, MemoryItem } from '../types/index.ts';

/** Agent 实例 */
export class Agent {
  private config: AgentConfig;
  private status: AgentStatus = 'idle';
  private memory: MemoryItem[] = [];
  private startTime = 0;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** 获取 Agent 名称 */
  get name(): string {
    return this.config.name;
  }

  /** 获取当前状态 */
  getState(): AgentStatus {
    return this.status;
  }

  /** 获取记忆历史 */
  getMemory(): MemoryItem[] {
    return [...this.memory];
  }

  /** 执行 Agent 循环 */
  async run(input: string): Promise<AgentResult> {
    this.status = 'running';
    this.startTime = Date.now();

    try {
      // 添加用户输入到记忆
      this.memory.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: input,
        timestamp: Date.now(),
      });

      // TODO: 调用 LLM 生成回复
      // TODO: 执行工具调用
      // TODO: 处理工具结果

      this.status = 'completed';
      return {
        status: 'completed',
        output: `Agent ${this.config.name} processed: ${input}`,
        memory: this.getMemory(),
        duration: Date.now() - this.startTime,
      };
    } catch (error) {
      this.status = 'error';
      return {
        status: 'error',
        output: '',
        memory: this.getMemory(),
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - this.startTime,
      };
    }
  }

  /** 重置 Agent 状态 */
  reset(): void {
    this.status = 'idle';
    this.memory = [];
    this.startTime = 0;
  }
}

/** 创建 Agent 实例的工厂函数 */
export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
