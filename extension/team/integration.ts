/**
 * yu-agent — Team mode: Pi hook integration
 *
 * Registers beforeChat hooks for team-aware sessions.
 * When a session is registered as a team member, each turn
 * automatically injects mailbox messages into the agent's context.
 *
 * Hook registration happens via extension/index.ts.
 */

import {
  registerTeamSession,
  unregisterTeamSession,
  getTeamSession,
} from './session.js';

export { registerTeamSession, unregisterTeamSession, getTeamSession } from './session.js';

/**
 * Hook context expected from Pi's beforeChat hook.
 */
interface BeforeChatHookCtx {
  message: string;
  session: { id: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Hook result for beforeChat.
 */
interface HookResult {
  action: 'respond' | 'pass_through';
  content?: string;
}

/**
 * Create a beforeChat hook handler that injects team mailbox messages.
 *
 * This hook runs BEFORE the main scheduler hook. It checks if the current
 * session is registered as a team member, and if so, polls the mailbox
 * and prepends unread messages to the user's input.
 *
 * Registration:
 *   pi.hooks.register('beforeChat', {
 *     name: 'yu-agent-team',
 *     description: 'Team mailbox message injection',
 *     handler: createTeamMailboxHook(),
 *   });
 */
export function createTeamMailboxHook() {
  return async (context: BeforeChatHookCtx): Promise<HookResult | null> => {
    const sessionId = context.session?.id;
    if (!sessionId) return null;

    const teamSession = getTeamSession(sessionId);
    if (!teamSession) return null;

    // Inject mailbox content by modifying the message
    const injected = await teamSession.getInjectedContent();
    if (injected) {
      // Prepend mailbox messages to the user's message
      (context as Record<string, unknown>).message = `${injected}\n\n${context.message}`;
    }

    // Pass through — let the main scheduler handler process the message
    return null;
  };
}

/**
 * Track which sessions are team members for external registration.
 * Call this when spawning a team member agent.
 */
export async function trackTeamMemberSession(
  sessionId: string,
  teamRunId: string,
  memberName: string,
): Promise<void> {
  registerTeamSession(sessionId, { teamRunId, memberName });
}

/**
 * Cleanup team session tracking when a session ends.
 */
export async function cleanupTeamSession(sessionId: string): Promise<void> {
  unregisterTeamSession(sessionId);
}
