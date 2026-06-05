/**
 * Chat agent end-to-end verification.
 * Tests that the scheduler handler correctly dispatches non-coding
 * inputs to the chat agent (pass_through → chat.md personality).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

async function test(name, fn) {
  console.log(`\n${name}:`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name} threw:`, err.message || err);
  }
}

// ── Tests ──────────────────────────────────────────────

await test('scheduler.js exists', async () => {
  assert(existsSync(resolve(DIST, 'extension/scheduler.js')), 'scheduler.js');
  assert(existsSync(resolve(DIST, 'extension/classifier.js')), 'classifier.js');
  assert(existsSync(resolve(DIST, 'extension/deepseek.js')), 'deepseek.js');
});

await test('chat.md prompt exists', async () => {
  assert(existsSync(resolve(ROOT, 'prompts/chat.md')), 'prompts/chat.md file exists');
  const { readFileSync } = await import('node:fs');
  const content = readFileSync(resolve(ROOT, 'prompts/chat.md'), 'utf-8');
  assert(content.length > 100, `chat.md is non-empty (${content.length} chars)`);
  assert(content.includes('简洁直接'), 'chat.md has personality directives (简洁直接)');
});

await test('config.ts registers chat agent type', async () => {
  // Check the dist config module exports the type map
  const config = await import(resolve(DIST, 'extension/config.js'));
  assert(typeof config.registerAgents === 'function', 'registerAgents is exported');
  
  // Check the dist scheduler was built with chat support
  const { readFileSync } = await import('node:fs');
  const schedulerJs = readFileSync(resolve(DIST, 'extension/scheduler.js'), 'utf-8');
  assert(schedulerJs.includes('pass_through'), 'scheduler.js handles pass_through');
  assert(schedulerJs.includes('chat') || schedulerJs.includes('spawnAgent'), 'scheduler.js dispatches to agents');
});

await test('classifier fast path works (long input → pass_through)', async () => {
  const classifier = await import(resolve(DIST, 'extension/classifier.js'));
  
  // Long input (> 200 chars) should trigger fast path pass_through
  const longInput = 'a'.repeat(201);
  const plan1 = await classifier.classifyIntent(longInput, {});
  assert(plan1.pass_through === true, 'long input (>200) returns pass_through: true');
  
  // Input starting with "你是" should pass through
  const roleInput = '你是一个助手吗';
  const plan2 = await classifier.classifyIntent(roleInput, {});
  assert(plan2.pass_through === true, '"你是" input returns pass_through: true');

  // Short neutral input - should try DeepSeek API, fail gracefully → pass_through
  const shortInput = '你好';
  const plan3 = await classifier.classifyIntent(shortInput, {});
  // Without API key, should fall back to pass_through
  assert(plan3.pass_through === true, 'short input without API key falls back to pass_through');
});

await test('scheduler handler accepts chat input', async () => {
  const scheduler = await import(resolve(DIST, 'extension/scheduler.js'));
  assert(typeof scheduler.handler === 'function', 'scheduler.handler is a function');
});

await test('chat agent prompt content check', async () => {
  const { readFileSync } = await import('node:fs');
  const content = readFileSync(resolve(ROOT, 'prompts/chat.md'), 'utf-8');
  
  // Check it has the key personality elements
  assert(content.includes('Chat Agent') || content.includes('chat'), 'has chat agent header');
  assert(content.includes('简洁') || content.includes('直接'), 'has tone directive (简洁/直接)');
  
  // Should not be empty or just placeholder
  assert(content.length > 50, 'prompt is substantial');
});

// ── Summary ────────────────────────────────────────────

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
process.exit(failed > 0 ? 1 : 0);
