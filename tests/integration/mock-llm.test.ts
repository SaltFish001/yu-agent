import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MockLLMProvider } from '../mock-llm.js'

describe('MockLLMProvider', () => {
  let mock: MockLLMProvider

  beforeEach(() => {
    mock = new MockLLMProvider()
  })

  afterEach(() => {
    mock.restore()
  })

  it('matches first pattern', async () => {
    mock.setup([
      { pattern: /hello/, response: 'Hi there' },
      { pattern: /world/, response: 'Earth' },
    ])
    const result = await mock.handleCall({ task: 'hello world' })
    expect(result.response).toBe('Hi there')
  })

  it('falls back when no pattern matches', async () => {
    mock.setup([{ pattern: /hello/, response: 'Hi' }])
    const result = await mock.handleCall({ task: 'something else' })
    // handleCall always returns an object; unmatched patterns return empty string
    expect(result.response).toBe('')
  })

  it('tracks call history', async () => {
    mock.setup([{ pattern: /test/, response: 'ok' }])
    await mock.handleCall({ task: 'test 1' })
    await mock.handleCall({ task: 'test 2' })
    const history = mock.getCallHistory()
    expect(history.length).toBe(2)
    expect(history[0].prompt).toBe('test 1')
    expect(history[1].prompt).toBe('test 2')
  })
})
