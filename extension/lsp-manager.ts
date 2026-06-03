/**
 * yu-agent — LSP 服务器生命周期管理。
 *
 * 管理外部 LSP server 进程（stdio transport）：
 *   1. spawn 进程
 *   2. JSON-RPC initialize → initialized
 *   3. textDocument/didOpen → 接收 publishDiagnostics
 *   4. 定时心跳检测进程存活
 *   5. shutdown + exit 优雅退出
 *
 * 遵循 LSP 3.17 协议规范。
 */

import { createLogger } from './logger.js';
const log = createLogger('lsp-manager');

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Types ──────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
}

// ── Constants ──────────────────────────────────────────

const SEVERITY_MAP: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

const RESPONSE_TIMEOUT_MS = 8_000;
const DIAGNOSTICS_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// ── LSP Manager ────────────────────────────────────────

export class LspManager {
  private process: ChildProcess | null = null;
  private name = '';
  private rpcId = 0;
  private buffer = '';
  private pendingRequests = new Map<number, PendingRequest>();
  private diagnosticsResolve: ((value: unknown) => void) | null = null;
  private diagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Public API ──────────────────────────────────────

  /**
   * Start an LSP server.
   *
   * @param name - Display name for the server
   * @param command - Executable path
   * @param args - CLI arguments
   * @param rootPath - Project root directory (used for rootUri)
   */
  async start(
    name: string,
    command: string,
    args: string[],
    rootPath: string,
  ): Promise<void> {
    if (this.process) {
      throw new Error('LSP server already running');
    }

    this.name = name;

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.process = proc;

    // Handle stdout (LSP JSON-RPC messages)
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });

    // Handle process errors
    proc.on('error', (err) => {
      log.error(`${name} error`, err);
      this.rejectAllPending(err);
    });

    // Handle process exit
    proc.on('exit', (code, signal) => {
      log.warn(`${name} exited`, { code, signal });
      this.process = null;
      this.started = false;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      const err = new Error(`LSP server exited (code=${code}, signal=${signal})`);
      this.rejectAllPending(err);
    });

    // Discard stderr (LSP servers may log non-protocol output there)
    proc.stderr?.on('data', () => {
      // discard
    });

    // ── Initialize ──
    const rootUri = `file://${rootPath}`;
    const result = await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: {
            didOpen: true,
            didClose: true,
          },
        },
      },
    }) as Record<string, unknown>;

    // Send initialized notification (required by LSP protocol)
    this.sendNotification('initialized', {});

    this.started = true;

    // Start heartbeat to detect silent failures
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);

    log.info(`${name} initialized successfully`);
  }

  /**
   * Get diagnostics for a single file by opening it in the LSP server.
   *
   * @param filePath - Absolute or relative path to the file
   * @returns Array of diagnostic objects { file, error, line, level }
   */
  async getDiagnostics(filePath: string): Promise<Record<string, unknown>[]> {
    if (!this.process || !this.started) {
      throw new Error('LSP server not started');
    }

    const absPath = resolve(filePath);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, 'utf-8');

    // Set up promise that resolves when publishDiagnostics notification arrives
    const diagnosticsResult = await new Promise<unknown>((resolve) => {
      this.diagnosticsResolve = resolve;
      this.diagnosticsTimer = setTimeout(() => {
        this.diagnosticsResolve = null;
        this.diagnosticsTimer = null;
        // Timeout → return empty diagnostics (file may be fine or server may not support this file type)
        resolve({ params: { uri, diagnostics: [] } });
      }, DIAGNOSTICS_TIMEOUT_MS);

      // Open the file in the LSP server
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.getLanguageId(absPath),
          version: 1,
          text: content,
        },
      });
    });

    // Close the file to clean up server-side state
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });

    const result = diagnosticsResult as {
      params?: { uri: string; diagnostics: LspDiagnostic[] };
    };

    const diagnostics = result?.params?.diagnostics || [];

    // Filter out warnings (keep errors, infos, hints — consistent with original behavior)
    // and map to the expected shape { file, error, line, level }
    return diagnostics
      .filter((d) => (SEVERITY_MAP[d.severity ?? 2] ?? 'warning') !== 'warning')
      .map((d) => ({
        file: absPath,
        error: d.message,
        line: d.range.start.line + 1, // 1-indexed for display
        level: SEVERITY_MAP[d.severity ?? 2] || 'warning',
      }));
  }

  /**
   * Stop the LSP server gracefully.
   * Sends shutdown → exit, then force-kills if it doesn't stop within 2s.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 1. Send shutdown request
    try {
      await this.sendRequest('shutdown', null, 3_000);
    } catch {
      // Shutdown may timeout or fail — continue with exit
    }

    // 2. Send exit notification
    try {
      this.sendNotification('exit', {});
    } catch {
      // ignore
    }

    // 3. Wait for graceful exit, then force kill
    await new Promise<void>((resolve) => {
      if (!this.process || !this.process.pid) {
        resolve();
        return;
      }

      const killTimer = setTimeout(() => {
        try { this.process?.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 2_000);

      this.process.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });

    this.process = null;
    this.started = false;
    this.buffer = '';
    this.rejectAllPending(new Error('LSP server stopped'));
  }

  // ── Internal: LSP protocol (JSON-RPC over stdio) ─────

  private nextId(): number {
    return ++this.rpcId;
  }

  /**
   * Handle incoming data from the LSP server's stdout.
   * LSP uses Content-Length framing:
   *   Content-Length: <N>\r\n\r\n<JSON body of N bytes>
   */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    while (true) {
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1], 10);
      const headerEnd = (headerMatch.index ?? 0) + headerMatch[0].length;
      const totalLength = headerEnd + contentLength;

      if (this.buffer.length < totalLength) break; // incomplete message

      const body = this.buffer.slice(headerEnd, totalLength);
      this.buffer = this.buffer.slice(totalLength);

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch (e) {
        log.warn('Failed to parse LSP message', e);
      }
    }
  }

  /**
   * Route an incoming LSP message.
   * - Has `id` → response to a request
   * - Has `method` → notification (publishDiagnostics, etc.)
   */
  private handleMessage(msg: Record<string, unknown>): void {
    // Response to a previous request
    if (msg.id !== undefined && msg.id !== null) {
      const id = msg.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg.error) {
          const errorObj = msg.error as Record<string, string>;
          pending.reject(new Error(errorObj.message || 'LSP error'));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    // Notification: textDocument/publishDiagnostics
    if (msg.method === 'textDocument/publishDiagnostics' && this.diagnosticsResolve) {
      this.diagnosticsResolve(msg);
      this.diagnosticsResolve = null;
      if (this.diagnosticsTimer) {
        clearTimeout(this.diagnosticsTimer);
        this.diagnosticsTimer = null;
      }
    }
  }

  /**
   * Send a JSON-RPC message to the LSP server's stdin.
   */
  private sendMessage(msg: unknown): void {
    if (!this.process?.stdin) {
      throw new Error('LSP server stdin not available');
    }
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs = RESPONSE_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const msg = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (resp: unknown) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.sendMessage(msg);
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(method: string, params: unknown): void {
    const msg = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendMessage(msg);
  }

  /**
   * Derive the LSP languageId from the file extension and server name.
   */
  private getLanguageId(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();

    if (this.name.includes('typescript')) {
      if (ext === 'ts' || ext === 'tsx') return 'typescript';
      if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript';
      return 'typescript';
    }
    if (this.name.includes('pyright')) return 'python';
    if (this.name === 'gopls') return 'go';
    if (this.name.includes('rust')) return 'rust';
    return 'plaintext';
  }

  /**
   * Heartbeat check — verifies the LSP process is still alive.
   */
  private heartbeat(): void {
    if (!this.process?.pid || this.process.exitCode !== null) {
      this.started = false;
      return;
    }
    // Process is alive
  }

  /**
   * Reject all pending requests (used on shutdown or process crash).
   */
  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(err);
    }
    this.pendingRequests.clear();

    if (this.diagnosticsResolve) {
      this.diagnosticsResolve({ params: { diagnostics: [] } });
      this.diagnosticsResolve = null;
    }
    if (this.diagnosticsTimer) {
      clearTimeout(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
  }
}
