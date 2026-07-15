import { describe, it, expect } from 'bun:test';
import { Agent, createAgent } from '../src/agent/index.ts';
import type { AgentConfig } from '../src/types/index.ts';

describe('Agent', () => {
  const baseConfig: AgentConfig = {
    name: 'test-agent',
    llm: {
      provider: 'test',
      model: 'test-model',
    },
    tools: [],
  };

  it('should create agent with factory function', () => {
    const agent = createAgent(baseConfig);
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.name).toBe('test-agent');
    expect(agent.getState()).toBe('idle');
  });

  it('should have correct initial state', () => {
    const agent = new Agent(baseConfig);
    expect(agent.getState()).toBe('idle');
    expect(agent.getMemory()).toEqual([]);
  });

  it('should reset correctly', () => {
    const agent = new Agent(baseConfig);
    agent.run('test input').catch(() => {}); // ignore error (no LLM provider)
    agent.reset();
    expect(agent.getState()).toBe('idle');
    expect(agent.getMemory()).toEqual([]);
  });

  it('should handle empty name gracefully', () => {
    const config: AgentConfig = { ...baseConfig, name: '' };
    const agent = new Agent(config);
    expect(agent.name).toBe('');
  });
});
