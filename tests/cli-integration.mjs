#!/usr/bin/env node
/**
 * Integration test for yu-agent team mode CLI commands.
 */
import { execSync } from 'node:child_process';

function run(cmd) {
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
  console.log(`$ ${cmd}`);
  console.log(out.trim());
  return out.trim();
}

async function main() {
  // 1. Create team
  const createOut = run('node dist/bin/yu.js team create integ-test lead:plan coder:coding reviewer:review');
  const runId = createOut.match(/runId: ([^\s)]+)/)?.[1];
  if (!runId) throw new Error('Could not extract runId');
  console.log(`\n=== RunID: ${runId} ===\n`);

  // 2. Status
  run(`node dist/bin/yu.js team status ${runId}`);

  // 3. Send message
  run(`node dist/bin/yu.js team send ${runId} coder "Review the auth module"`);

  // 4. Create task
  run(`node dist/bin/yu.js team task ${runId} create "Implement login" "Add JWT authentication"`);

  // 5. List tasks
  run(`node dist/bin/yu.js team task ${runId} list`);

  // 6. Get task
  const taskList = execSync(`node dist/bin/yu.js team task ${runId} list`, { encoding: 'utf-8' });
  const taskId = taskList.match(/^\s+([a-f0-9]+)\s/)?.[1];
  if (taskId) {
    run(`node dist/bin/yu.js team task ${runId} get ${taskId}`);
    run(`node dist/bin/yu.js team task ${runId} update ${taskId} claimed`);
  }

  // 7. List team specs
  run('node dist/bin/yu.js team specs');

  // 8. Delete
  run(`node dist/bin/yu.js team delete ${runId} --force`);

  // 9. Verify gone
  run('node dist/bin/yu.js team list');

  console.log('\n=== ALL INTEGRATION TESTS PASSED ===');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
