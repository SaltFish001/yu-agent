import { eventBus } from './events.js'
import { createLogger } from './logger.js'

const log = createLogger('team-orch')

import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from 'fs'
import { resolve } from 'path'
import type { SchedulerPlan } from './classifier.js'
import { AGENT_TYPES, loadPrompt } from './config.js'
import { type AgentTask, runParallelGroup } from './executor.js'
import { TEMP_DIR } from './paths.js'
import { resolveRule } from './rules/compose.js'
import { writeTeamStatus } from './status.js'
import type { ReviewOutput } from './template.js'
import { parseAgentOutput } from './template.js'

// ── Constants ──────────────────────────────────────────

const _MAX_RETRY_TEAM = 2
const TEAM_FILE_TIMEOUT_MS = 120_000

// ── Rule-based role resolution ─────────────────────────

/**
 * Resolve agent config for a team role from rules system.
 * Falls back to AGENT_TYPES defaults if no matching rule found.
 */
async function resolveRoleConfig(
  roleName: string,
  defaultType: string,
): Promise<{ model: string; systemPrompt?: string }> {
  try {
    const rule = await resolveRule(`team-${roleName}`)
    if (rule) {
      return {
        model: rule.model ?? AGENT_TYPES[defaultType as keyof typeof AGENT_TYPES]?.model ?? 'v4-flash',
        systemPrompt: rule.systemPrompt,
      }
    }
  } catch {
    // Rule resolution failed — use defaults
  }
  return {
    model: AGENT_TYPES[defaultType as keyof typeof AGENT_TYPES]?.model ?? 'v4-flash',
  }
}

// ── Parse modules from plan content ─────────────────────

export function parseModulesFromPlan(planContent: string): { name: string; files: string[]; independent: boolean }[] {
  // Try JSON (agent output) first
  const planOutput = parseAgentOutput(planContent)
  if (
    planOutput &&
    'modules' in planOutput &&
    Array.isArray((planOutput as unknown as Record<string, unknown>).modules)
  ) {
    const modules = (planOutput as unknown as { modules: { name: string; files: string[]; independent: boolean }[] }).modules
    if (modules.length > 0) return modules
  }

  // Fallback: extract modules from markdown headings (## Module Name)
  const headingRegex = /^##\s+(.+)/gm
  const matchResult = planContent.matchAll(headingRegex)
  const headingModules: { name: string; files: string[]; independent: boolean }[] = []
  for (const m of matchResult) {
    headingModules.push({ name: m[1].trim(), files: [], independent: true })
  }
  if (headingModules.length > 0) return headingModules

  // Last resort: single default module
  return [{ name: 'default', files: [], independent: true }]
}

// ── Team mode orchestrator ─────────────────────────────

export async function runTeamMode(_plan: SchedulerPlan, context: Record<string, unknown>): Promise<string> {
  const taskId = `team-${Date.now()}`
  const sharedDir = resolve(TEMP_DIR, taskId)
  mkdirSync(sharedDir, { recursive: true })

  const planFile = resolve(sharedDir, 'plan.md')

  // Track team mode
  writeTeamStatus({
    active: true,
    mode: 'architect-searcher',
    members: [
      { role: 'architect', status: 'running', model: AGENT_TYPES.plan.model },
      { role: 'searcher', status: 'running', model: AGENT_TYPES.search.model },
    ],
    currentPhase: 'research',
    sharedDir,
  })

  // Emit team.started
  try {
    eventBus.emit('team.started', { taskId, mode: 'architect-searcher', sharedDir })
  } catch {
    /* non-critical */
  }
  log.info(`🚀 Team mode [${taskId}] 启动 — 阶段: 调研 (architect + searcher 并行)`)

  // Extract original goal from plan or context
  const originalGoal: string =
    (_plan as Record<string, unknown>)?.goal as string
    || _plan.agents?.[0]?.task
    || (context.goal as string)
    || (context.originalGoal as string)
    || ''

  // Phase 1: Architect + Searcher in parallel
  const architectCfg = await resolveRoleConfig('architect', 'plan')
  const searcherCfg = await resolveRoleConfig('searcher', 'search')
  const architectTask: AgentTask = {
    type: 'plan',
    model: architectCfg.model,
    id: 'team-architect',
    task: originalGoal
      ? `理解以下目标，拆解为具体任务。将方案写入 ${planFile}\n\n目标: ${originalGoal}`
      : `分析现有代码结构并出方案。将方案写入 ${planFile}`,
  }
  const searcherTask: AgentTask = {
    type: 'search',
    model: searcherCfg.model,
    id: 'team-searcher',
    task: `搜索相关信息。结果写入 ${resolve(sharedDir, 'context.md')}`,
  }

  const agentMap = new Map<string, AgentTask>([
    ['team-architect', architectTask],
    ['team-searcher', searcherTask],
  ])

  const agentResults = await runParallelGroup(['team-architect', 'team-searcher'], agentMap, {
    ...context,
    shared_dir: sharedDir,
  })

  // Wait for plan.md — with text fallback if agent never called write tool
  if (!existsSync(planFile)) {
    // Try to use plan agent's text output as fallback
    const architectResult = agentResults.get('team-architect')
    const planText = architectResult?.text || architectResult?.response || architectResult?.content
    if (planText) {
      writeFileSync(planFile, planText, 'utf-8')
      log.info(`plan.md written from agent text output (${planText.length} chars)`)
    } else {
      // Last resort: wait via fs.watch with timeout
      await new Promise<void>((resolveTimeout, reject) => {
        const watcher = watch(sharedDir, (_eventType, filename) => {
          if (filename === 'plan.md' && existsSync(planFile)) {
            watcher.close()
            resolveTimeout()
          }
        })
        setTimeout(() => {
          watcher.close()
          reject(new Error('Timeout waiting for plan.md'))
        }, TEAM_FILE_TIMEOUT_MS)
      })
    }
  }

  // Validate plan.md content — must look like a real plan, not just agent rambling
  if (existsSync(planFile)) {
    const planContent = readFileSync(planFile, 'utf-8').trim()
    const hasHeadings = /^#{1,3}\s+/m.test(planContent)
    const hasJsonStructure = /"goal"\s*:/.test(planContent) || /"modules"\s*:/.test(planContent)
    const hasFileChanges = /\.ts|\.js|\.md/.test(planContent) && /改动|修改|change|fix|add|refactor/i.test(planContent)
    const isRambling = /^(现在|让我|我先|我需要)/.test(planContent) || /读取更多|继续读取/.test(planContent)
    const tooShort = planContent.length < 50
    const isError = planContent.startsWith('Error:')
    const noChanges = planContent.includes('无需改动') || planContent.includes('no changes needed')

    if (tooShort || isError || noChanges || isRambling || (!hasHeadings && !hasJsonStructure && !hasFileChanges)) {
      log.warn(`plan.md rejected (len=${planContent.length}, hasHeadings=${hasHeadings}, hasJson=${hasJsonStructure}, rambling=${isRambling}), using fallback`)
      // Extract original goal from plan
      const originalGoal: string =
        (_plan as Record<string, unknown>)?.goal as string
        || (_plan.agents?.[0]?.task)
        || (context.goal as string)
        || '执行代码改动'
      const fallback = `# 执行方案（自动生成）\n\n## 目标\n${originalGoal}\n\n## 当前状态\n方案由 orchestrator 自动生成，未包含实际代码分析。coding agent 应主动读相关文件后补充分析。\n\n## 任务列表\n- 分析当前代码状态并执行目标: ${originalGoal}\n\n## 改动风险\n新建文件无风险。改已有文件需验证不破坏现有逻辑。\n\n## JSON\n\`\`\`json\n{\n  "goal": "${originalGoal}",\n  "modules": [\n    {"name": "analysis", "files": [], "independent": false, "note": "先分析代码结构"},\n    {"name": "implementation", "files": [], "independent": false, "dependencies": ["analysis"], "note": "根据分析结果执行改动"}\n  ]\n}\n\`\`\``
      writeFileSync(planFile, fallback, 'utf-8')
      log.info(`plan.md fallback written (${fallback.length} chars)`)
    }
  }

  writeTeamStatus({
    active: true,
    mode: 'coder-reviewer',
    members: [
      { role: 'architect', status: 'completed' },
      { role: 'searcher', status: 'completed' },
      { role: 'coder', status: 'waiting' },
      { role: 'reviewer', status: 'waiting' },
    ],
    currentPhase: 'plan-ready',
    sharedDir,
  })

  // Emit team.phase
  try {
    eventBus.emit('team.phase', { taskId, phase: 'plan-ready', sharedDir })
  } catch {
    /* non-critical */
  }

  // Phase 2: Read plan, spawn Coder(s)
  const planContent = readFileSync(planFile, 'utf-8')
  log.info(`📋 Team [${taskId}] plan.md 就绪 (${planContent.length} chars)`)

  // Parse modules from plan
  const modules = parseModulesFromPlan(planContent)

  // Load context.md if generated by searcher
  const contextMdPath = resolve(sharedDir, 'context.md')
  const contextMd = existsSync(contextMdPath) ? readFileSync(contextMdPath, 'utf-8') : ''

  // Update status: Phase 2 — Coding
  writeTeamStatus({
    active: true,
    mode: 'coder-reviewer',
    members: [
      { role: 'architect', status: 'completed' },
      { role: 'searcher', status: 'completed' },
      ...modules.map(() => ({ role: 'coder', status: 'running' as const, model: AGENT_TYPES.coding.model })),
      ...modules.map(() => ({ role: 'reviewer', status: 'waiting' as const })),
    ],
    currentPhase: 'coding',
    sharedDir,
  })

  // Create one Coder task per module and run in parallel
  const coderCfg = await resolveRoleConfig('coder', 'coding')
  const coderTasks: AgentTask[] = modules.map((mod, i) => ({
    type: 'coding',
    model: coderCfg.model,
    id: `team-coder-${i}`,
    task: `实现模块: ${mod.name}。遵循 ${planFile} 的方案。

共享目录: ${sharedDir}
方案文件: ${planFile}
上下文文件: ${resolve(sharedDir, 'context.md')}

模块文件: ${(mod.files || []).join(', ')}

约束: 只实现本模块 ${mod.name} 的内容。

必须实际写出代码并通过验证，不能只读文件。`,
    files: mod.files.length > 0 ? mod.files : undefined,
  }))

  const coderAgentMap = new Map(coderTasks.map((t) => [t.id, t]))
  log.info(`👷 Team [${taskId}] 阶段: coding — ${coderTasks.length} 个 agent (${coderCfg.model})`)
  const coderResults = await runParallelGroup(
    coderTasks.map((t) => t.id),
    coderAgentMap,
    { ...context, shared_dir: sharedDir, plan_content: planContent, context_md: contextMd },
  )

  // Log coding agent results
  for (const [id, r] of coderResults) {
    const wrote = r?.wroteCode ? '✅ 写了代码' : '⚠️ 未产出代码'
    log.info(`Coder ${id}: ${wrote} (${r?.text?.length ?? 0} chars, ${r?.durationMs ?? 0}ms)`)
  }

  // Phase 3: Reviewers — up to 2 rounds of review cycles
  const MAX_REVIEW_ROUNDS = 2
  let allApproved = false

  for (let round = 0; round < MAX_REVIEW_ROUNDS && !allApproved; round++) {
    writeTeamStatus({
      active: true,
      mode: 'coder-reviewer',
      members: [
        { role: 'architect', status: 'completed' },
        { role: 'searcher', status: 'completed' },
        ...modules.map(() => ({ role: 'coder', status: 'completed' as const })),
        ...modules.map(() => ({ role: 'reviewer', status: 'running' as const })),
      ],
      currentPhase: `review-round-${round + 1}`,
      sharedDir,
    })

    // Create one Reviewer task per module
    const reviewerCfg = await resolveRoleConfig('reviewer', 'review')
    log.info(`🔍 Team [${taskId}] 阶段: review round ${round + 1} — ${modules.length} 个 agent`)
    const reviewerTasks: AgentTask[] = modules.map((mod, i) => ({
      type: 'review',
      model: reviewerCfg.model,
      id: `team-reviewer-${i}-r${round}`,
      task: `审查模块 "${mod.name}" 的代码实现。
模块文件: ${mod.files.join(', ')}

方案文件: ${planFile}

根据 plan.md 的方案评估实现质量。

审查要求：
1. 编写详细的人类可读审查报告（问题、行号、建议）
2. 在报告后用 \`\`\`json 代码块输出结构化摘要：
   {"status": "approved" | "changes_requested", "findings": [{"severity": "high"|"medium"|"low", "file": "...", "line": N, "message": "..."}]}
3. 至少有一个 high/medium 问题才返回 changes_requested`,
      files: mod.files.length > 0 ? mod.files : undefined,
    }))

    const reviewerAgentMap = new Map(reviewerTasks.map((t) => [t.id, t]))
    const reviewerResults = await runParallelGroup(
      reviewerTasks.map((t) => t.id),
      reviewerAgentMap,
      { ...context, shared_dir: sharedDir, plan_content: planContent },
    )

    // Collect review text & check approval
    const changesDetails: string[] = []
    const reviewTexts: string[] = []
    for (const [id, result] of reviewerResults) {
      const text = result?.response || result?.text || ''
      reviewTexts.push(text)
      // Save full review text to file
      const reviewFile = resolve(sharedDir, `review-report-r${round + 1}-${id}.md`)
      try {
        writeFileSync(reviewFile, text, 'utf-8')
      } catch { /* non-critical */ }

      // Try JSON parse first (structured output)
      const output = parseAgentOutput(text)
      let requestedChanges = false
      if (output && 'status' in output) {
        if ((output as ReviewOutput).status === 'changes_requested') {
          requestedChanges = true
          changesDetails.push(JSON.stringify((output as ReviewOutput).findings || []))
        }
      } else {
        // Fallback: text-based detection
        requestedChanges = /changes?_requested|❌|不通过|问题|需修改/i.test(text)
        if (requestedChanges) {
          changesDetails.push(text.slice(0, 2000))
        }
      }
    }

    // Log review findings
    if (reviewTexts.length > 0) {
      const firstReview = reviewTexts[0].slice(0, 1000)
      log.info(`Review round ${round + 1} — findings:\n${firstReview}`)
    }

    if (changesDetails.length === 0) {
      allApproved = true
      log.info(`Review round ${round + 1}: ✅ all approved`)
      break
    }

    // Changes requested — cycle back to Coders (if not the last round)
    if (round < MAX_REVIEW_ROUNDS - 1) {
      log.info(`Review round ${round + 1}: changes requested, cycling back to Coders`)
      const coderRetryTasks: AgentTask[] = modules.map((mod, i) => ({
        type: 'coding',
        model: AGENT_TYPES.coding.model,
        id: `team-coder-${i}-fix-r${round}`,
        task: `根据 review 反馈修复模块 "${mod.name}" 的问题。

Review 反馈:
${changesDetails.join('\n---\n')}

方案文件: ${planFile}

只修复列出的问题，不要改动其他代码。必须实际写出修改并通过验证。`,
        files: mod.files.length > 0 ? mod.files : undefined,
      }))

      const coderRetryAgentMap = new Map(coderRetryTasks.map((t) => [t.id, t]))
      await runParallelGroup(
        coderRetryTasks.map((t) => t.id),
        coderRetryAgentMap,
        { ...context, shared_dir: sharedDir, plan_content: planContent, review_feedback: changesDetails },
      )
    }
  }

  // Phase 4: Conflict detection via git diff
  writeTeamStatus({
    active: true,
    mode: 'conflict-detection',
    members: [
      { role: 'architect', status: 'completed' },
      { role: 'searcher', status: 'completed' },
      ...modules.map(() => ({ role: 'coder', status: 'completed' as const })),
      ...modules.map(() => ({ role: 'reviewer', status: 'completed' as const })),
    ],
    currentPhase: 'conflict-detection',
    sharedDir,
  })

  const conflictedFiles: string[] = []
  try {
    const gitDiffProc = Bun.spawnSync(['git', 'diff', '--name-only', '--diff-filter=U'], { timeout: 10_000 })
    const gitDiff = gitDiffProc.stdout.toString()
    const output = gitDiff.trim()
    if (output) {
      conflictedFiles.push(...output.split('\n').filter(Boolean))
    }
  } catch {
    log.warn('Git conflict detection skipped (not a git repo or git unavailable)')
  }

  if (conflictedFiles.length > 0) {
    log.warn(`Conflicts detected in files`, { files: conflictedFiles })
  } else {
    log.info('No merge conflicts detected')
  }

  // Summary
  const wroteSummary = Array.from(coderResults.values())
    .map((r) => r?.wroteCode ? '✅' : '⚠️')
    .join(' ')
  log.info(`✅ Team [${taskId}] 完成 — 模块: ${modules.length} | 代码: ${wroteSummary} | review: ${allApproved ? '✅ passed' : '⚠️ not all approved'}`)

  // Final status
  writeTeamStatus({
    active: false,
    currentPhase: 'complete',
  })

  // Emit team.completed
  try {
    eventBus.emit('team.completed', {
      taskId,
      conflictedFiles: conflictedFiles.length > 0 ? conflictedFiles : undefined,
    })
  } catch {
    /* non-critical */
  }

  return `Team mode complete (${taskId})${conflictedFiles.length > 0 ? `. Conflicts in: ${conflictedFiles.join(', ')}` : ''}`
}
