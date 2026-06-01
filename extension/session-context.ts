/**
 * yu-agent — 当前 session 标识。
 *
 * 在 session_start 时设置，仅影响本进程内的 status 文件读写。
 * 不同进程的 YU_SESSION_ID 互不干扰，天然隔离。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** 获取当前 session 标识，用于文件隔离 */
export function getSessionTag(): string {
  return process.env.YU_SESSION_ID || 'shared';
}

/** 设置 session tag 和 project 目录 */
export function setSessionTag(id: string): void {
  // 只取文件路径中的最后一段（session 文件名），去掉 .json 后缀
  const tag = id
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.json$/i, '')
    ?.replace(/[^a-zA-Z0-9_-]/g, '_')
    || `sess_${Date.now()}`;
  process.env.YU_SESSION_ID = tag;

  // 记录项目目录（按 cwd 隔离 session 文件）
  process.env.YU_PROJECT_DIR = process.cwd();
}

/** 获取当前 project 的 status 目录（按 cwd 隔离） */
export function getStatusDir(): string {
  // 优先级1：当前目录下已有 .yu-agent/status/ → 项目本地 session
  const localDir = resolve(process.cwd(), '.yu-agent', 'status');
  if (existsSync(localDir)) return localDir;

  // 优先级2：进程内已记入 env（由 setSessionTag 设置）
  const projectDir = process.env.YU_PROJECT_DIR || '';
  if (projectDir) {
    const projectStatusDir = resolve(projectDir, '.yu-agent', 'status');
    if (existsSync(projectStatusDir)) return projectStatusDir;
    return projectStatusDir;
  }

  // fallback: 全局目录（~/.yu/）
  return resolve(homedir(), '.yu');
}
