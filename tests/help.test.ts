/**
 * Unit tests — help.ts exports (HELP_TEXT, showHelpForCommand, getVersion)
 */

import { describe, expect, it } from 'bun:test'

describe('HELP_TEXT', () => {
  it('exports HELP_TEXT constant as a non-empty string', async () => {
    const { HELP_TEXT } = await import('../bin/help.js')
    expect(HELP_TEXT).toBeDefined()
    expect(typeof HELP_TEXT).toBe('string')
    expect(HELP_TEXT.length).toBeGreaterThan(100)
  })

  it('HELP_TEXT contains key command sections', async () => {
    const { HELP_TEXT } = await import('../bin/help.js')
    expect(HELP_TEXT).toContain('yu run')
    expect(HELP_TEXT).toContain('yu topic')
    expect(HELP_TEXT).toContain('yu supervisor')
    expect(HELP_TEXT).toContain('yu team')
    expect(HELP_TEXT).toContain('yu doctor')
    expect(HELP_TEXT).toContain('yu help')
    expect(HELP_TEXT).toContain('yu ui')
  })

  it('HELP_TEXT mentions ~/.yu/ directories', async () => {
    const { HELP_TEXT } = await import('../bin/help.js')
    expect(HELP_TEXT).toContain('~/.yu/')
    expect(HELP_TEXT).toContain('topics.db')
  })
})

describe('showHelpForCommand', () => {
  it('returns help text for "run" command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('run')
    expect(help).toContain('yu run')
    expect(help).toContain('scheduler')
  })

  it('returns help text for "topic" command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('topic')
    expect(help).toContain('yu topic')
    expect(help).toContain('topics.db')
  })

  it('returns help text for "help" command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('help')
    expect(help).toContain('yu help')
  })

  it('returns "unknown command" for unrecognized command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('nonexistent-command-xyz')
    expect(help).toContain('Unknown command')
  })

  it('returns help for "doctor" command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('doctor')
    expect(help).toContain('yu doctor')
    expect(help).toContain('health')
  })

  it('returns help for "supervisor" command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('supervisor')
    expect(help).toContain('yu supervisor')
    expect(help).toContain('child process')
  })

  it('returns help for "ui" command', async () => {
    const { showHelpForCommand } = await import('../bin/help.js')
    const help = showHelpForCommand('ui')
    expect(help).toContain('yu ui')
    expect(help).toContain('Web UI')
  })
})

describe('getVersion', () => {
  it('returns a non-empty version string', async () => {
    const { getVersion } = await import('../bin/help.js')
    const version = getVersion()
    expect(version).toBeDefined()
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  })

  it('returns consistent version on repeated calls', async () => {
    const { getVersion } = await import('../bin/help.js')
    const v1 = getVersion()
    const v2 = getVersion()
    expect(v1).toBe(v2)
  })
})
