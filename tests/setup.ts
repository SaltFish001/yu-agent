/**
 * Test setup — runs before each test file via vitest.config.ts setupFiles.
 *
 * Provides isolated environment variables and filesystem sandbox so
 * integration tests don't touch the user's real ~/.yu/ directory.
 */

import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, afterAll } from 'vitest';
import { closeDb } from '../extension/db.js';

/** Isolated test directory per worker under the project root. */
const poolId = process.env.VITEST_POOL_ID || '0';
const TEST_DIR = resolve(process.cwd(), `.yu-test-${poolId}`);
const TEST_STATUS_DIR = resolve(TEST_DIR, '.yu-agent', 'status');

beforeAll(() => {
  // Point all yu-agent paths to the isolated test directory
  process.env.YU_SESSION_ID = 'test-integration';
  process.env.YU_PROJECT_DIR = TEST_DIR;

  // Ensure the status directory exists (getDbPath() will try to create it,
  // but we do it here explicitly for predictable setup)
  if (!existsSync(TEST_STATUS_DIR)) {
    mkdirSync(TEST_STATUS_DIR, { recursive: true });
  }
});

afterAll(() => {
  // Close the DB singleton so the file handle is released
  closeDb();

  // Clean up the test directory
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
