/**
 * yu-agent — Team mode: team spec registry
 *
 * Load and validate team spec files from ~/.yu/teams/{name}/config.json
 */

import { mkdirSync } from 'fs'
import path from 'path'
import { resolveBaseDir } from './mailbox.js'
import { type Member, type TeamSpec, TeamSpecSchema } from './types.js'

const mkdir = async (dirPath: string, opts?: { recursive?: boolean; mode?: number }): Promise<void> => {
  mkdirSync(dirPath, { recursive: true, ...opts })
}
const readFile = async (filePath: string): Promise<string> => await Bun.file(filePath).text()
const writeFile = async (filePath: string, data: string) => Bun.write(filePath, data)

// ── Paths ──────────────────────────────────────────────

export function getTeamsDir(): string {
  return path.join(resolveBaseDir(), 'teams')
}

export function getTeamSpecPath(teamName: string): string {
  return path.join(getTeamsDir(), teamName, 'config.json')
}

// ── Load team spec ─────────────────────────────────────

export async function loadTeamSpec(teamName: string): Promise<TeamSpec> {
  const specPath = getTeamSpecPath(teamName)
  const content = await readFile(specPath)
  const raw = JSON.parse(content)
  const parsed = TeamSpecSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid team spec '${teamName}': ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}

// ── Save team spec ─────────────────────────────────────

export async function saveTeamSpec(spec: TeamSpec): Promise<void> {
  const specPath = getTeamSpecPath(spec.name)
  await mkdir(path.dirname(specPath), { recursive: true, mode: 0o700 })
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`)
}

// ── List available team specs ──────────────────────────

export async function listTeamSpecs(): Promise<{ name: string; description?: string }[]> {
  const { readdir } = await import('fs/promises')
  const teamsDir = getTeamsDir()
  try {
    const entries = await readdir(teamsDir, { withFileTypes: true })
    const specs: { name: string; description?: string }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const spec = await loadTeamSpec(entry.name)
        specs.push({ name: spec.name, description: spec.description })
      } catch {
        /* skip invalid */
      }
    }
    return specs
  } catch {
    return []
  }
}

// ── Helper: create an inline spec from simple args ─────

export function buildInlineSpec(
  name: string,
  members: { name: string; role: string; prompt?: string; model?: string }[],
  leadIndex = 0,
): TeamSpec {
  const parsedMembers: Member[] = members.map((m, _i) => ({
    kind: 'subagent_type' as const,
    name: m.name,
    subagent_type: m.role,
    prompt: m.prompt,
    model: m.model,
    isActive: true,
    backendType: 'in-process' as const,
  }))

  const raw: Record<string, unknown> = {
    name,
    members: parsedMembers,
    leadAgentId: members[leadIndex]?.name,
  }

  return TeamSpecSchema.parse(raw)
}
