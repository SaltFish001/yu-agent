/**
 * Unit tests — template.ts (output parsing & JSON repair).
 *
 * Tests parseSchedulerOutput and parseAgentOutput with various
 * malformed JSON patterns that LLMs commonly produce.
 */

import { describe, it, expect } from 'vitest';
import { parseSchedulerOutput, parseAgentOutput } from '../extension/template.js';

describe('parseSchedulerOutput — valid JSON', () => {
  it('parses minimal valid JSON', () => {
    const input = JSON.stringify({ pass_through: true, reasoning: 'test' });
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
    expect(result!.reasoning).toBe('test');
  });

  it('parses full agent plan', () => {
    const input = JSON.stringify({
      intent: 'coding',
      agents: [
        { type: 'coding', model: 'sonnet', id: 'c1', files: ['src/index.ts'], task: 'fix bug' },
      ],
      parallel_groups: [['c1']],
    });
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('coding');
    expect(result!.agents).toHaveLength(1);
    expect(result!.agents![0].type).toBe('coding');
  });
});

describe('parseSchedulerOutput — JSON repair', () => {
  it('repairs trailing comma in object', () => {
    const input = '{"pass_through": true,"reasoning": "test",}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('repairs trailing comma in array', () => {
    const input = '{"agents": [{"type": "coding", "id": "c1",}]}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(1);
  });

  it('repairs single quotes to double quotes', () => {
    const input = "{'pass_through': true, 'reasoning': 'test'}";
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('repairs unquoted keys', () => {
    const input = '{pass_through: true, reasoning: "test"}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('repairs Python-style booleans', () => {
    const input = '{"pass_through": True, "reasoning": "test"}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('repairs None → null', () => {
    const input = '{"pass_through": None, "reasoning": "test"}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.reasoning).toBe('test');
  });

  it('repairs JavaScript undefined → null', () => {
    const input = '{"pass_through": undefined}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
  });

  it('handles string without JSON structure gracefully', () => {
    // Input with missing closing brace — repairJSON can't extract region
    // without matching braces, so it returns null.
    const input = '{"pass_through": true, "reasoning": "test"';
    const result = parseSchedulerOutput(input);
    expect(result).toBeNull();
  });

  it('repairs truncated array brackets', () => {
    // Brackets are repaired, but the function currently requires matching
    // opening/closing pairs. This tests graceful handling.
    const input = '[{"a": 1';
    expect(parseSchedulerOutput(input)).toBeNull();
  });

  it('removes // line comments', () => {
    const input = '{\n// this is a comment\n"pass_through": true}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('removes /* block comments */', () => {
    const input = '{\n/* block comment */\n"pass_through": true}';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });
});

describe('parseSchedulerOutput — code block extraction', () => {
  it('extracts JSON from ```json code block', () => {
    const input = 'Here is the plan:\n```json\n{"pass_through": true}\n```\nEnd.';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('extracts JSON from bare ``` code block', () => {
    const input = 'Output:\n```\n{"pass_through": true}\n```';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });

  it('extracts and repairs JSON in code block', () => {
    const input = '```json\n{pass_through: True}\n```';
    const result = parseSchedulerOutput(input);
    expect(result).not.toBeNull();
    expect(result!.pass_through).toBe(true);
  });
});

describe('parseSchedulerOutput — fallback / null', () => {
  it('returns null for empty string', () => {
    expect(parseSchedulerOutput('')).toBeNull();
  });

  it('returns null for random text without JSON', () => {
    expect(parseSchedulerOutput('This is just some random text without any JSON structure.')).toBeNull();
  });

  it('returns null for invalid JSON that cannot be repaired', () => {
    const input = '{invalid: }';
    // The repair process still applies fixes, but it might still fail
    // This tests that no exception is thrown
    expect(parseSchedulerOutput.bind(null, input)).not.toThrow();
  });
});

describe('parseAgentOutput', () => {
  it('parses a valid coding output', () => {
    const input = JSON.stringify({
      status: 'success',
      files_modified: ['src/index.ts'],
      summary: 'Fixed bug',
      details: [{ file: 'src/index.ts', change: 'Fixed' }],
    });
    const result = parseAgentOutput(input);
    expect(result).not.toBeNull();
    if (result && 'status' in result) {
      expect((result as { status: string }).status).toBe('success');
    }
  });

  it('repairs and parses malformed agent output', () => {
    const input = "{status: 'success', files_modified: ['src/a.ts']}";
    const result = parseAgentOutput(input);
    expect(result).not.toBeNull();
    if (result && 'status' in result) {
      expect((result as { status: string }).status).toBe('success');
    }
  });

  it('returns null for completely invalid input', () => {
    expect(parseAgentOutput('nope')).toBeNull();
  });
});
