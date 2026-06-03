/**
 * yu-agent — MCP 服务器生命周期管理。
 *
 * 管理外部 MCP server 进程（stdio transport）：
 *   1. 读 mcp.config.json → spawn 进程
 *   2. JSON-RPC initialize + tools/list → 确认存活
 *   3. 定时心跳检测（进程是否在跑）
 *   4. 写状态到 status/mcp.json，供 monitor 显示
 *
 * MCP 配置格式（标准 MCP config，兼容 Cursor/Claude 等）：
 *   {
 *     "servers": {
 *       "server-name": {
 *         "command": "npx",
 *         "args": ["-y", "@some/mcp-server"],
 *         "env": { "KEY": "value" }
 *       }
 *     }
 *   }
 */

import { createLogger } from './logger.js';
const log = createLogger('mcp-manager');

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import {
  type MCPServerStatus,
  writeMCPStatus,
} from './status.js';
import { MCP_CONFIG_PATH } from './paths.js';

// ── 常量 ──────────────────────────────────────────────

const STATUS_WRITE_INTERVAL_MS = 5_000;
const PING_INTERVAL_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 5_000;

// ── 安全校验 ──────────────────────────────────────────

/**
 * 白名单正则：只允许字母、数字、_ - . : / = @ % + ~ , # ! 以及空格。
 * 禁止 shell 敏感字符：; | $ ( ) ` { } [ ] & > < \n \r \0
 */
const SAFE_VALUE_RE = /^[a-zA-Z0-9_\-.:/=@%+~,#! ]+$/;

/**
 * 禁止覆盖的危险环境变量（校验时转大写比较）。
 * 攻击者可通过覆盖这些变量劫持进程加载恶意代码。
 */
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_PATH',
  'NODE_OPTIONS',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PERL5LIB',
  'RUBYLIB',
  'RUBYOPT',
  'BASH_ENV',
  'IFS',
  'SHELLOPTS',
  'BASHOPTS',
]);

/**
 * 校验 env 配置：禁止覆盖危险变量，禁止 value 含 shell 敏感字符，禁止非法 key。
 * @throws 校验不通过时抛出 Error
 */
function sanitizeEnv(
  userEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!userEnv) return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(userEnv)) {
    // 校验 key 格式（POSIX 环境变量名）
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }

    // 检查是否在禁止列表中（大小写不敏感）
    if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
      throw new Error(
        `Environment variable "${key}" is blocked and cannot be overridden`,
      );
    }

    // 校验 value 白名单
    if (!SAFE_VALUE_RE.test(value)) {
      throw new Error(
        `Environment variable "${key}" contains unsafe characters`,
      );
    }

    result[key] = value;
  }
  return result;
}

/**
 * 校验 args 数组每个元素的白名单（防止 --eval 等注入恶意代码）。
 * @throws 校验不通过时抛出 Error
 */
function sanitizeArgs(args: string[] | undefined): string[] {
  if (!args) return [];
  for (const arg of args) {
    if (!SAFE_VALUE_RE.test(arg)) {
      throw new Error(`Argument contains unsafe characters: ${arg}`);
    }
  }
  return args;
}

/**
 * 校验 command 字符串的白名单（同样禁止 shell 敏感字符）。
 * @throws 校验不通过时抛出 Error
 */
function sanitizeCommand(command: string): void {
  if (!SAFE_VALUE_RE.test(command)) {
    throw new Error(`Command contains unsafe characters: ${command}`);
  }
}

// ── 类型 ──────────────────────────────────────────────

type McpConfig = {
  servers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
};

type McpServerState = {
  configName: string;
  process: ChildProcess | null;
  status: MCPServerStatus;
  lastPingAt: number;
};

// ── 状态 ──────────────────────────────────────────────

const _servers: Map<string, McpServerState> = new Map();
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _statusTimer: ReturnType<typeof setInterval> | null = null;

// ── JSON-RPC ──────────────────────────────────────────

let _rpcId = 0;
function nextId(): number {
  return ++_rpcId;
}

/**
 * 向 MCP server 的 stdin 发送 JSON-RPC 请求。
 * 返回第一个匹配 id 的响应（超时则 reject）。
 */
function jsonRpcCall(
  proc: ChildProcess,
  method: string,
  params: unknown = {},
  timeoutMs: number = RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!proc.stdin || !proc.stdout) {
      return reject(new Error('stdin/stdout not available'));
    }

    const id = nextId();
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })}\n`;

    // 收集响应行
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // MCP 响应是 JSON Lines，每行一个完整 JSON
      const lines = buffer.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            cleanup();
            if (resp.error) {
              reject(new Error(resp.error.message || 'JSON-RPC error'));
            } else {
              resolve(resp.result);
            }
            return;
          }
        } catch {
          // 非 JSON 行忽略（可能是 stderr 混入？MCP 不走 stderr）
        }
      }
      // 保留未完整行
      buffer = lines[lines.length - 1] || '';
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`JSON-RPC timeout: ${method}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      if (proc.stdout) proc.stdout.removeListener('data', onData);
      proc.removeListener('error', onError);
    }

    proc.stdout.on('data', onData);
    proc.on('error', onError);
    proc.stdin.write(request);
  });
}

// ── 进程管理 ──────────────────────────────────────────

function spawnServer(
  name: string,
  config: { command: string; args?: string[]; env?: Record<string, string> },
): ChildProcess | null {
  try {
    // ── 安全校验（白名单） ────────────────────────────
    sanitizeCommand(config.command);
    const safeArgs = sanitizeArgs(config.args);
    const safeEnv = sanitizeEnv(config.env);

    const env = { ...process.env, ...safeEnv };
    const proc = spawn(config.command, safeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // 不给 shell，直接用 execve
      shell: false,
    });

    proc.on('exit', (code, signal) => {
      const state = _servers.get(name);
      if (state) {
        state.process = null;
        state.status = {
          name,
          status: 'disconnected',
          error: `exited (code=${code}, signal=${signal})`,
        };
        writeAllStatus();
      }
    });

    proc.on('error', (err) => {
      const state = _servers.get(name);
      if (state) {
        state.process = null;
        state.status = {
          name,
          status: 'error',
          error: err.message,
        };
        writeAllStatus();
        log.error(`MCP server "${name}" process error`, err);
      }
    });

    // 把 stderr 吞掉避免未处理（MCP 可能往 stderr 写日志）
    proc.stderr?.on('data', () => {
      // discard
    });

    return proc;
  } catch (err) {
    log.error(`Failed to spawn MCP server "${name}"`, err, {
      command: config.command,
    });
    const state = _servers.get(name);
    if (state) {
      state.status = {
        name,
        status: 'error',
        error: String(err),
      };
    }
    return null;
  }
}

async function initServer(name: string): Promise<MCPServerStatus> {
  const state = _servers.get(name);
  if (!state) {
    return { name, status: 'error', error: 'not found' };
  }

  state.status = { name, status: 'connecting' };
  writeAllStatus();

  // 初始化
  try {
    const _result = await jsonRpcCall(state.process!, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'yu-agent',
        version: '0.1.0',
      },
    }) as Record<string, unknown>;

    // 获取 tool list
    const toolsResult = await jsonRpcCall(state.process!, 'tools/list') as { tools?: Array<{ name: string }> };
    const toolNames = (toolsResult?.tools || []).map((t: { name: string }) => t.name);

    state.status = {
      name,
      status: 'connected',
      tools: toolNames,
      lastSeen: Date.now(),
    };
  } catch (err) {
    state.status = {
      name,
      status: 'error',
      error: String(err),
    };
    log.error(`MCP server "${name}" init failed`, err);
    // 关掉失败的进程
    try { state.process?.kill(); } catch {}
    state.process = null;
  }

  writeAllStatus();
  return state.status;
}

// ── 写入状态 ──────────────────────────────────────────

function writeAllStatus(): void {
  const servers: MCPServerStatus[] = [];
  for (const state of _servers.values()) {
    servers.push({ ...state.status });
  }
  writeMCPStatus(servers);
}

// ── 心跳 ──────────────────────────────────────────────

function pingAll(): void {
  for (const [name, state] of _servers) {
    const proc = state.process;
    if (!proc?.pid || proc.exitCode !== null) {
      // 进程死了，标记断开
      if (state.status.status !== 'error') {
        state.status = { name, status: 'disconnected' };
      }
      continue;
    }

    // 进程还在，尝试发一个 ping（tools/list 是最轻量的调用）
    jsonRpcCall(proc, 'tools/list', {}, 3_000)
      .then((result) => {
        const toolsResult = result as { tools?: Array<{ name: string }> };
        state.status = {
          name,
          status: 'connected',
          tools: (toolsResult?.tools || []).map((t: { name: string }) => t.name),
          lastSeen: Date.now(),
        };
      })
      .catch(() => {
        // ping 失败但进程还在——可能是半死状态
        if (state.status.status === 'connected') {
          state.status = { name, status: 'error', error: 'ping timeout' };
        }
      })
      .finally(() => {
        writeAllStatus();
      });
  }
}

// ── 配置读取 ──────────────────────────────────────────

function loadConfig(): McpConfig {
  if (!existsSync(MCP_CONFIG_PATH)) {
    return { servers: {} };
  }
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as McpConfig;
  } catch (err) {
    log.warn(`Failed to parse ${MCP_CONFIG_PATH}`, err);
    return { servers: {} };
  }
}

// ── 公共 API ──────────────────────────────────────────

/**
 * 启动 MCP 管理器。
 * 读取配置 → spawn 所有 server → 初始化 → 开始心跳。
 */
export async function startMCPManager(): Promise<void> {
  const config = loadConfig();

  const entries = Object.entries(config.servers);
  if (entries.length === 0) {
    return;
  }

  log.info(`Starting ${entries.length} MCP server(s)...`);

  // 1. 创建状态记录
  for (const [name, cfg] of entries) {
    _servers.set(name, {
      configName: name,
      process: null,
      status: { name, status: 'disconnected' },
      lastPingAt: 0,
    });

    // 2. spawn
    const proc = spawnServer(name, cfg);
    if (!proc) {
      continue;
    }

    const state = _servers.get(name)!;
    state.process = proc;

    // 3. init（异步，不阻塞整体启动）
    initServer(name).catch((err) => {
      log.warn(`${name} init failed`, err);
    });
  }

  // 4. 定时心跳
  _pollTimer = setInterval(pingAll, PING_INTERVAL_MS);

  // 5. 定时写状态（保障 monitor 能刷到）
  _statusTimer = setInterval(writeAllStatus, STATUS_WRITE_INTERVAL_MS);
}

/**
 * 停止所有 MCP 服务器。
 */
export async function stopMCPManager(): Promise<void> {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }

  if (_statusTimer) {
    clearInterval(_statusTimer);
    _statusTimer = null;
  }

  for (const [_name, state] of _servers) {
    try {
      state.process?.kill();
    } catch {
      // ignore
    }
  }
  _servers.clear();
  writeAllStatus();
}

/**
 * 即时刷新状态写入（供 scheduler 在关键节点调用）。
 */
export function flushMCPStatus(): void {
  writeAllStatus();
}
