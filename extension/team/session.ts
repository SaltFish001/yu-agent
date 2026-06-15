/**
 * yu-agent — Team mode: team-aware agent session
 *
 * Wraps SessionPool with mailbox polling for team members.
 * Before each prompt() call, polls the member's inbox for unread messages
 * and injects them as <peer_message> XML into the prompt.
 * After the prompt completes, acks the injected messages.
 *
 * Usage:
 *   const teamSession = new TeamSession(teamRunId, memberName);
 *   const result = await teamSession.call(task, spawnCfg);
 */

import type { SpawnResult } from '../spawn.js';
import { pollAndInject, ackMessages, resolveBaseDir, getStatePath } from './mailbox.js';
import { readFile } from 'node:fs/promises';
import { RuntimeStateSchema } from './types.js';

// ── Team-aware session wrapper ─────────────────────────

export class TeamSession {
  private turnMarker = 0;
  private lastInjectedTurnMarker: string | undefined;
  private pendingInjectedMessageIds: string[] = [];
  private baseDir: string;

  constructor(
    private teamRunId: string,
    private memberName: string,
  ) {
    this.baseDir = resolveBaseDir();
  }

  /**
   * Wrap a spawnAgent call with mailbox polling.
   * Returns the original SpawnResult with injected content metadata.
   */
  async call(originalCall: () => Promise<SpawnResult>): Promise<SpawnResult & { injectedMessages?: string[] }> {
    this.turnMarker++;
    const turnKey = `${this.memberName}-${this.turnMarker}`;

    // Step 1: Poll mailbox for new messages
    const inject = await pollAndInject(
      this.teamRunId,
      this.memberName,
      turnKey,
      this.lastInjectedTurnMarker,
      this.pendingInjectedMessageIds,
    );

    let injectedMessageIds: string[] = [];

    if (inject.injected && inject.content) {
      injectedMessageIds = inject.messageIds;

      // Step 2: Mark as pending in runtime state
      try {
        const stateContent = await readFile(getStatePath(this.baseDir, this.teamRunId), 'utf-8');
        const state = RuntimeStateSchema.parse(JSON.parse(stateContent));
        const member = state.members.find((m) => m.name === this.memberName);
        if (member) {
          this.pendingInjectedMessageIds = [
            ...new Set([...this.pendingInjectedMessageIds, ...inject.messageIds]),
          ];
        }
      } catch { /* runtime state transiently unavailable, proceed without it */ }

      // Step 3: Store last injected marker
      this.lastInjectedTurnMarker = turnKey;
    }

    // Step 4: Call the original agent
    const result = await originalCall();

    // Step 5: Ack messages that were injected this turn
    if (injectedMessageIds.length > 0) {
      await ackMessages(this.teamRunId, this.memberName, injectedMessageIds);
      this.pendingInjectedMessageIds = this.pendingInjectedMessageIds.filter(
        (id) => !injectedMessageIds.includes(id),
      );
    }

    return {
      ...result,
      injectedMessages: injectedMessageIds,
    };
  }

  /** Get the mailbox content to prepend to agent prompts */
  async getInjectedContent(): Promise<string | null> {
    const inject = await pollAndInject(
      this.teamRunId,
      this.memberName,
      `pre-${Date.now()}`,
      this.lastInjectedTurnMarker,
      this.pendingInjectedMessageIds,
    );

    if (inject.injected && inject.content) {
      return inject.content;
    }
    return null;
  }

  /** Inject mailbox content into a prompt string */
  async buildPrompt(task: string): Promise<string> {
    const mailboxContent = await this.getInjectedContent();
    if (mailboxContent) {
      return `${mailboxContent}\n\n${task}`;
    }
    return task;
  }
}

