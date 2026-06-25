/**
 * Unit tests — git-commands.ts (git/gh CLI wrappers)
 *
 * Tests prCreate, prList, createBranch, mergeBranch with mocked Bun.spawnSync.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

// ── Shared mock ──────────────────────────────────────────

let mockSpawn: ReturnType<typeof spyOn>

function makeMockProc(
  stdout: string,
  exitCode = 0,
): { exitCode: number; stdout: Buffer } {
  return { exitCode, stdout: Buffer.from(stdout) }
}

beforeEach(() => {
  mockSpawn = spyOn(Bun, 'spawnSync')
})

afterEach(() => {
  mockSpawn.mockRestore()
})

// ── prCreate ─────────────────────────────────────────────

describe('prCreate', () => {
  it('throws when gh CLI is not available', async () => {
    // gh --version fails
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'gh') return makeMockProc('', 1)
      // git commands succeed
      return makeMockProc('')
    })

    const { prCreate } = await import('../extension/git-commands.js')
    expect(() => prCreate()).toThrow('gh CLI')
  })

  it('throws when not inside a git repo', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'gh') return makeMockProc('gh version 2.0.0')
      if (args.includes('--git-dir')) return makeMockProc('', 1)
      return makeMockProc('')
    })

    const { prCreate } = await import('../extension/git-commands.js')
    expect(() => prCreate()).toThrow('git 仓库')
  })

  it('throws when already on target branch', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'gh') return makeMockProc('gh version 2.0.0')
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('main')
      return makeMockProc('')
    })

    const { prCreate } = await import('../extension/git-commands.js')
    expect(() => prCreate('main')).toThrow('已在 main 分支上')
  })

  it('throws when no unpushed commits exist', async () => {
    let callCount = 0
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'gh') return makeMockProc('gh version 2.0.0')
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('feat/test')
      // rev-list --count returns "0"
      if (args.includes('rev-list')) return makeMockProc('0')
      return makeMockProc('')
    })

    const { prCreate } = await import('../extension/git-commands.js')
    expect(() => prCreate()).toThrow('无可推送变更')
  })

  it('creates PR when prerequisites are met', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'gh' && args[1] === 'pr') {
        return makeMockProc('https://github.com/owner/repo/pull/42')
      }
      if (args[0] === 'gh') return makeMockProc('gh version 2.0.0')
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('feat/test')
      if (args.includes('rev-list')) return makeMockProc('3')
      if (args.includes('push')) return makeMockProc('')
      if (args.includes('merge')) return makeMockProc('')
      return makeMockProc('')
    })

    const { prCreate } = await import('../extension/git-commands.js')
    const url = prCreate('main')
    expect(url).toBe('https://github.com/owner/repo/pull/42')
  })
})

// ── prList ───────────────────────────────────────────────

describe('prList', () => {
  it('throws when gh CLI is not available', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args[0] === 'gh') return makeMockProc('', 1)
      return makeMockProc('')
    })

    const { prList } = await import('../extension/git-commands.js')
    expect(() => prList()).toThrow('gh CLI')
  })

  it('returns message when no open PRs', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      // gh version check
      if (args[0] === 'gh' && args.length === 2 && args[1] === '--version') return makeMockProc('gh version 2.0.0')
      // gh pr list returns empty
      if (args[0] === 'gh' && args[1] === 'pr') return makeMockProc('')
      return makeMockProc('')
    })

    const { prList } = await import('../extension/git-commands.js')
    const result = prList()
    expect(result).toBe('没有打开的 PR。')
  })

  it('returns PR list', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args[0] === 'gh' && args.length === 2 && args[1] === '--version') return makeMockProc('gh version 2.0.0')
      if (args[0] === 'gh' && args[1] === 'pr') {
        return makeMockProc('#42  Fix the thing  feat/fix\n#43  Add feature  feat/add')
      }
      return makeMockProc('')
    })

    const { prList } = await import('../extension/git-commands.js')
    const result = prList()
    expect(result).toContain('#42')
    expect(result).toContain('#43')
  })
})

// ── createBranch ─────────────────────────────────────────

describe('createBranch', () => {
  it('throws when not in a git repo', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('', 1)
      return makeMockProc('')
    })

    const { createBranch } = await import('../extension/git-commands.js')
    expect(() => createBranch('feat/test')).toThrow('git 仓库')
  })

  it('throws when branch name is empty', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      return makeMockProc('')
    })

    const { createBranch } = await import('../extension/git-commands.js')
    expect(() => createBranch('')).toThrow('请指定分支名称')
  })

  it('switches to existing branch when name already exists', async () => {
    let callCount = 0
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      // rev-parse --verify on existing branch succeeds (exit 0)
      if (args.includes('--verify')) return makeMockProc('abc123')
      // checkout existing branch
      if (args[0] === 'git' && args[1] === 'checkout') return makeMockProc('')
      return makeMockProc('')
    })

    const { createBranch } = await import('../extension/git-commands.js')
    const result = createBranch('existing-branch')
    expect(result).toBe('切换到已有分支: existing-branch')
  })

  it('creates and switches to new branch when name does not exist', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      // rev-parse --verify on non-existing branch fails (exit 1)
      if (args.includes('--verify')) return makeMockProc('', 1)
      // checkout -b new branch
      if (args[0] === 'git' && args[1] === 'checkout') return makeMockProc('')
      return makeMockProc('')
    })

    const { createBranch } = await import('../extension/git-commands.js')
    const result = createBranch('feat/new-thing')
    expect(result).toBe('创建并切换到分支: feat/new-thing')
  })
})

// ── mergeBranch ─────────────────────────────────────────

describe('mergeBranch', () => {
  it('throws when not in a git repo', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('', 1)
      return makeMockProc('')
    })

    const { mergeBranch } = await import('../extension/git-commands.js')
    expect(() => mergeBranch('other')).toThrow('git 仓库')
  })

  it('throws when branch name is empty', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      return makeMockProc('')
    })

    const { mergeBranch } = await import('../extension/git-commands.js')
    expect(() => mergeBranch('')).toThrow('请指定要合并的分支名称')
  })

  it('returns early when merging self', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('main')
      return makeMockProc('')
    })

    const { mergeBranch } = await import('../extension/git-commands.js')
    const result = mergeBranch('main')
    expect(result).toBe('已经在 main 分支上，无需合并。')
  })

  it('succeeds on clean merge', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('main')
      if (args[0] === 'git' && args[1] === 'merge') return makeMockProc('Updating abc..def\nFast-forward')
      return makeMockProc('')
    })

    const { mergeBranch } = await import('../extension/git-commands.js')
    const result = mergeBranch('feat/test')
    expect(result).toContain('Updating')
    expect(result).toContain('Fast-forward')
  })

  it('detects merge conflicts', async () => {
    let callCount = 0
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('main')
      // merge fails
      if (args[0] === 'git' && args[1] === 'merge') return makeMockProc('Conflict!', 1)
      // diff --name-only --diff-filter=U returns conflicting files
      if (args.includes('--diff-filter=U')) return makeMockProc('src/main.ts\nsrc/utils.ts')
      return makeMockProc('')
    })

    const { mergeBranch } = await import('../extension/git-commands.js')
    const result = mergeBranch('feat/test')
    expect(result).toContain('合并冲突')
    expect(result).toContain('src/main.ts')
    expect(result).toContain('src/utils.ts')
  })

  it('throws on non-conflict merge failure', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--git-dir')) return makeMockProc('.git')
      if (args.includes('--abbrev-ref')) return makeMockProc('main')
      if (args[0] === 'git' && args[1] === 'merge') return makeMockProc('fatal: Not a valid branch', 1)
      // no conflicted files
      if (args.includes('--diff-filter=U')) return makeMockProc('')
      return makeMockProc('')
    })

    const { mergeBranch } = await import('../extension/git-commands.js')
    expect(() => mergeBranch('nonexistent')).toThrow('合并失败')
  })
})
