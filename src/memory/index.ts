/**
 * 记忆管理模块
 * 负责 Agent 对话历史的存储、检索和管理
 */

import type { MemoryItem } from '../types/index.ts';

/** 记忆存储接口 */
export interface MemoryStore {
  save(item: MemoryItem): Promise<void>;
  saveMany(items: MemoryItem[]): Promise<void>;
  get(id: string): Promise<MemoryItem | null>;
  getAll(sessionId?: string): Promise<MemoryItem[]>;
  delete(id: string): Promise<boolean>;
  clear(sessionId?: string): Promise<void>;
}

/** 内存记忆存储（默认实现） */
export class InMemoryStore implements MemoryStore {
  private items: MemoryItem[] = [];

  async save(item: MemoryItem): Promise<void> {
    this.items.push(item);
  }

  async saveMany(items: MemoryItem[]): Promise<void> {
    this.items.push(...items);
  }

  async get(id: string): Promise<MemoryItem | null> {
    return this.items.find(item => item.id === id) ?? null;
  }

  async getAll(_sessionId?: string): Promise<MemoryItem[]> {
    return [...this.items];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  async clear(_sessionId?: string): Promise<void> {
    this.items = [];
  }
}

/** 记忆管理器 */
export class MemoryManager {
  private store: MemoryStore;

  constructor(store?: MemoryStore) {
    this.store = store ?? new InMemoryStore();
  }

  /** 添加一条记忆 */
  async add(item: Omit<MemoryItem, 'id' | 'timestamp'>): Promise<MemoryItem> {
    const fullItem: MemoryItem = {
      ...item,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    await this.store.save(fullItem);
    return fullItem;
  }

  /** 获取所有记忆 */
  async getAll(): Promise<MemoryItem[]> {
    return this.store.getAll();
  }

  /** 获取最近的 N 条记忆 */
  async getRecent(n: number): Promise<MemoryItem[]> {
    const all = await this.store.getAll();
    return all.slice(-n);
  }

  /** 清空记忆 */
  async clear(): Promise<void> {
    await this.store.clear();
  }

  /** 获取记忆数量 */
  async count(): Promise<number> {
    const all = await this.store.getAll();
    return all.length;
  }
}
