/**
 * MockLLMProvider — utility for mocking LLM responses in integration tests.
 *
 * Works with vi.mock() at module level. Test files must set up:
 *
 *   import { mockLLMInstance, MockLLMProvider } from '../mock-llm.js';
 *
 *   vi.mock('../extension/spawn.js', () => ({
 *     spawnAgent: (config) => mockLLMInstance!.handleCall(config),
 *   }));
 *
 * Then in tests:
 *
 *   const mock = new MockLLMProvider();
 *   mock.setup([{ pattern: /fix/, response: '{"pass_through": false}' }]);
 *   mock.install();
 *   // ... run code under test ...
 *   expect(mock.getCallHistory()).toHaveLength(1);
 *   mock.restore();
 */

// Global reference — assigned by install(), read by vi.mock() factory closures.
// Module-level `let` means closures capture the *variable*, not its value,
// so vi.mock() factories see the latest instance even though mock is hoisted.
export let mockLLMInstance: MockLLMProvider | null = null

export class MockLLMProvider {
  private responses: Array<{ pattern: RegExp; response: string }> = []
  public callHistory: Array<{ prompt: string; matched: string }> = []
  private installed = false

  /**
   * Set the response patterns. Each pattern is tested in order against the
   * input prompt; the first match wins. If no pattern matches, returns empty
   * response.
   */
  setup(responses: Array<{ pattern: RegExp; response: string }>): void {
    this.responses = responses
    this.callHistory = []
  }

  /** Activate this mock instance globally. */
  install(): void {
    if (this.installed) return
    this.installed = true
    mockLLMInstance = this
  }

  /** Deactivate and clear all state. */
  restore(): void {
    this.installed = false
    this.responses = []
    this.callHistory = []
    mockLLMInstance = null
  }

  /**
   * Handle a spawn call. Called from the vi.mock() factory in test files.
   * Matches the input prompt against configured patterns.
   */
  async handleCall(config: {
    task: string
    type?: string
    model?: string
    maxTurns?: number
    context?: Record<string, unknown>
    timeout?: number
  }): Promise<{ response: string }> {
    const prompt = config.task
    for (const { pattern, response } of this.responses) {
      if (pattern.test(prompt)) {
        this.callHistory.push({ prompt, matched: response })
        return { response }
      }
    }
    this.callHistory.push({ prompt, matched: '' })
    return { response: '' }
  }

  getCallHistory(): Array<{ prompt: string; matched: string }> {
    return this.callHistory
  }

  clearCallHistory(): void {
    this.callHistory = []
  }
}
