/**
 * 工具注册与管理模块
 * 负责工具的注册、查找和执行
 */

import type { ToolDefinition } from '../types/index.ts';

/** 工具注册表 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /** 注册一个工具 */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 批量注册工具 */
  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 获取已注册的工具列表 */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 根据名称查找工具 */
  find(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 执行指定工具 */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }
    return tool.handler(args);
  }

  /** 取消注册一个工具 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 清空所有工具 */
  clear(): void {
    this.tools.clear();
  }

  /** 获取已注册的工具数量 */
  get size(): number {
    return this.tools.size;
  }
}

/** 全局工具注册表单例 */
export const globalToolRegistry = new ToolRegistry();
