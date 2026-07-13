/**
 * Unit tests — lsp-manager.ts (LSP lifecycle management)
 *
 * LspManager manages external LSP processes over stdio.
 * These tests cover instantiation and state-guard logic.
 * Full process lifecycle testing belongs in integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

describe('LspManager', () => {
  it('can be instantiated', async () => {
    const { LspManager } = await import('../extension/lsp-manager.js')
    const manager = new LspManager()
    expect(manager).toBeInstanceOf(LspManager)
  })

  it('getDiagnostics throws when not started', async () => {
    const { LspManager } = await import('../extension/lsp-manager.js')
    const manager = new LspManager()
    await expect(manager.getDiagnostics('/tmp/test.ts')).rejects.toThrow('LSP server not started')
  })
})
