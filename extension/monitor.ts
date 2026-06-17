/**
 * yu-agent — Monitor (Pi-free stub)
 *
 * Phase 3: Pi SDK removed. TUI monitor was Pi-dependent.
 * The Web UI (webui/server.ts) replaces the monitor functionality.
 */

import { createLogger } from './logger.js'

const log = createLogger('monitor')

export function setupMonitor(): void {
  log.info('TUI monitor disabled (use "yu ui" for Web UI)')
}
