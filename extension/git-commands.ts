/**
 * yu-agent — Git CLI integration (Phase 3).
 *
 * Provides yu git subcommands: pr create, pr list, branch, merge.
 * Uses the gh CLI when available, with clear error messages when not.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Helpers ────────────────────────────────────────────

/** Check if gh CLI is installed. */
function hasGhCli(): boolean {
  try {
    execSync('gh --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if we are inside a git repository. */
function isInsideGitRepo(): boolean {
  try {
    execSync('git rev-parse --git-dir', { encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Get the current branch name. */
function currentBranch(): string {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5_000,
  }).trim();
}

/** Run a git command and return stdout. */
function git(...args: string[]): string {
  return execSync(`git ${args.join(' ')}`, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 30_000,
  }).trim();
}

/** Run a gh command and return stdout. */
function gh(...args: string[]): string {
  return execSync(`gh ${args.join(' ')}`, {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 60_000,
  }).trim();
}

// ── Public API ─────────────────────────────────────────

/**
 * yu git pr create — 基于当前分支创建 PR。
 * 需要 gh CLI，需要 rebase 到目标分支（默认 main）。
 */
export function prCreate(targetBranch = 'main'): string {
  if (!hasGhCli()) {
    throw new Error('gh CLI 不可用。请先安装 GitHub CLI: https://cli.github.com/');
  }
  if (!isInsideGitRepo()) {
    throw new Error('当前目录不是一个 git 仓库。');
  }

  const branch = currentBranch();
  if (branch === targetBranch) {
    throw new Error(`当前已在 ${targetBranch} 分支上，请先切换到特性分支再创建 PR。`);
  }

  // 检查是否有未推送的 commit
  const behind = git('rev-list', `--count`, `${targetBranch}..${branch}`);
  if (behind === '0' || behind === '') {
    throw new Error(`分支 ${branch} 没有领先 ${targetBranch} 的 commit（无可推送变更）。`);
  }

  // 推送到远程
  git('push', '--set-upstream', 'origin', branch);

  // 创建 PR
  const prUrl = gh('pr', 'create', '--base', targetBranch, '--fill');
  return prUrl;
}

/**
 * yu git pr list — 列出当前仓库的 PR。
 * 需要 gh CLI。
 */
export function prList(): string {
  if (!hasGhCli()) {
    throw new Error('gh CLI 不可用。请先安装 GitHub CLI: https://cli.github.com/');
  }
  if (!isInsideGitRepo()) {
    throw new Error('当前目录不是一个 git 仓库。');
  }

  const output = gh('pr', 'list', '--limit', '20');
  if (!output) {
    return '没有打开的 PR。';
  }
  return output;
}

/**
 * yu git branch <name> — 基于当前 HEAD 创建并切换分支。
 */
export function createBranch(name: string): string {
  if (!isInsideGitRepo()) {
    throw new Error('当前目录不是一个 git 仓库。');
  }
  if (!name || /^\s*$/.test(name)) {
    throw new Error('请指定分支名称。');
  }

  // 检查分支是否已存在
  try {
    git('rev-parse', '--verify', name);
    // 分支已存在，切换到它
    git('checkout', name);
    return `切换到已有分支: ${name}`;
  } catch {
    // 分支不存在，创建并切换
    git('checkout', '-b', name);
    return `创建并切换到分支: ${name}`;
  }
}

/**
 * yu git merge <branch> — 合并指定分支到当前分支，检测冲突。
 */
export function mergeBranch(branch: string): string {
  if (!isInsideGitRepo()) {
    throw new Error('当前目录不是一个 git 仓库。');
  }
  if (!branch || /^\s*$/.test(branch)) {
    throw new Error('请指定要合并的分支名称。');
  }

  const current = currentBranch();
  if (branch === current) {
    return `已经在 ${current} 分支上，无需合并。`;
  }

  // 先检查是否可以快进/合并
  try {
    // 尝试合并（如果冲突会抛出）
    const output = git('merge', branch, '--no-edit');
    return output || `成功合并 ${branch} 到 ${current}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 检测是否有冲突
    const conflictFiles = git('diff', '--name-only', '--diff-filter=U');
    if (conflictFiles) {
      const files = conflictFiles.split('\n').filter(Boolean);
      return `合并冲突！请在以下文件中解决冲突后提交：\n  ${files.join('\n  ')}\n\n详细信息:\n  ${msg}`;
    }
    throw new Error(`合并失败: ${msg}`);
  }
}
