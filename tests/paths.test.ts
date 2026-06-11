/**
 * Unit tests — paths.ts path constants and utility functions.
 *
 * Verifies that all path constants resolve to the expected
 * locations under the user's home directory.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

describe('Path constants', () => {
  const HOME = homedir();

  it('YU_HOME resolves to ~/.yu', async () => {
    const { YU_HOME } = await import('../extension/paths.js');
    expect(YU_HOME).toBe(resolve(HOME, '.yu'));
  });

  it('MCP_CONFIG_PATH resolves to ~/.yu/mcp.config.json', async () => {
    const { MCP_CONFIG_PATH } = await import('../extension/paths.js');
    expect(MCP_CONFIG_PATH).toBe(resolve(HOME, '.yu', 'mcp.config.json'));
  });

  it('DATA_DIR resolves to ~/.yu/data', async () => {
    const { DATA_DIR } = await import('../extension/paths.js');
    expect(DATA_DIR).toBe(resolve(HOME, '.yu', 'data'));
  });

  it('PROMPTS_DIR resolves to ~/.yu/prompts', async () => {
    const { PROMPTS_DIR } = await import('../extension/paths.js');
    expect(PROMPTS_DIR).toBe(resolve(HOME, '.yu', 'prompts'));
  });

  it('PI_AGENT_DIR resolves to ~/.yu/agent', async () => {
    const { PI_AGENT_DIR } = await import('../extension/paths.js');
    expect(PI_AGENT_DIR).toBe(resolve(HOME, '.yu', 'agent'));
  });

  it('TEMP_DIR resolves to ~/.yu/data/temp', async () => {
    const { TEMP_DIR } = await import('../extension/paths.js');
    expect(TEMP_DIR).toBe(resolve(HOME, '.yu', 'data', 'temp'));
  });

  it('DECISIONS_FILE resolves to ~/.yu/data/decisions.json', async () => {
    const { DECISIONS_FILE } = await import('../extension/paths.js');
    expect(DECISIONS_FILE).toBe(resolve(HOME, '.yu', 'data', 'decisions.json'));
  });

  it('POOL_SESSIONS_DIR resolves to ~/.yu/pool-sessions', async () => {
    const { POOL_SESSIONS_DIR } = await import('../extension/paths.js');
    expect(POOL_SESSIONS_DIR).toBe(resolve(HOME, '.yu', 'pool-sessions'));
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', async () => {
    const { formatBytes } = await import('../extension/paths.js');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes in KB', async () => {
    const { formatBytes } = await import('../extension/paths.js');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats bytes in MB', async () => {
    const { formatBytes } = await import('../extension/paths.js');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(2097152)).toBe('2.0 MB');
  });

  it('formats bytes in GB', async () => {
    const { formatBytes } = await import('../extension/paths.js');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(1610612736)).toBe('1.5 GB');
  });

  it('handles small byte values (under 1024)', async () => {
    const { formatBytes } = await import('../extension/paths.js');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1)).toBe('1 B');
  });
});
