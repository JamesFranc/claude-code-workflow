import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tryResolveRawSessionId } from '../dashboard/session-id.ts'
import {
  atomicWrite,
  readClassified,
  sessionGlobalScope,
  storePath,
} from '../workflow-store/store.ts'

// Ground truth for "is this teammate alive" is the process table — but only for a pane-backed
// teammate (`backendType` `iterm2` or `tmux`): it runs as its own process,
// `claude … --agent-id <name>@<team> --agent-name <name> --team-name <team> …`. The team lead and
// any member explicitly marked `backendType: 'in-process'` share the lead's own process and have no
// such argv, so those two are excluded by name/backendType rather than by an allowlist: an absent or
// unrecognized backendType is scanned, not skipped, so a config this code doesn't yet understand
// fails toward being checked instead of silently vanishing from the roster. For a pane-backed
// teammate, a spawn result, ListAgents, SendMessage and the team config all report success even
// after it never started or has exited (FLOW-358), so none of them is a liveness signal for it.

// How long a roster member may have no process before it is dead rather than still starting.
export const SPAWN_GRACE_MS = 5 * 60_000

const LEDGER_FILENAME = 'teammate-deaths-reported.json'
const ROSTER_FILENAME = 'teammate-roster.json'

export interface RunningAgent {
  pid: number
  agentId: string
  teamName: string
}

export interface TeammateStatus {
  name: string
  agentId: string
  joinedAt: number
  // null = no process: the teammate is not running
  pid: number | null
}

// Why a scan reports no team: nothing was ever saved, the live config cannot be used, or the saved
// roster cannot be used. Each means the lead could not check, never that shutdown is clean.
export type EmptyReason = 'no-config-no-roster' | 'config-unusable' | 'roster-unusable'

const emptyScan = (emptyReason: EmptyReason): TeammateScan => ({
  team: null,
  emptyReason,
  dissolved: false,
  members: [],
  orphans: [],
})

export interface TeammateScan {
  team: string | null
  emptyReason: EmptyReason | null
  // The team config is absent but this session saved its roster earlier: the harness
  // removes the team directory once its last teammate exits, so `members` is the roster
  // last seen and each pid is still read live. A config that is present but unreadable,
  // malformed or another session's is never dissolved.
  dissolved: boolean
  members: TeammateStatus[]
  // Running teammate processes of this team whose member has left the config.
  orphans: RunningAgent[]
}

export interface TeammateDeathScan {
  all: TeammateStatus[]
  unreported: TeammateStatus[]
}

// `mailbox teammates`: the on-demand check Team Cleanup reads instead of waiting on an ack that
// cannot come.
export const runTeammates = (session?: string): void => {
  const rawId = tryResolveRawSessionId(session)
  if (rawId === null) {
    console.error('mailbox teammates: no session id: pass --session or set CLAUDE_CODE_SESSION_ID')
    process.exitCode = 2
    return
  }

  const scan = scanTeammates(rawId)
  if (scan === null) {
    console.error('mailbox teammates: could not read the process table (ps failed)')
    process.exitCode = 1
    return
  }

  if (scan.emptyReason !== null) {
    console.error(emptyMessages[scan.emptyReason])
    process.exitCode = 1
    return
  }

  console.log(JSON.stringify(scan, null, 2))
}

const emptyMessages: Record<EmptyReason, string> = {
  'no-config-no-roster':
    'mailbox teammates: no team config for this session, and no roster saved from one',
  'config-unusable':
    "mailbox teammates: this session's team config is unreadable, malformed or another session's",
  'roster-unusable':
    "mailbox teammates: the team config is gone and this session's saved roster is unreadable or malformed",
}

// null only when the process table could not be read. A live team config is saved as
// this session's roster on every read, so the members are still known once the
// harness deletes the team directory — which it does when the last teammate exits,
// taking that teammate's shutdown acknowledgment with it.
// An empty scan carries its `emptyReason`, which `runTeammates` above turns into a non-zero exit:
// no config and no saved roster shows only that no roster was saved — the team never existed, it
// dissolved before any scan, or every save failed; a team config that is unreadable, malformed or
// another session's, or a saved roster that is unreadable or malformed, is likewise never a
// dissolved team.
export const scanTeammates = (
  rawSessionId: string,
  processes: RunningAgent[] | null = runningAgents()
): TeammateScan | null => {
  if (processes === null) {
    return null
  }

  const config = loadTeamConfig(rawSessionId)
  if (config === 'unusable') {
    return emptyScan('config-unusable')
  }

  if (config !== 'absent') {
    const roster = rosterOf(config)
    saveRoster(roster, rawSessionId)
    return scanRoster(roster, processes, false)
  }

  const saved = loadRoster(rawSessionId)
  if (saved === 'absent') {
    return emptyScan('no-config-no-roster')
  }

  return saved === 'unusable' ? emptyScan('roster-unusable') : scanRoster(saved, processes, true)
}

// Which of this session's teammates are dead and not yet reported to the lead. Same one-wake-per-
// death ledger shape as monitor-deaths.ts: a death already reported stays silent, so an unhandled
// wake does not become a wake every poll.
export const scanTeammateDeaths = (
  rawSessionId: string,
  now: number = Date.now(),
  processes: RunningAgent[] | null = runningAgents()
): TeammateDeathScan => {
  const scan = scanTeammates(rawSessionId, processes)
  if (scan === null) {
    return { all: [], unreported: [] }
  }

  // A dissolved team has nothing still starting, so a missing
  // process there is dead without the grace.
  const all = scan.members.filter(
    (m) => m.pid === null && (scan.dissolved || now - m.joinedAt >= SPAWN_GRACE_MS)
  )
  const reported = new Set(loadLedger(rawSessionId))
  return { all, unreported: all.filter((m) => !reported.has(deathKey(m))) }
}

// Rewrite the ledger to exactly `all` (never the `unreported` subset — see
// recordMonitorDeathsReported for why). A teammate that came back or left the roster drops out.
export const recordTeammateDeathsReported = (all: TeammateStatus[], rawSessionId: string): void => {
  atomicWrite(ledgerPath(rawSessionId), JSON.stringify(all.map(deathKey), null, 2))
}

export const formatTeammateDeath = (death: TeammateStatus): string =>
  `[team] dead-teammate ${death.name} — no process is running for ${death.agentId} ` +
  `(joined ${new Date(death.joinedAt).toISOString()}), so nothing can arrive from it; its pane ` +
  `may still be open and SendMessage still reports delivery. If you were waiting on its shutdown ` +
  `acknowledgment, the shutdown is complete — nothing else needed. Otherwise, if its work is ` +
  `unfinished, respawn it — if the respawn dies too, the client needs a restart (usually after an ` +
  `update).`

// Exported for the argv test: the lead's own CLI calls also carry `--agent-id` (e.g.
// `review-ledger senior shutdown --agent-id <id>`), so only a line carrying `--agent-id`,
// `--agent-name` and `--team-name` all three — in any order — counts as a teammate.
export const parseAgentProcesses = (psOutput: string): RunningAgent[] =>
  psOutput.split('\n').flatMap((line) => {
    const pidMatch = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!pidMatch) {
      return []
    }

    const [, pid, command] = pidMatch
    const agentId = /--agent-id\s+(\S+)/.exec(command)?.[1]
    const teamName = /--team-name\s+(\S+)/.exec(command)?.[1]
    const hasAgentName = /--agent-name\s+\S+/.test(command)
    if (agentId === undefined || teamName === undefined || !hasAgentName) {
      return []
    }

    return [{ pid: Number(pid), agentId, teamName }]
  })

const PS_TIMEOUT_MS = 10_000
const PS_MAX_BUFFER_BYTES = 64 * 1024 * 1024

const runningAgents = (): RunningAgent[] | null => {
  try {
    return parseAgentProcesses(
      execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER_BYTES,
      })
    )
  } catch {
    return null
  }
}

interface TeamConfig {
  name: string
  leadSessionId: string
  members: { name: string; agentId: string; joinedAt: number; backendType?: string }[]
}

interface Roster {
  name: string
  members: { name: string; agentId: string; joinedAt: number }[]
}

// Absent means the harness removed the team directory. Unreadable, unparseable (a torn read
// mid-rewrite), malformed or another session's team is 'unusable': there is nothing to
// watch, and it is never evidence that the team dissolved.
const loadTeamConfig = (rawSessionId: string): TeamConfig | 'absent' | 'unusable' => {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const path = join(configDir, 'teams', `session-${rawSessionId.slice(0, 8)}`, 'config.json')
  const read = readClassified(path)
  if (read.kind === 'absent') {
    return 'absent'
  }

  if (read.kind === 'unreadable') {
    return 'unusable'
  }

  try {
    const parsed = JSON.parse(read.content) as TeamConfig
    return parsed.leadSessionId === rawSessionId && Array.isArray(parsed.members)
      ? parsed
      : 'unusable'
  } catch {
    return 'unusable'
  }
}

// The members a pid can be read for: the team lead and an in-process member share the lead's own
// process, so neither is scanned (see the top-of-file comment).
const rosterOf = (config: TeamConfig): Roster => ({
  name: config.name,
  members: config.members
    .filter((m) => m.name !== 'team-lead' && m.backendType !== 'in-process')
    .map((m) => ({ name: m.name, agentId: m.agentId, joinedAt: m.joinedAt })),
})

const scanRoster = (
  roster: Roster,
  processes: RunningAgent[],
  dissolved: boolean
): TeammateScan => {
  const pidByAgentId = new Map(processes.map((p) => [p.agentId, p.pid]))
  const memberIds = new Set(roster.members.map((m) => m.agentId))
  return {
    team: roster.name,
    emptyReason: null,
    dissolved,
    members: roster.members.map((m) => ({ ...m, pid: pidByAgentId.get(m.agentId) ?? null })),
    orphans: processes.filter((p) => p.teamName === roster.name && !memberIds.has(p.agentId)),
  }
}

// Written only when it changed, so a poll that finds the same team costs a read, not a write. A
// failed write is warned about and does not fail the live scan it rides on.
const saveRoster = (roster: Roster, rawSessionId: string): void => {
  const content = JSON.stringify(roster, null, 2)
  const existing = readClassified(rosterPath(rawSessionId))
  if (existing.kind === 'content' && existing.content === content) {
    return
  }

  try {
    atomicWrite(rosterPath(rawSessionId), content)
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code ??
      (error instanceof Error ? error.message : String(error))
    console.error(
      `mailbox: could not save the teammate roster to ${rosterPath(rawSessionId)}: ${reason}`
    )
  }
}

// Absent means nothing was saved. A read that fails for any other reason, or content that is
// unparseable or not a roster, is 'unusable' — a saved roster that cannot be read is not evidence
// that no team existed.
const loadRoster = (rawSessionId: string): Roster | 'absent' | 'unusable' => {
  const read = readClassified(rosterPath(rawSessionId))
  if (read.kind === 'absent') {
    return 'absent'
  }

  if (read.kind === 'unreadable') {
    return 'unusable'
  }

  try {
    const parsed = JSON.parse(read.content) as unknown
    return isRoster(parsed) ? parsed : 'unusable'
  } catch {
    return 'unusable'
  }
}

const isRosterMember = (value: unknown): value is Roster['members'][number] =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'agentId' in value &&
  typeof value.agentId === 'string' &&
  'joinedAt' in value &&
  typeof value.joinedAt === 'number'

const isRoster = (value: unknown): value is Roster =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'members' in value &&
  Array.isArray(value.members) &&
  value.members.every(isRosterMember)

const rosterPath = (rawSessionId: string): string =>
  storePath(sessionGlobalScope(rawSessionId), ROSTER_FILENAME)

// A respawn under the same name has a new joinedAt, so its death reports again.
const deathKey = (death: TeammateStatus): string => `${death.agentId}:${death.joinedAt}`

const ledgerPath = (rawSessionId: string): string =>
  storePath(sessionGlobalScope(rawSessionId), LEDGER_FILENAME)

// Absent or torn ledger = nothing reported yet: a duplicate wake costs one look, a lost wake is
// the indefinite stall this file exists to end.
const loadLedger = (rawSessionId: string): string[] => {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(rawSessionId), 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}
