/**
 * Unit tests — template.ts (output parsing & JSON repair).
 *
 * Tests parseAgentOutput with various malformed JSON patterns
 * that LLMs commonly produce.
 */

import { describe, expect, it } from 'bun:test'
import { parseAgentOutput } from '../extension/template.js'

describe('parseAgentOutput', () => {
  it('parses a valid coding output', () => {
    const input = JSON.stringify({
      status: 'success',
      files_modified: ['src/index.ts'],
      summary: 'Fixed bug',
      details: [{ file: 'src/index.ts', change: 'Fixed' }],
    })
    const result = parseAgentOutput(input)
    expect(result).not.toBeNull()
    if (result && 'status' in result) {
      expect((result as { status: string }).status).toBe('success')
    }
  })

  it('repairs and parses malformed agent output', () => {
    const input = "{status: 'success', files_modified: ['src/a.ts']}"
    const result = parseAgentOutput(input)
    expect(result).not.toBeNull()
    if (result && 'status' in result) {
      expect((result as { status: string }).status).toBe('success')
    }
  })

  it('returns null for completely invalid input', () => {
    expect(parseAgentOutput('nope')).toBeNull()
  })
})
