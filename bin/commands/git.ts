/**
 * yu-agent CLI — Git commands (`yu git <subcommand>`)
 */

export async function command(args: string[]): Promise<void> {
  const sub = args[1] || 'help'
  const { prCreate, prList, createBranch, mergeBranch } = await import('../../extension/git-commands.js')

  try {
    switch (sub) {
      case 'pr': {
        const prSub = args[2]
        if (prSub === 'create') {
          const out = prCreate(args[3] || 'main')
          console.log(out)
        } else if (prSub === 'list') {
          const out = prList()
          console.log(out)
        } else {
          console.error('Usage: yu git pr create [target-branch]')
          console.error('       yu git pr list')
          process.exit(1)
        }
        break
      }
      case 'branch': {
        const branchName = args[2]
        if (!branchName) {
          console.error('Usage: yu git branch <name>')
          process.exit(1)
        }
        const out = createBranch(branchName)
        console.log(out)
        break
      }
      case 'merge': {
        const mergeBranchName = args[2]
        if (!mergeBranchName) {
          console.error('Usage: yu git merge <branch>')
          process.exit(1)
        }
        const out = mergeBranch(mergeBranchName)
        console.log(out)
        break
      }
      default:
        console.error('Usage: yu git pr create [target-branch]')
        console.error('       yu git pr list')
        console.error('       yu git branch <name>')
        console.error('       yu git merge <branch>')
        process.exit(1)
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`git 操作失败: ${msg}`)
    process.exit(1)
  }
  process.exit(0)
}
