import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import {
  attributeSession,
  createAttributionIndex,
  indexGitBranch,
  indexSpawnedTeammate,
  populateProjectKeys,
  setUnambiguousParent,
  type Attribution,
  type Role,
  type TicketSource,
} from './attribution.ts'
import {
  buildPerTicketReport,
  buildSubagentStats,
  formatPerTicketReport,
  type PerTicketReport,
  type SubagentStat,
} from './per-ticket.ts'
import { formatNumber, formatTitle, renderTable, shortenModel } from './table.ts'

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

// It is `export`ed because `per-ticket.ts` imports it as a type only — `import type { UsageResponse }
// from './main.ts'`. The type-only import erases under `--experimental-transform-types`, so this is
// the only edge between the two modules; the runtime table primitives both files use live in
// `table.ts`, which imports from neither.
export type UsageResponse = TokenUsage & {
  date: string
  sessionId: string
  // The session that produced this response, never rewritten. `sessionId` is re-pointed at the
  // parent by attachParentSession so subagent usage rolls up; role and ticket attribution need the
  // teammate's own identity, which that rewrite destroys.
  //
  // Undefined only after mergeDuplicate finds two physical records behind the same response key that
  // disagree on which session produced them (e.g. the same request logged into two transcripts under
  // two different session ids). Neither candidate is more trustworthy than the other, so attribution
  // is dropped rather than handed to whichever record the file scan happened to visit last — the same
  // agreement-or-absence shape setAgreedValue already applies to spawn-record fields in
  // attribution.ts.
  rawSessionId?: string
  sessionName?: string
  model: string
  // False when this response was parsed from a `subagents/agent-*.jsonl` file rather than the
  // session's own top-level transcript. A sub-agent transcript is stamped with the parent's own
  // sessionId (see resolveRole in attribution.ts), so its tokens roll up into the parent's role —
  // correct for tokensByRole, a cost question — but its model is not the role's own model, which is
  // why buildTicketRows in per-ticket.ts excludes it from tokensByRoleModel specifically.
  ownTranscript: boolean
  // Set only when ownTranscript is false, to the `agentType` read from the sibling
  // `agent-<id>.meta.json` next to the sub-agent's own transcript file. A missing or unreadable meta
  // file, invalid JSON, or a non-string or empty `agentType` all fall back to the sentinel 'unknown'
  // -- the response still keeps its tokens and role either way.
  subagentType?: string
  role?: Role
  ticket?: string
  ticketSource?: TicketSource
  recordedNonTicket?: boolean
  project?: string
}

// A row is grouped by date/session/model AFTER attachParentSession has rewritten sessionId, so a
// lead and its teammate collapse into one row. Whichever response is scanned first would win, and
// its raw session id would look like an attribution key while being a scan-order artifact. Rows
// carry token counts; attribution stays on the per-response array.
export type UsageRow = Omit<
  UsageResponse,
  | 'rawSessionId'
  | 'ownTranscript'
  | 'role'
  | 'ticket'
  | 'ticketSource'
  | 'recordedNonTicket'
  | 'project'
> & {
  requests: number
  totalTokens: number
}

export type UsageReport = {
  timezone: 'local' | 'UTC'
  filesScanned: number
  malformedLines: number
  usageEntries: number
  uniqueRequests: number
  duplicateEntries: number
  recordsOutOfScope: number
  rows: UsageRow[]
  perTicket?: PerTicketReport
  subagentStats?: SubagentStat[]
}

// A sink for one output channel. Defaults to the real process stream; tests substitute a collector
// instead of monkeypatching process.stdout/stderr: node --test runs each file in a child process
// that serializes its own result-reporting protocol over that same stream, so a patched write can
// silently lose test results or desync the parser mid-run.
type Writer = (chunk: string) => void

const writeToStdout: Writer = (chunk) => {
  process.stdout.write(chunk)
}

const writeToStderr: Writer = (chunk) => {
  process.stderr.write(chunk)
}

type ClaudeUsageOptions = {
  claudeDir: string
  projectDirectory: string
  allProjects: boolean
  since?: string
  until?: string
  utc: boolean
  json: boolean
  project?: string
  perTicket?: boolean
  subagents?: boolean
  stdout?: Writer
  stderr?: Writer
}

type TranscriptRecord = {
  type?: unknown
  customTitle?: unknown
  teamName?: unknown
  agentName?: unknown
  gitBranch?: unknown
  requestId?: unknown
  uuid?: unknown
  timestamp?: unknown
  sessionId?: unknown
  session_id?: unknown
  cwd?: unknown
  toolUseResult?: unknown
  message?: {
    id?: unknown
    model?: unknown
    usage?: {
      input_tokens?: unknown
      output_tokens?: unknown
      cache_creation_input_tokens?: unknown
      cache_read_input_tokens?: unknown
    }
  }
}

export const runClaudeUsage = async (options: ClaudeUsageOptions): Promise<void> => {
  const stdout = options.stdout ?? writeToStdout
  const stderr = options.stderr ?? writeToStderr
  const report = await collectClaudeUsage(options)
  const includeSubagents = options.subagents === true
  stdout(
    options.json
      ? formatJson(report, includeSubagents)
      : report.perTicket !== undefined
        ? formatPerTicketReport(report.perTicket, includeSubagents, report.subagentStats ?? [])
        : formatUsageTable(report.rows)
  )
  if (!options.json) {
    // filesScanned and malformedLines are counted before the project-scope filter runs (see
    // collectClaudeUsage) and are genuinely scan-wide. uniqueRequests and duplicateEntries are
    // counted after it, so unless --all/--project is passed they reflect only records within
    // projectDirectory's scope, not the whole scan -- recordsOutOfScope is what that filter dropped.
    // "not window-scoped" is the one property still true of all four: none of them reflect
    // --since/--until either way, which is what this label has always been about.
    // Whoever moves the scope filter's position in collectClaudeUsage must update this comment and
    // the label together, or this drifts back into the false claim that all four figures are scan-wide.
    // Printed unconditionally, even at 0/0, so scan coverage is always visible -- gating it on a
    // dirty corpus meant a clean run never told the reader how much it had actually scanned.
    const outOfScopeClause =
      report.recordsOutOfScope > 0
        ? `; ignored ${report.recordsOutOfScope} records outside ${options.projectDirectory}`
        : ''
    stderr(
      `claude-usage (not window-scoped): scanned ${report.filesScanned} files, ` +
        `${report.uniqueRequests} unique requests; ignored ${report.duplicateEntries} duplicate ` +
        `entries and ${report.malformedLines} malformed lines${outOfScopeClause}\n`
    )
  }
}

export const collectClaudeUsage = async (
  options: Omit<ClaudeUsageOptions, 'json'>
): Promise<UsageReport> => {
  const stderr = options.stderr ?? writeToStderr
  const projectsDir = join(options.claudeDir, 'projects')
  if (!existsSync(projectsDir))
    throw new Error(`Claude projects directory not found: ${projectsDir}`)

  const responses = new Map<string, UsageResponse>()
  const sessionNames = new Map<string, string>()
  const teammateAgents = new Map<string, string>()
  const spawnedAgentParents = new Map<string, string>()
  const ambiguousSpawnedAgents = new Set<string>()
  const attributionIndex = createAttributionIndex()
  const attributionCache = new Map<string, Attribution>()
  const attributionFor = (rawSessionId: string): Attribution => {
    const cached = attributionCache.get(rawSessionId)
    if (cached !== undefined) return cached
    const resolved = attributeSession(rawSessionId, attributionIndex, options.claudeDir)
    attributionCache.set(rawSessionId, resolved)
    return resolved
  }
  let malformedLines = 0
  let usageEntries = 0
  let recordsOutOfScope = 0
  // --project names a project by substring, which means "that project", not "the cwd's project" --
  // so it implies --all. Without this, --project almost always returns 0 rows (the cwd's project
  // directory is scanned, then filtered by a substring that has no reason to match it), and 0 rows
  // can't be told apart from "no usage matching that substring".
  const scanAllProjects = options.allProjects || options.project !== undefined
  const scanRoots = getScanRoots(projectsDir, options.projectDirectory, scanAllProjects, stderr)
  const files = scanRoots.flatMap((root) => listTranscriptFiles(root))

  for (const file of files) {
    const project = projectOf(projectsDir, file)
    const ownTranscript = !isSubagentTranscript(projectsDir, file)
    const subagentType = ownTranscript ? undefined : readSubagentType(file)

    let lineNumber = 0
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      lineNumber += 1
      let record: TranscriptRecord
      try {
        record = JSON.parse(line) as TranscriptRecord
      } catch {
        malformedLines += 1
        continue
      }

      const sessionName = parseSessionName(record)
      if (sessionName !== undefined) sessionNames.set(sessionName.sessionId, sessionName.title)

      const teammate = parseTeammate(record)
      if (teammate !== undefined) teammateAgents.set(teammate.sessionId, teammate.agentId)

      const spawnedAgent = parseSpawnedAgent(record)
      if (spawnedAgent !== undefined) {
        setUnambiguousParent(
          spawnedAgentParents,
          ambiguousSpawnedAgents,
          spawnedAgent.agentId,
          spawnedAgent.parentSessionId
        )
      }

      const sessionIdForIndex = record.sessionId ?? record.session_id
      if (typeof sessionIdForIndex === 'string') {
        if (typeof record.agentName === 'string' && typeof record.teamName === 'string') {
          attributionIndex.agentIdBySession.set(
            sessionIdForIndex,
            `${record.agentName}@${record.teamName}`
          )
        }
        if (typeof record.gitBranch === 'string' && record.gitBranch.length > 0) {
          indexGitBranch(attributionIndex, record.gitBranch, sessionIdForIndex)
        }
        if (
          typeof record.toolUseResult === 'object' &&
          record.toolUseResult !== null &&
          !Array.isArray(record.toolUseResult)
        ) {
          indexSpawnedTeammate(attributionIndex, record.toolUseResult, sessionIdForIndex)
        }
      }

      const response = parseUsageResponse(record, options.utc, ownTranscript, subagentType)
      if (response === undefined) continue
      if (!scanAllProjects && !withinProjectScope(record, options.projectDirectory)) {
        recordsOutOfScope += 1
        continue
      }
      response.project = project
      usageEntries += 1

      const responseKey = getResponseKey(record, file, lineNumber)
      const previous = responses.get(responseKey)
      responses.set(
        responseKey,
        previous === undefined ? response : mergeDuplicate(previous, response)
      )
    }
  }

  // Load-bearing position, not a performance choice: `ticketByAgentId` is only complete once every
  // transcript line has been read, and `attributionFor` — the first reader of `projectKeys` — is
  // not called until the `.map` chain below. Populating any earlier leaves the tier-4 vocabulary
  // silently missing every project key that was seen only in a spawn prompt.
  populateProjectKeys(attributionIndex, options.claudeDir)

  const filtered = Array.from(responses.values())
    .map((response) =>
      attachParentSession(response, teammateAgents, spawnedAgentParents, ambiguousSpawnedAgents)
    )
    .map((response) => attachSessionName(response, sessionNames.get(response.sessionId)))
    .map((response) => ({
      ...response,
      // No rawSessionId means mergeDuplicate saw two candidate sessions disagree and dropped
      // attribution (see the field's comment on UsageResponse) -- there is no session id left to
      // attribute with, so this response contributes tokens but no role/ticket/project.
      ...(response.rawSessionId === undefined ? {} : attributionFor(response.rawSessionId)),
    }))
    .filter(
      ({ date, project }) =>
        (options.since === undefined || date >= options.since) &&
        (options.until === undefined || date <= options.until) &&
        (options.project === undefined ||
          (project ?? '').toLowerCase().includes(options.project.toLowerCase()))
    )
  const rows = groupResponses(filtered)
  const perTicket = options.perTicket ? buildPerTicketReport(filtered) : undefined

  return {
    timezone: options.utc ? 'UTC' : 'local',
    filesScanned: files.length,
    malformedLines,
    usageEntries,
    uniqueRequests: responses.size,
    duplicateEntries: usageEntries - responses.size,
    recordsOutOfScope,
    rows,
    ...(perTicket === undefined ? {} : { perTicket }),
    ...(perTicket !== undefined && options.subagents
      ? { subagentStats: buildSubagentStats(perTicket.tickets) }
      : {}),
  }
}

// directoryToProjectKey maps every non-alphanumeric character to '-', so it isn't invertible --
// a descendant directory's key always extends its parent's (key(parent + '/' + child) ===
// key(parent) + '-' + key(child), since the join adds exactly one '/', itself mapped to '-'), but the
// reverse isn't true: a key that extends another key doesn't have to come from a real descendant path.
// Scanning every directory whose key starts with `${key}-` is therefore a sound superset -- it can
// over-collect (a hyphen-named sibling like `projects-my-plugin` collides with a real child
// `projects/my-plugin`) but can never miss a real descendant, which prefix-matching alone
// cannot resolve since the key has already thrown away which character the hyphen came from. That's
// resolved below in withinProjectScope, using each record's own real cwd instead of the lossy key.
export const getScanRoots = (
  projectsDir: string,
  projectDirectory: string,
  allProjects: boolean,
  stderr: Writer
): string[] => {
  if (allProjects) return [projectsDir]
  const key = directoryToProjectKey(projectDirectory)
  const roots = readdirSync(projectsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && (entry.name === key || entry.name.startsWith(`${key}-`))
    )
    .map((entry) => join(projectsDir, entry.name))
  if (roots.length === 0) stderr(`claude-usage: no Claude project found for ${projectDirectory}\n`)
  return roots
}

const directoryToProjectKey = (directory: string): string => {
  return directory.replaceAll(/[^a-zA-Z0-9]/g, '-')
}

// getScanRoots' key-prefix match can over-collect (see its comment) -- a scanned directory isn't
// proof a record actually belongs under `projectDirectory`. Each usage record carries the real
// absolute cwd it ran from, so it can answer that exactly rather than through the lossy key; this
// applies to the exact-key directory too, which has the same collision (`/a/b-c` and `/a/b/c` both
// map to the same key) and was unguarded before this check. A record with no cwd at all is kept
// rather than dropped: its directory was already selected by getScanRoots, and silently discarding
// tokens from a record shape this hasn't seen before is the wrong failure direction. Measured
// 2026-08-24: 0 records with no `cwd` key and 0 with a non-string `cwd`, out of 478,180 usage-bearing
// records across 1,307 transcripts containing at least one usage-bearing record -- re-run that count
// before relying on this. If it ever goes non-zero, this keep-by-default choice starts applying to a
// real, non-trivial population instead of a theoretical shape, which is worth re-weighing.
const withinProjectScope = (record: TranscriptRecord, projectDirectory: string): boolean => {
  if (typeof record.cwd !== 'string') return true
  return record.cwd === projectDirectory || record.cwd.startsWith(`${projectDirectory}/`)
}

export const listTranscriptFiles = (root: string): string[] => {
  const files: string[] = []
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory === undefined) break
    // readdirSync's withFileTypes returns each entry as a Dirent built from lstat semantics — it
    // describes the directory entry itself, not what a symlink resolves to — so entry.isDirectory()
    // is false for a symlink even when it points at a directory, including one pointing back at an
    // ancestor. A symlink is therefore never pushed onto `directories`, so this walk can't cycle on
    // one. Two rewrites would silently reintroduce that: readdirSync(..., { recursive: true }), and
    // any statSync-based walk (statSync follows the link). The cost isn't limited to loops, either:
    // every symlinked directory is skipped this way, not only a looping one — a symlink to a real
    // projects directory would vanish from the scan with no signal that anything was missed.
    //
    // Measured under ~/.claude/projects on 2026-08-24: 2 symlinks in the whole tree, both at depth
    // 2, both self-loops pointing at their own parent directory, and 0 .jsonl files anywhere below
    // either one — so today this costs nothing. Re-run before relying on this figure; it can only
    // grow stale.
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  return files.sort()
}

// A sub-agent's transcript nests under its parent session inside the same project directory --
// <project>/<parent-session-id>/subagents/agent-<taskId>.jsonl, or shallower/deeper if the harness
// ever moves that directory a level -- and every record in it is stamped with the parent session's
// own sessionId rather than a distinct one of its own, so the file path is the only reliable
// discriminator for "did this response come from the session's own transcript." Keyed on 'subagents'
// appearing anywhere among the middle segments (excluding the project at the front and the filename
// at the back), not only immediately before the file, so a transcript nested at any depth relative to
// the current known shape is still caught rather than silently read as the session's own. `includes`
// checks each segment for exact equality, so a project directory whose encoded name merely contains
// the word 'subagents' as a substring was never going to match regardless of slicing. What slicing
// the project segment off before searching excludes is narrower: a project directory encoded as
// exactly 'subagents' would otherwise be read as its own first segment matching the search, misreading
// a project's own name as a nested sub-agent directory.
const isSubagentTranscript = (projectsDir: string, file: string): boolean => {
  const segments = relative(projectsDir, file).split(sep)
  return segments.slice(1, -1).includes('subagents')
}

const SUBAGENT_TYPE_UNKNOWN = 'unknown'

const readSubagentType = (transcriptFile: string): string => {
  const metaFile = transcriptFile.replace(/\.jsonl$/, '.meta.json')

  try {
    const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as { agentType?: unknown }

    return typeof parsed.agentType === 'string' && parsed.agentType.length > 0
      ? parsed.agentType
      : SUBAGENT_TYPE_UNKNOWN
  } catch {
    return SUBAGENT_TYPE_UNKNOWN
  }
}

const parseSessionName = (
  record: TranscriptRecord
): { sessionId: string; title: string } | undefined => {
  const sessionId = record.sessionId ?? record.session_id
  if (
    record.type !== 'custom-title' ||
    typeof sessionId !== 'string' ||
    typeof record.customTitle !== 'string' ||
    record.customTitle.trim().length === 0
  ) {
    return undefined
  }
  return { sessionId, title: record.customTitle.trim() }
}

const parseTeammate = (
  record: TranscriptRecord
): { sessionId: string; agentId: string } | undefined => {
  const sessionId = record.sessionId ?? record.session_id
  if (
    typeof sessionId !== 'string' ||
    typeof record.teamName !== 'string' ||
    typeof record.agentName !== 'string'
  ) {
    return undefined
  }
  return { sessionId, agentId: `${record.agentName}@${record.teamName}` }
}

const parseSpawnedAgent = (
  record: TranscriptRecord
): { agentId: string; parentSessionId: string } | undefined => {
  const result = record.toolUseResult
  const parentSessionId = record.sessionId ?? record.session_id
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result) ||
    !('status' in result) ||
    result.status !== 'teammate_spawned' ||
    typeof parentSessionId !== 'string'
  ) {
    return undefined
  }

  const agentId =
    ('agent_id' in result && typeof result.agent_id === 'string' && result.agent_id) ||
    ('teammate_id' in result && typeof result.teammate_id === 'string' && result.teammate_id)
  return agentId ? { agentId, parentSessionId } : undefined
}

const attachParentSession = (
  response: UsageResponse,
  teammateAgents: ReadonlyMap<string, string>,
  spawnedAgentParents: ReadonlyMap<string, string>,
  ambiguousSpawnedAgents: ReadonlySet<string>
): UsageResponse => {
  const agentId = teammateAgents.get(response.sessionId)
  if (agentId === undefined || ambiguousSpawnedAgents.has(agentId)) return response
  const parentSessionId = spawnedAgentParents.get(agentId)
  return parentSessionId === undefined ? response : { ...response, sessionId: parentSessionId }
}

const attachSessionName = (response: UsageResponse, sessionName?: string): UsageResponse => {
  return sessionName === undefined ? response : { ...response, sessionName }
}

const parseUsageResponse = (
  record: TranscriptRecord,
  utc: boolean,
  ownTranscript: boolean,
  subagentType: string | undefined
): UsageResponse | undefined => {
  const usage = record.message?.usage
  const model = record.message?.model
  if (usage === undefined || model === '<synthetic>' || typeof record.timestamp !== 'string') {
    return undefined
  }

  const timestamp = new Date(record.timestamp)
  if (Number.isNaN(timestamp.valueOf())) return undefined

  const sessionId = record.sessionId ?? record.session_id
  const resolvedSessionId = typeof sessionId === 'string' ? sessionId : 'unknown'

  return {
    date: formatDate(timestamp, utc),
    sessionId: resolvedSessionId,
    rawSessionId: resolvedSessionId,
    model: typeof model === 'string' ? model : 'unknown',
    ownTranscript,
    ...(subagentType === undefined ? {} : { subagentType }),
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheCreationInputTokens: tokenCount(usage.cache_creation_input_tokens),
    cacheReadInputTokens: tokenCount(usage.cache_read_input_tokens),
  }
}

const getResponseKey = (record: TranscriptRecord, file: string, lineNumber: number): string => {
  if (typeof record.requestId === 'string') return `request:${record.requestId}`
  if (typeof record.message?.id === 'string') return `message:${record.message.id}`
  if (typeof record.uuid === 'string') return `entry:${record.uuid}`
  return `line:${basename(file)}:${lineNumber}`
}

// `current` wins every other field by spreading last, including sessionId and rawSessionId -- when
// two records behind the same response key disagree, neither candidate is more trustworthy than the
// other, so scan order must not decide the winner for either field. sessionId is guarded by
// unknownUnlessAgrees: agreement keeps the value, disagreement falls back to the 'unknown' sentinel --
// the same sentinel parseUsageResponse already assigns when a record carries no usable session id at
// all. shortenSessionId already special-cases 'unknown', and neither teammateAgents.get nor
// sessionNames.get will match it, so a disagreeing pair degrades to exactly the same state as a
// session-less record, deterministically. That reaches a printed table: groupResponses keys the
// default `--all` table on date/sessionId/model, so two disagreeing responses for the same day and
// model collapse into that day's 'unknown' row instead of being attributed to an arbitrary one of the
// two real sessions -- a wrong-but-specific attribution is worse than an honest unknown.
//
// rawSessionId is not harmless the same way: attributionFor treats it as ground truth for role,
// ticket, and project. Once two records behind the same response key disagree, discardUnlessAgrees
// applies setAgreedValue's rule: agreement keeps the value, disagreement yields absence -- and stays
// absent even if a third record for the same key agrees with one side, matching setAgreedValue's own
// "a delete never re-added" behavior for spawn-record fields.
//
// ownTranscript disagreement is not corruption the way sessionId/rawSessionId disagreement is:
// a sub-agent's transcript is stamped with the parent's own sessionId, so its records legitimately
// share a response key with a copy the harness also wrote into the session's own top-level file --
// two truthful files, not two conflicting candidates. Whether a response counts as the session's own
// is settled the moment either copy says so, so agreement is not required here: true wins.
//
// model is guarded the same way sessionId is, and for a sharper reason: ownTranscript's true-wins
// rule means a merged pair can carry ownTranscript: true from one copy and, unguarded, current's
// model from the other -- letting a sub-agent's model win the field that buildTicketRows trusts as
// the role's own, the exact bleed ownTranscript exists to stop. Disagreement falls back to 'unknown',
// the same sentinel parseUsageResponse already assigns when a record carries no usable model at all.
//
// subagentType follows ownTranscript's own true-wins result rather than being guarded independently:
// once the merged response is an own-transcript response, subagentType has no meaning for it, so it
// is dropped rather than carried over from whichever copy happened to be a sub-agent one. Otherwise
// (both copies are sub-agent responses) it is guarded the same way model is -- agreement keeps the
// value, disagreement falls back to 'unknown'.
const mergeDuplicate = (previous: UsageResponse, current: UsageResponse): UsageResponse => {
  const ownTranscript = previous.ownTranscript || current.ownTranscript

  return {
    ...current,
    inputTokens: Math.max(previous.inputTokens, current.inputTokens),
    outputTokens: Math.max(previous.outputTokens, current.outputTokens),
    cacheCreationInputTokens: Math.max(
      previous.cacheCreationInputTokens,
      current.cacheCreationInputTokens
    ),
    cacheReadInputTokens: Math.max(previous.cacheReadInputTokens, current.cacheReadInputTokens),
    // A date has no sentinel the way sessionId can fall back to 'unknown' -- there is no such thing
    // as an unknown date, and every downstream consumer groups and filters on this field. The earlier
    // of the two candidates wins, not because it is more correct than the later one, but because scan
    // order must not be what decides. ISO YYYY-MM-DD sorts lexically in chronological order, so the
    // comparison needs no parsing.
    date: previous.date < current.date ? previous.date : current.date,
    sessionId: unknownUnlessAgrees(previous.sessionId, current.sessionId),
    rawSessionId: discardUnlessAgrees(previous.rawSessionId, current.rawSessionId),
    ownTranscript,
    model: unknownUnlessAgrees(previous.model, current.model),
    // `...current` above may already carry a subagentType (e.g. current itself is the sub-agent
    // copy while previous is the own-transcript one) -- an explicit undefined here is required to
    // actually clear it, not merely to avoid adding one.
    subagentType: ownTranscript
      ? undefined
      : unknownUnlessAgrees(
          previous.subagentType ?? SUBAGENT_TYPE_UNKNOWN,
          current.subagentType ?? SUBAGENT_TYPE_UNKNOWN
        ),
  }
}

const unknownUnlessAgrees = (previous: string, current: string): string =>
  previous === current ? current : 'unknown'

const discardUnlessAgrees = (
  previous: string | undefined,
  current: string | undefined
): string | undefined => (previous === current ? current : undefined)

const groupResponses = (responses: UsageResponse[]): UsageRow[] => {
  const groups = new Map<string, UsageRow>()
  for (const response of responses) {
    const key = `${response.date}\0${response.sessionId}\0${response.model}`
    const row = groups.get(key) ?? {
      date: response.date,
      sessionId: response.sessionId,
      ...(response.sessionName === undefined ? {} : { sessionName: response.sessionName }),
      model: response.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    }
    row.requests += 1
    row.inputTokens += response.inputTokens
    row.outputTokens += response.outputTokens
    row.cacheCreationInputTokens += response.cacheCreationInputTokens
    row.cacheReadInputTokens += response.cacheReadInputTokens
    row.totalTokens =
      row.inputTokens + row.outputTokens + row.cacheCreationInputTokens + row.cacheReadInputTokens
    groups.set(key, row)
  }
  return Array.from(groups.values()).sort((left, right) =>
    [left.date, left.sessionId, left.model]
      .join('\0')
      .localeCompare([right.date, right.sessionId, right.model].join('\0'))
  )
}

const formatDate = (date: Date, utc: boolean): string => {
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const tokenCount = (value: unknown): number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

// The Claude project directory a transcript lives under — the encoded launch cwd, e.g.
// `-Users-me-Projects-my-plugin`. Subagent transcripts nest under their
// parent session inside the same project directory, so the first segment is always the project.
// `split` on a relative path always yields at least one element, so this is never undefined.
const projectOf = (projectsDir: string, file: string): string => {
  const [project] = relative(projectsDir, file).split(sep)
  return project
}

export const formatUsageTable = (rows: UsageRow[]): string => {
  const headers = [
    'Date',
    'Session',
    'Model',
    'Requests',
    'Input',
    'Output',
    'Cache Create',
    'Cache Read',
    'Total Tokens',
  ]
  const values = rows.map((row, index) => {
    const previous = rows[index - 1]
    const sameSession = previous?.date === row.date && previous.sessionId === row.sessionId
    return [
      sameSession ? '' : row.date,
      sameSession ? '' : (row.sessionName ?? shortenSessionId(row.sessionId)),
      shortenModel(row.model),
      formatNumber(row.requests),
      formatNumber(row.inputTokens),
      formatNumber(row.outputTokens),
      formatNumber(row.cacheCreationInputTokens),
      formatNumber(row.cacheReadInputTokens),
      formatNumber(row.totalTokens),
    ]
  })
  const title = formatTitle('Claude Code Usage by Day / Session / Model')
  const table = renderTable(headers, values, NUMERIC_COLUMNS)
  return `${title}\n\n${table}\n`
}

const NUMERIC_COLUMNS = new Set([3, 4, 5, 6, 7, 8])

const shortenSessionId = (sessionId: string): string => {
  return sessionId === 'unknown' ? sessionId : sessionId.slice(0, 8)
}

// Without --subagents, tokensBySubagent is stripped from the JSON rather than merely left absent from
// the report -- buildTicketRows always populates it (per-ticket.ts), so it is on every TicketRow
// regardless of the flag, and only this replacer keeps the flag's off-state byte-identical to today.
const formatJson = (report: UsageReport, includeSubagentBreakdown: boolean): string => {
  const replacer = includeSubagentBreakdown
    ? undefined
    : (key: string, value: unknown) => (key === 'tokensBySubagent' ? undefined : value)

  return `${JSON.stringify(report, replacer, 2)}\n`
}
