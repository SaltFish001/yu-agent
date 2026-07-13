/**
 * LLM 调用模块
 * 负责与大语言模型交互，支持多种提供商
 */

import type { LLMConfig, MemoryItem } from '../types/index.ts';

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** LLM 提供商接口 */
export interface LLMProvider {
  readonly name: string;
  chat(messages: MemoryItem[], config: LLMConfig): Promise<LLMResponse>;
}

/** LLM 管理器 */
export class LLMManager {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProvider: string = '';

  /** 注册 LLM 提供商 */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
  }

  /** 设置默认提供商 */
  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" is not registered`);
    }
    this.defaultProvider = name;
  }

  /** 发送聊天请求 */
  async chat(
    messages: MemoryItem[],
    config: LLMConfig,
    providerName?: string,
  ): Promise<LLMResponse> {
    const name = providerName || this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`LLM provider "${name}" not found`);
    }
    return provider.chat(messages, config);
  }

  /** 获取已注册的提供商列表 */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}

/** 全局 LLM 管理器单例 */
export const globalLLMManager = new LLMManager();
