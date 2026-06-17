/**
 * Unit tests — classifier.ts (intent classification & fallback).
 *
 * Tests the fast path and fallback logic in classifyIntent.
 * These tests work whether or not a DeepSeek API key is configured.
 */

import { describe, expect, it } from 'bun:test'
import { classifyIntent } from '../extension/classifier.js'

describe('classifyIntent — fast path (no API call)', () => {
  it('returns pass_through for long input (>200 chars)', async () => {
    const longInput = 'a'.repeat(201)
    const plan = await classifyIntent(longInput, {})
    expect(plan.pass_through).toBe(true)
  })

  it('returns pass_through for "你是" input', async () => {
    const plan = await classifyIntent('你是一个助手吗', {})
    expect(plan.pass_through).toBe(true)
  })

  it('returns a valid plan for short input', async () => {
    const plan = await classifyIntent('hello', {})
    expect(plan).toBeTruthy()
    expect(plan.pass_through === true || typeof plan.intent === 'string').toBe(true)
  })
})

describe('classifyIntent — fallback behavior', () => {
  it('returns a valid plan for any input', async () => {
    const plan = await classifyIntent('hello world', {})
    expect(plan).toBeTruthy()
  })

  it('handles empty input gracefully', async () => {
    const plan = await classifyIntent('', {})
    expect(plan).toBeTruthy()
  })

  it('handles single-word input', async () => {
    const plan = await classifyIntent('test', {})
    expect(plan).toBeTruthy()
  })
})
