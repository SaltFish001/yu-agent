import { createLogger } from "./logger.js";

export class ShutdownManager {
  private shuttingDown = false;
  private handlers: Array<() => Promise<void>> = [];
  private runningAgents = new Set<string>();
  private log = createLogger("lifecycle");

  registerHandler(name: string, handler: () => Promise<void>): void {
    this.handlers.push(handler);
  }

  agentStarted(id: string): void {
    this.runningAgents.add(id);
  }

  agentFinished(id: string): void {
    this.runningAgents.delete(id);
  }

  get runningCount(): number {
    return this.runningAgents.size;
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info(`Received ${signal}, starting graceful shutdown`);

    // 1. Drain running agents with timeout
    if (this.runningAgents.size > 0) {
      this.log.info(`Draining ${this.runningAgents.size} running agents`);
      await Promise.race([
        this.waitForAgents(30_000),
        new Promise<void>((r) => setTimeout(r, 30_000)),
      ]);
    }

    // 2. Run registered handlers
    for (const handler of this.handlers) {
      try {
        await handler();
      } catch (err) {
        this.log.error("Handler failed during shutdown", err, { handler: handler.name });
      }
    }

    this.log.info("Graceful shutdown complete");
  }

  private waitForAgents(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.runningAgents.size === 0) return resolve();
        setTimeout(check, 100);
      };
      check();
    });
  }
}

export const shutdownManager = new ShutdownManager();
