import type { Role, TicketSource } from './attribution.ts'
import type { UsageResponse } from './main.ts'
import { formatNumber, formatTitle, renderTable, shortenModel } from './table.ts'

export type TicketRow = {
  ticket: string
  sessions: number
  requests: number
  tokensByRole: Partial<Record<Role, number>>
  // Tokens split by role AND by the model that produced them. tokensByRole answers "what did the
  // implementer cost on this ticket"; this answers "which model was the implementer", which is the
  // question the review-churn comparison actually joins on. Kept as a separate field rather than
  // replacing tokensByRole so every existing reader of that field is unaffected.
  //
  // Only counts responses from a session's own transcript (UsageResponse.ownTranscript) — a
  // sub-agent's tokens are included in tokensByRole under the role that spawned it, but not here,
  // since the sub-agent's model is not that role's own model. The two fields therefore describe
  // different populations for the same role on nearly every real ticket — every implementer session
  // spawns sub-agents — which is why formatTicketsTable's Impl Model cell names the gap inline
  // rather than letting a reader take the two adjacent columns as one figure decomposing the other.
  tokensByRoleModel: Partial<Record<Role, Record<string, number>>>
  // Tokens split by role AND by the sub-agent type that produced them -- only responses from a
  // sub-agent transcript (UsageResponse.ownTranscript false), keyed under the same role the response
  // already rolls into. tokensByRoleModel and this field partition a role's tokens by ownTranscript:
  // for every role, sum(tokensBySubagent[role]) equals tokensByRole[role] minus the sum of
  // tokensByRoleModel[role].
  tokensBySubagent: Partial<Record<Role, Record<string, number>>>
  teammateTokens: number
  totalTokens: number
  cacheReadTokens: number
}

export type RoleStats = {
  role: Role | 'teammate'
  tickets: number
  meanTokens: number
  medianTokens: number
  worstTokens: number
  worstTicket?: string
}

// One row summarizing a (role, sub-agent type) pair from tokensBySubagent, aggregated across every
// ticket in the window. Role here is any REAL_ROLES member, not only implementer/senior-engineer: a
// team-lead, solo, or other session can spawn sub-agents too.
export type SubagentStat = {
  role: Role
  subagentType: string
  tickets: number
  meanTokens: number
  totalTokens: number
}

export type DayRoleRow = {
  date: string
  role: Role
  sessions: number
  requests: number
  totalTokens: number
  cacheReadTokens: number
}

export type Coverage = {
  sessions: number
  sessionsWithTicket: number
  totalTokens: number
  tokensWithTicket: number
  tokensBySource: Record<TicketSource, number>
  // Of the unattributed tokens, the subset whose session DID have a workflow-state record — just
  // one with no ticket-shaped token in it (a literal board key). Split out from the rest of
  // "unattributed" (never recorded at all) so the footer doesn't conflate the two.
  tokensRecordedNonTicket: number
}

export type PerTicketReport = {
  tickets: TicketRow[]
  stats: RoleStats[]
  days: DayRoleRow[]
  coverage: Coverage
}

// `teammate` is implementer + senior-engineer. It is the denominator the PRD's per-ticket target is
// set against: the lead's cost is real but is not per-ticket implementation work.
const TEAMMATE_ROLES: ReadonlySet<Role> = new Set<Role>(['implementer', 'senior-engineer'])

// Every Role member, in table-ordering order. 'solo' and 'other' are real token-bearing roles (see
// the Other column comment in formatTicketsTable), not a rendering afterthought.
const REAL_ROLES: Role[] = ['implementer', 'senior-engineer', 'team-lead', 'solo', 'other']

// Input is the per-response array, NOT `UsageRow[]`. groupResponses keys a row on
// `${date}\0${sessionId}\0${model}` after attachParentSession has already rewritten sessionId to the
// parent, so whenever a team lead and one of its teammates emit a response for the same model on the
// same day, both collapse into one row: only the first-scanned response's identity survives while
// both responses' tokens are summed in. A row cannot carry rawSessionId, role, or ticket without
// presenting that arbitrary scan-order winner as fact, so aggregating the report off rows would
// silently misattribute exactly the number this story exists to produce.
export const buildPerTicketReport = (responses: UsageResponse[]): PerTicketReport => {
  const ticketRows = buildTicketRows(responses)
  return {
    tickets: ticketRows,
    stats: buildRoleStats(ticketRows),
    days: buildDayRoleRows(responses),
    coverage: buildCoverage(responses),
  }
}

// A response is one request; rows are where `requests` and `totalTokens` get precomputed, and we
// are deliberately not using rows.
const responseTokens = (response: UsageResponse): number =>
  response.inputTokens +
  response.outputTokens +
  response.cacheCreationInputTokens +
  response.cacheReadInputTokens

const buildTicketRows = (responses: UsageResponse[]): TicketRow[] => {
  const tickets = new Map<string, TicketRow>()
  const sessionsSeen = new Map<string, Set<string>>()

  for (const response of responses) {
    if (response.ticket === undefined) continue
    const tokens = responseTokens(response)
    const existing = tickets.get(response.ticket) ?? emptyTicketRow(response.ticket)
    const role = response.role ?? 'solo'

    existing.requests += 1
    existing.totalTokens += tokens
    existing.cacheReadTokens += response.cacheReadInputTokens
    existing.tokensByRole[role] = (existing.tokensByRole[role] ?? 0) + tokens
    if (TEAMMATE_ROLES.has(role)) existing.teammateTokens += tokens

    if (response.ownTranscript) {
      const byModel = (existing.tokensByRoleModel[role] ??= {})
      byModel[response.model] = (byModel[response.model] ?? 0) + tokens
    } else {
      const bySubagent = (existing.tokensBySubagent[role] ??= {})
      const subagentType = response.subagentType ?? 'unknown'
      bySubagent[subagentType] = (bySubagent[subagentType] ?? 0) + tokens
    }

    tickets.set(response.ticket, existing)

    // rawSessionId is only absent when mergeDuplicate dropped attribution for a session disagreement
    // (see UsageResponse in main.ts) -- but that always leaves `ticket` undefined too, so the
    // `continue` above already excludes every response this branch would otherwise need to guard.
    const seen = sessionsSeen.get(response.ticket) ?? new Set<string>()
    if (response.rawSessionId !== undefined) seen.add(response.rawSessionId)
    sessionsSeen.set(response.ticket, seen)
  }

  for (const [ticket, row] of tickets) row.sessions = sessionsSeen.get(ticket)?.size ?? 0

  return Array.from(tickets.values()).sort((left, right) => right.totalTokens - left.totalTokens)
}

const buildRoleStats = (tickets: TicketRow[]): RoleStats[] => {
  // Every Role member gets a stats row, same as 'teammate' -- dropping one here would silently
  // exclude its tickets from mean/median the same way a table that skips a role from tokensByRole
  // would understate the row's own total.
  const roles: (Role | 'teammate')[] = ['teammate', ...REAL_ROLES]

  return roles.map((role) => {
    const scored = tickets
      .map((ticket) => ({
        ticket: ticket.ticket,
        tokens: role === 'teammate' ? ticket.teammateTokens : (ticket.tokensByRole[role] ?? 0),
      }))
      .filter((entry) => entry.tokens > 0)
      .sort((left, right) => left.tokens - right.tokens)
    const values = scored.map((entry) => entry.tokens)
    const worst = scored.at(-1)
    return {
      role,
      tickets: values.length,
      meanTokens: mean(values),
      medianTokens: median(values),
      worstTokens: worst?.tokens ?? 0,
      worstTicket: worst?.ticket,
    }
  })
}

// The tokensBySubagent counterpart to buildRoleStats: keyed on the sub-agent's own type rather than
// role alone, with no median/worst since the summary table only needs mean. A (role, subagentType)
// pair with only zero-token entries gets no row.
export const buildSubagentStats = (tickets: TicketRow[]): SubagentStat[] => {
  const totals = new Map<string, { role: Role; subagentType: string; perTicketTokens: number[] }>()

  for (const ticket of tickets) {
    for (const role of REAL_ROLES) {
      const bySubagent = ticket.tokensBySubagent[role]
      if (bySubagent === undefined) {
        continue
      }
      for (const [subagentType, tokens] of Object.entries(bySubagent)) {
        if (tokens <= 0) {
          continue
        }
        const key = `${role}\0${subagentType}`
        const existing = totals.get(key) ?? { role, subagentType, perTicketTokens: [] }
        existing.perTicketTokens.push(tokens)
        totals.set(key, existing)
      }
    }
  }

  return Array.from(totals.values())
    .map(({ role, subagentType, perTicketTokens }) => ({
      role,
      subagentType,
      tickets: perTicketTokens.length,
      meanTokens: mean(perTicketTokens),
      totalTokens: perTicketTokens.reduce((total, value) => total + value, 0),
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
}

const buildDayRoleRows = (responses: UsageResponse[]): DayRoleRow[] => {
  const rows = new Map<string, DayRoleRow>()
  const sessionsSeen = new Map<string, Set<string>>()
  for (const response of responses) {
    const role = response.role ?? 'solo'
    const key = `${response.date}\0${role}`
    const existing = rows.get(key) ?? {
      date: response.date,
      role,
      sessions: 0,
      requests: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
    }
    existing.requests += 1
    existing.totalTokens += responseTokens(response)
    existing.cacheReadTokens += response.cacheReadInputTokens
    rows.set(key, existing)

    // Requests/tokens above are counted regardless -- a merged duplicate's totals aren't in doubt,
    // only which session produced it (see UsageResponse.rawSessionId in main.ts) -- but a dropped
    // session id can't be attributed to either candidate's count without picking a winner, so it's
    // simply not counted as a distinct session.
    const seen = sessionsSeen.get(key) ?? new Set<string>()
    if (response.rawSessionId !== undefined) seen.add(response.rawSessionId)
    sessionsSeen.set(key, seen)
  }
  for (const [key, row] of rows) row.sessions = sessionsSeen.get(key)?.size ?? 0
  return Array.from(rows.values()).sort(
    (left, right) => left.date.localeCompare(right.date) || left.role.localeCompare(right.role)
  )
}

const buildCoverage = (responses: UsageResponse[]): Coverage => {
  const sessions = new Set<string>()
  const sessionsWithTicket = new Set<string>()
  const tokensBySource: Record<TicketSource, number> = {
    'workflow-state': 0,
    'spawn-prompt': 0,
    inherited: 0,
    'git-branch': 0,
  }
  let totalTokens = 0
  let tokensWithTicket = 0
  let tokensRecordedNonTicket = 0

  for (const response of responses) {
    const tokens = responseTokens(response)
    totalTokens += tokens
    // A dropped session id (see UsageResponse.rawSessionId in main.ts) can't be attributed to either
    // disagreeing candidate's count without picking a winner, so it's excluded from `sessions` too --
    // its tokens still land in totalTokens above and, since it never gets a ticket, in "Unattributed"
    // below.
    if (response.rawSessionId !== undefined) sessions.add(response.rawSessionId)
    if (response.ticket === undefined) {
      if (response.recordedNonTicket === true) tokensRecordedNonTicket += tokens
      continue
    }
    if (response.rawSessionId !== undefined) sessionsWithTicket.add(response.rawSessionId)
    tokensWithTicket += tokens
    if (response.ticketSource !== undefined) {
      tokensBySource[response.ticketSource] = tokensBySource[response.ticketSource] + tokens
    }
  }

  return {
    sessions: sessions.size,
    sessionsWithTicket: sessionsWithTicket.size,
    totalTokens,
    tokensWithTicket,
    tokensBySource,
    tokensRecordedNonTicket,
  }
}

const emptyTicketRow = (ticket: string): TicketRow => ({
  ticket,
  sessions: 0,
  requests: 0,
  tokensByRole: {},
  tokensByRoleModel: {},
  tokensBySubagent: {},
  teammateTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
})

const mean = (sorted: number[]): number =>
  sorted.length === 0 ? 0 : sorted.reduce((total, value) => total + value, 0) / sorted.length

// Standard median on an ascending array: the middle value, or the average of the two middle values
// for an even count. Returns 0 for an empty set rather than NaN, so an empty report formats.
const median = (sorted: number[]): number => {
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

// The coverage footer is not optional decoration: every mean and median in the tables above it is
// computed only over attributed tokens, so a reader comparing two runs at different coverage levels
// is comparing different populations.
export const formatPerTicketReport = (
  report: PerTicketReport,
  includeSubagents = false,
  subagentStats: SubagentStat[] = []
): string => {
  const title = formatTitle('Claude Code Usage by Ticket / Role')
  const tickets = formatTicketsTable(report.tickets)
  const stats = formatStatsTable(report.stats)
  const days = formatDaysTable(report.days)
  const coverage = formatCoverage(report.coverage)
  const subagentSection = includeSubagents
    ? `Sub-agent spend\n${formatSubagentTicketsTable(report.tickets)}\n\n` +
      `Sub-agent summary\n${formatSubagentStatsTable(subagentStats)}\n\n`
    : ''

  return (
    `${title}\n\n${tickets}\n\n` +
    `Per-ticket statistics\n${stats}\n\n` +
    subagentSection +
    `By day and role\n${days}\n\n` +
    `${coverage}\n`
  )
}

const formatTicketsTable = (tickets: TicketRow[]): string => {
  const headers = [
    'Ticket',
    'Sessions',
    'Requests',
    'Implementer',
    'Impl Model',
    'Senior',
    'Lead',
    'Solo/Other',
    'Total Tokens',
    'Cache Read %',
  ]
  const values = tickets.map((row) => [
    row.ticket,
    formatNumber(row.sessions),
    formatNumber(row.requests),
    formatNumber(row.tokensByRole.implementer ?? 0),
    implementerModels(row),
    formatNumber(row.tokensByRole['senior-engineer'] ?? 0),
    formatNumber(row.tokensByRole['team-lead'] ?? 0),
    // 'solo' and 'other' are the two Role members with no dedicated column — 'solo' reaches a
    // ticket via a session with no teammate spawn record at all, and 'other' via a spawn record
    // whose agent_type isn't implementer or senior-engineer. Either way they hold real tokens and
    // must not vanish from the table's row total.
    formatNumber((row.tokensByRole.solo ?? 0) + (row.tokensByRole.other ?? 0)),
    formatNumber(row.totalTokens),
    `${formatPercent(row.cacheReadTokens, row.totalTokens)}%`,
  ])
  return renderTable(headers, values, new Set([1, 2, 3, 5, 6, 7, 8, 9]))
}

// The model(s) behind the Implementer column, largest token share first. A ticket can show more
// than one model here for three different reasons: the implementer role was genuinely filled by
// different models across sessions (e.g. a model override can run an implementer on a model its
// definition doesn't declare -- a known defect, not intended behavior); a single session's own
// duplicate transcript records disagreed on model and mergeDuplicate's unknownUnlessAgrees guard
// fell back to the literal 'unknown'; or a response carried usage but no model at all, which
// parseUsageResponse also assigns 'unknown' -- no duplicate, no disagreement, just a record with
// nothing to attribute. The second and third are one model each, not two, and 'unknown' in
// this cell does not by itself say a second model ran: it can be a single-model ticket carrying
// unattributable responses, or a genuinely multi-model one whose second model's responses were
// themselves unattributable.
//
// Every implementer session spawns sub-agents, so the model split's total falls short of the
// adjacent Implementer column's figure on nearly every real ticket. A reader who reads only the row
// would otherwise take the two adjacent columns as one figure decomposed by the other, so the gap is
// named in the cell itself whenever it's nonzero, not only in this comment.
//
// The two states below both render today, but for different reasons: '—' means no implementer-role
// tokens on this ticket at all (a real, common case -- e.g. a ticket worked solely by the senior
// engineer); the "(none own-transcript)" case means implementer-role tokens exist but none came
// from the session's own transcript. The second is not reachable on today's corpus, but nothing in
// buildTicketRows excludes it, and collapsing it into the same em dash as "no implementer at all"
// would misreport a ticket that does have implementer activity as having none.
const implementerModels = (row: TicketRow): string => {
  const roleTotal = row.tokensByRole.implementer ?? 0
  if (roleTotal === 0) return '—'
  const byModel = row.tokensByRoleModel.implementer
  if (byModel === undefined || Object.keys(byModel).length === 0) return '(none own-transcript)'
  const splitTotal = Object.values(byModel).reduce((total, value) => total + value, 0)
  const modelList = Object.entries(byModel)
    .sort(([, left], [, right]) => right - left)
    .map(([model]) => shortenModel(model))
    .join(', ')
  return splitTotal === roleTotal
    ? modelList
    : `${modelList} (${formatNumber(splitTotal)} of ${formatNumber(roleTotal)})`
}

const formatStatsTable = (stats: RoleStats[]): string => {
  const headers = ['Role', 'Tickets', 'Mean', 'Median', 'Worst', 'Worst On']
  const values = stats.map((stat) => [
    stat.role,
    formatNumber(stat.tickets),
    formatNumber(Math.round(stat.meanTokens)),
    formatNumber(Math.round(stat.medianTokens)),
    formatNumber(stat.worstTokens),
    stat.worstTicket ?? '—',
  ])
  return renderTable(headers, values, new Set([1, 2, 3, 4]))
}

// One row per non-zero (ticket, role, subagentType) cell, ordered by ticket as report.tickets
// already orders it (by totalTokens descending), then role in table order, then tokens descending
// within role.
const formatSubagentTicketsTable = (tickets: TicketRow[]): string => {
  const headers = ['Ticket', 'Role', 'Sub-agent', 'Tokens']
  const values: string[][] = []

  for (const ticket of tickets) {
    for (const role of REAL_ROLES) {
      const bySubagent = ticket.tokensBySubagent[role]
      if (bySubagent === undefined) {
        continue
      }
      const entries = Object.entries(bySubagent)
        .filter(([, tokens]) => tokens > 0)
        .sort(([, left], [, right]) => right - left)
      for (const [subagentType, tokens] of entries) {
        values.push([ticket.ticket, role, subagentType, formatNumber(tokens)])
      }
    }
  }

  return renderTable(headers, values, new Set([3]))
}

const formatSubagentStatsTable = (stats: SubagentStat[]): string => {
  const headers = ['Role', 'Sub-agent', 'Tickets', 'Mean', 'Total']
  const values = stats.map((stat) => [
    stat.role,
    stat.subagentType,
    formatNumber(stat.tickets),
    formatNumber(Math.round(stat.meanTokens)),
    formatNumber(stat.totalTokens),
  ])

  return renderTable(headers, values, new Set([2, 3, 4]))
}

const formatDaysTable = (days: DayRoleRow[]): string => {
  const headers = ['Date', 'Role', 'Sessions', 'Requests', 'Total Tokens', 'Cache Read %']
  const values = days.map((row) => [
    row.date,
    row.role,
    formatNumber(row.sessions),
    formatNumber(row.requests),
    formatNumber(row.totalTokens),
    `${formatPercent(row.cacheReadTokens, row.totalTokens)}%`,
  ])
  return renderTable(headers, values, new Set([2, 3, 4, 5]))
}

const formatCoverage = (coverage: Coverage): string => {
  const sessionsLine =
    `Ticket coverage: ${formatNumber(coverage.sessionsWithTicket)}/${formatNumber(coverage.sessions)} sessions, ` +
    `${formatNumber(coverage.tokensWithTicket)} of ${formatNumber(coverage.totalTokens)} tokens ` +
    `(${formatPercent(coverage.tokensWithTicket, coverage.totalTokens)}%)`
  const sourcesLine = `  ${TICKET_SOURCES.map(
    (source) => `${source} ${formatNumber(coverage.tokensBySource[source])}`
  ).join(' · ')}`
  const unattributedTokens = coverage.totalTokens - coverage.tokensWithTicket
  const unattributedLine =
    `  Unattributed: ${formatNumber(unattributedTokens)} tokens ` +
    `(${formatPercent(unattributedTokens, coverage.totalTokens)}%) — these are excluded from every ` +
    `mean and median above.`
  // Split what "unattributed" is made of: a workflow-state record that named no ticket (recorded,
  // not ticket-shaped) vs. no record found at all (never recorded).
  const neverRecordedTokens = unattributedTokens - coverage.tokensRecordedNonTicket
  const splitLine =
    `    recorded, not ticket-shaped: ${formatNumber(coverage.tokensRecordedNonTicket)} tokens ` +
    `(${formatPercent(coverage.tokensRecordedNonTicket, coverage.totalTokens)}%) · ` +
    `never recorded: ${formatNumber(neverRecordedTokens)} tokens ` +
    `(${formatPercent(neverRecordedTokens, coverage.totalTokens)}%)`
  return `${sessionsLine}\n${sourcesLine}\n${unattributedLine}\n${splitLine}`
}

const TICKET_SOURCES: TicketSource[] = ['workflow-state', 'spawn-prompt', 'inherited', 'git-branch']

// Division-by-zero is expected here: an unfiltered scan or a fresh install can have zero tokens in
// a bucket, and the coverage footer must still render a number, not `NaN%`.
const formatPercent = (value: number, total: number): string => {
  return (total === 0 ? 0 : (value / total) * 100).toFixed(1)
}
