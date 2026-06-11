/**
 * yu-agent — Team mode: Pi hook integration
 *
 * Registers beforeChat hooks for team-aware sessions.
 * When a session is registered as a team member, each turn
 * automatically injects mailbox messages into the agent's context.
 *
 * Hook registration happens via extension/index.ts.
 */

export { registerTeamSession, unregisterTeamSession, getTeamSession } from './session.js';
