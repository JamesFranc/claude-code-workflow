import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Role } from './attribution.ts'
import { buildPerTicketReport, buildSubagentStats, formatPerTicketReport } from './per-ticket.ts'
import type { UsageResponse } from './main.ts'

test('median is correct for odd and even ticket counts, and 0 for the empty set', () => {
  const odd = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1', role: 'implementer', inputTokens: 10 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's2', role: 'implementer', inputTokens: 20 }),
    usageResponse({ ticket: 'FLOW-3', rawSessionId: 's3', role: 'implementer', inputTokens: 60 }),
  ])
  const oddStats = odd.stats.find((stat) => stat.role === 'implementer')
  assert.equal(oddStats?.medianTokens, 20)

  const even = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1', role: 'implementer', inputTokens: 10 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's2', role: 'implementer', inputTokens: 20 }),
    usageResponse({ ticket: 'FLOW-3', rawSessionId: 's3', role: 'implementer', inputTokens: 60 }),
    usageResponse({ ticket: 'FLOW-4', rawSessionId: 's4', role: 'implementer', inputTokens: 100 }),
  ])
  const evenStats = even.stats.find((stat) => stat.role === 'implementer')
  assert.equal(evenStats?.medianTokens, 40)

  const empty = buildPerTicketReport([])
  const emptyStats = empty.stats.find((stat) => stat.role === 'implementer')
  assert.equal(emptyStats?.medianTokens, 0)
  assert.equal(emptyStats?.tickets, 0)
})

test('mean and median are computed over tickets, not over responses', () => {
  const report = buildPerTicketReport([
    // Two different raw sessions on the same ticket — grouping on ticket+rawSessionId instead of
    // ticket alone would silently split this into two tickets and halve the mean.
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1a', role: 'implementer', inputTokens: 10 }),
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1b', role: 'implementer', inputTokens: 10 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's2', role: 'implementer', inputTokens: 40 }),
  ])
  const stats = report.stats.find((stat) => stat.role === 'implementer')
  assert.equal(report.tickets.length, 2)
  assert.equal(stats?.tickets, 2)
  // Ticket totals are 20 and 40 -> mean 30. Aggregating over the 3 raw responses (10, 10, 40) would
  // give ~20, silently halving the true per-ticket mean.
  assert.equal(stats?.meanTokens, 30)
})

test('two roles on one ticket are both counted, and sessions counts distinct raw sessions', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      sessionId: 'shared',
      model: 'claude-opus-5',
      rawSessionId: 'lead-raw',
      role: 'team-lead',
      inputTokens: 1000,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      sessionId: 'shared',
      model: 'claude-opus-5',
      rawSessionId: 'impl-raw',
      role: 'implementer',
      inputTokens: 100,
    }),
  ])
  const ticket = report.tickets.find((row) => row.ticket === 'FLOW-1')
  assert.equal(ticket?.sessions, 2)
  assert.ok((ticket?.tokensByRole.implementer ?? 0) > 0)
  assert.ok((ticket?.tokensByRole['team-lead'] ?? 0) > 0)
  assert.ok(ticket !== undefined && ticket.teammateTokens < ticket.totalTokens)
})

test('teammate stat excludes the lead', () => {
  const report = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1', role: 'implementer', inputTokens: 100 }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's2',
      role: 'senior-engineer',
      inputTokens: 50,
    }),
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's3', role: 'team-lead', inputTokens: 1000 }),
  ])
  const ticket = report.tickets.find((row) => row.ticket === 'FLOW-1')
  assert.equal(ticket?.teammateTokens, 150)
  assert.equal(ticket?.totalTokens, 1150)
  const teammateStat = report.stats.find((stat) => stat.role === 'teammate')
  assert.equal(teammateStat?.meanTokens, 150)
})

test('solo and other roles each get their own stats row, not just an Other table column', () => {
  const report = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1', role: 'solo', inputTokens: 40 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's2', role: 'solo', inputTokens: 80 }),
    usageResponse({ ticket: 'FLOW-3', rawSessionId: 's3', role: 'other', inputTokens: 10 }),
  ])
  const soloStat = report.stats.find((stat) => stat.role === 'solo')
  const otherStat = report.stats.find((stat) => stat.role === 'other')
  assert.equal(soloStat?.tickets, 2)
  assert.equal(soloStat?.meanTokens, 60)
  assert.equal(soloStat?.medianTokens, 60)
  assert.equal(otherStat?.tickets, 1)
  assert.equal(otherStat?.meanTokens, 10)
})

test('responses with no ticket are excluded from ticket rows but counted in coverage', () => {
  const report = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1', role: 'implementer', inputTokens: 100 }),
    usageResponse({ ticket: undefined, rawSessionId: 's2', role: 'solo', inputTokens: 50 }),
  ])
  assert.equal(report.tickets.length, 1)
  assert.equal(report.coverage.sessions, 2)
  assert.equal(report.coverage.sessionsWithTicket, 1)
  assert.equal(report.coverage.totalTokens, 150)
  assert.equal(report.coverage.tokensWithTicket, 100)
})

test('coverage buckets tokens by ticket source', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      ticketSource: 'workflow-state',
      inputTokens: 10,
    }),
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's2',
      ticketSource: 'spawn-prompt',
      inputTokens: 20,
    }),
    usageResponse({
      ticket: 'FLOW-3',
      rawSessionId: 's3',
      ticketSource: 'inherited',
      inputTokens: 30,
    }),
    usageResponse({
      ticket: 'FLOW-4',
      rawSessionId: 's4',
      ticketSource: 'git-branch',
      inputTokens: 40,
    }),
  ])
  assert.deepEqual(report.coverage.tokensBySource, {
    'workflow-state': 10,
    'spawn-prompt': 20,
    inherited: 30,
    'git-branch': 40,
  })
})

test('every ticket row: tokensByRole sums to totalTokens, across all five Role members', () => {
  // Two tickets, not one -- a single-ticket fixture gives this loop exactly one iteration, the same
  // coverage as a .find() against that one row, and leaves it blind to a cross-ticket aggregation bug
  // in the tokensByRole accumulation path (see the sibling tokensByRoleModel invariant test below).
  const report = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's1', role: 'implementer', inputTokens: 100 }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's2',
      role: 'senior-engineer',
      inputTokens: 50,
    }),
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's3', role: 'team-lead', inputTokens: 25 }),
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's4', role: 'solo', inputTokens: 10 }),
    usageResponse({ ticket: 'FLOW-1', rawSessionId: 's5', role: 'other', inputTokens: 5 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's6', role: 'implementer', inputTokens: 60 }),
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's7',
      role: 'senior-engineer',
      inputTokens: 30,
    }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's8', role: 'team-lead', inputTokens: 15 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's9', role: 'solo', inputTokens: 8 }),
    usageResponse({ ticket: 'FLOW-2', rawSessionId: 's10', role: 'other', inputTokens: 3 }),
  ])
  assert.equal(report.tickets.length, 2, 'fixture carries two distinct ticket rows')
  for (const row of report.tickets) {
    const sum = Object.values(row.tokensByRole).reduce((total, value) => total + (value ?? 0), 0)
    assert.equal(sum, row.totalTokens, `${row.ticket}: tokensByRole must account for every token`)
  }
})

test('a ticket implemented by two different models keeps both, largest share first', () => {
  // Pinned by exact value, not by shape: the point of the field is which model, so a test that
  // only checked "some model is present" would stay green under a scan-order winner.
  const responses = [
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-sonnet-5',
      inputTokens: 100,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's2',
      role: 'implementer',
      model: 'claude-opus-5',
      inputTokens: 500,
    }),
    // A second response on the same (role, model) pair — accumulation is only observable across a
    // repeated key, and a single-instance fixture cannot tell an accumulating write from an
    // overwriting one.
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's4',
      role: 'implementer',
      model: 'claude-opus-5',
      inputTokens: 400,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's3',
      role: 'senior-engineer',
      model: 'claude-opus-5',
      inputTokens: 50,
    }),
  ]
  const report = buildPerTicketReport(responses)
  const row = report.tickets.find((t) => t.ticket === 'FLOW-1')
  assert.deepEqual(row?.tokensByRoleModel.implementer, {
    'claude-opus-5': 900,
    'claude-sonnet-5': 100,
  })
  // The senior's model must not leak into the implementer's bucket.
  assert.deepEqual(row?.tokensByRoleModel['senior-engineer'], { 'claude-opus-5': 50 })

  // deepEqual on an object doesn't check key order, so it can't pin "largest share first" — that
  // claim lives in the rendered column text, which is what implementerModels actually produces.
  const output = formatPerTicketReport(report)
  const line = output.split('\n').find((entry) => entry.includes('FLOW-1'))
  assert.ok(line, 'the FLOW-1 row renders')
  const cells = line!
    .split('│')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  assert.equal(cells[4], 'opus-5, sonnet-5')
})

test('a sub-agent transcript response counts toward tokensByRole but not tokensByRoleModel', () => {
  const responses = [
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-sonnet-5',
      inputTokens: 100,
    }),
    // A sub-agent transcript is stamped with its parent session's own sessionId (see
    // isSubagentTranscript in main.ts), so its tokens must still land in tokensByRole under the
    // role that spawned it -- but its model is not that role's own model, so it must not appear in
    // tokensByRoleModel.
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-opus-5',
      ownTranscript: false,
      inputTokens: 500,
    }),
  ]
  const report = buildPerTicketReport(responses)
  const row = report.tickets.find((t) => t.ticket === 'FLOW-1')
  assert.equal(row?.tokensByRole.implementer, 600)
  assert.deepEqual(row?.tokensByRoleModel.implementer, { 'claude-sonnet-5': 100 })
})

test('tokensBySubagent holds the sub-agent share of tokensByRole, keyed by subagentType', () => {
  const responses = [
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-sonnet-5',
      inputTokens: 100,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-opus-5',
      ownTranscript: false,
      subagentType: 'workflow:preflight-reviewer',
      inputTokens: 500,
    }),
  ]
  const report = buildPerTicketReport(responses)
  const row = report.tickets.find((t) => t.ticket === 'FLOW-1')
  assert.equal(row?.tokensByRole.implementer, 600, 'unchanged rollup')
  assert.deepEqual(row?.tokensBySubagent.implementer, { 'workflow:preflight-reviewer': 500 })
  const byModelSum = Object.values(row?.tokensByRoleModel.implementer ?? {}).reduce(
    (total, value) => total + value,
    0
  )
  const bySubagentSum = Object.values(row?.tokensBySubagent.implementer ?? {}).reduce(
    (total, value) => total + value,
    0
  )
  assert.equal(
    bySubagentSum,
    (row?.tokensByRole.implementer ?? 0) - byModelSum,
    'tokensBySubagent partitions tokensByRole with tokensByRoleModel'
  )
})

test('buildSubagentStats excludes a 0-token sub-agent cell from Tickets and Mean', () => {
  const responses = [
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      ownTranscript: false,
      subagentType: 'workflow:preflight-reviewer',
      inputTokens: 500,
    }),
    // A second ticket where the same sub-agent type recorded no billable tokens at all -- its cell
    // in tokensBySubagent is still 0, not absent.
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's2',
      role: 'implementer',
      ownTranscript: false,
      subagentType: 'workflow:preflight-reviewer',
    }),
  ]
  const report = buildPerTicketReport(responses)
  const stats = buildSubagentStats(report.tickets)
  const stat = stats.find(
    (s) => s.role === 'implementer' && s.subagentType === 'workflow:preflight-reviewer'
  )
  assert.equal(stat?.tickets, 1, 'the 0-token ticket does not count toward Tickets')
  assert.equal(stat?.meanTokens, 500, 'the 0-token ticket does not dilute Mean')
  assert.equal(stat?.totalTokens, 500)
})

test('the Impl Model cell names the gap when the model split falls short of the Implementer column', () => {
  // Same fixture as the sub-agent test above (tokensByRole.implementer 600, split 100) -- a reader
  // who reads only the rendered row, not the JSON or the code comments, must still be able to see
  // that "opus-5" bled into the implementer's own tokens without landing in the split.
  const responses = [
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-sonnet-5',
      inputTokens: 100,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-opus-5',
      ownTranscript: false,
      inputTokens: 500,
    }),
  ]
  const report = buildPerTicketReport(responses)
  const output = formatPerTicketReport(report)
  const line = output.split('\n').find((entry) => entry.includes('FLOW-1'))
  assert.ok(line, 'the FLOW-1 row renders')
  const cells = line!
    .split('│')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  assert.equal(cells[4], 'sonnet-5 (100 of 600)')
})

test('the Impl Model cell distinguishes "no implementer tokens at all" from "implementer tokens, none own-transcript"', () => {
  // Not reachable on today's real corpus (every implementer session has at least one own-transcript
  // response), but nothing in buildTicketRows excludes it, and collapsing it into the same em dash
  // as "no implementer role at all" would misreport a ticket that does have implementer activity.
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-opus-5',
      ownTranscript: false,
      inputTokens: 500,
    }),
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's2',
      role: 'senior-engineer',
      model: 'claude-opus-5',
      inputTokens: 50,
    }),
  ])
  const output = formatPerTicketReport(report)
  const lines = output.split('\n')
  const flow1 = lines.find((entry) => entry.includes('FLOW-1'))
  const flow2 = lines.find((entry) => entry.includes('FLOW-2'))
  assert.ok(flow1 && flow2, 'both rows render')
  const cellsOf = (line: string): string[] =>
    line
      .split('│')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
  assert.equal(
    cellsOf(flow1!)[4],
    '(none own-transcript)',
    'implementer tokens exist, none own-transcript'
  )
  assert.equal(cellsOf(flow2!)[4], '—', 'no implementer-role tokens on this ticket at all')
})

test('every ticket row: tokensByRoleModel sums to the ownTranscript subset of tokensByRole, per role, and never exceeds it', () => {
  // The test immediately above this one shows tokensByRoleModel deliberately excluding a
  // non-ownTranscript response that tokensByRole still counts, so "sums to the same total" is false
  // as a universal statement -- asserting it is an anti-guard: deleting the ownTranscript gate makes
  // the split wrong while leaving this fixture, whose only implementer
  // responses all default ownTranscript:true, green throughout. The invariant that does hold is
  // narrower and is what actually guards the gate: the split's total is exactly the ownTranscript
  // subset of tokensByRole, never more.
  const responses = [
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-sonnet-5',
      inputTokens: 100,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's2',
      role: 'implementer',
      model: 'claude-opus-5',
      inputTokens: 900,
    }),
    // Not part of the split: counts toward tokensByRole.implementer but is excluded from
    // tokensByRoleModel.implementer by construction -- this is the gap the invariant below must
    // still hold across.
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      model: 'claude-opus-5',
      ownTranscript: false,
      inputTokens: 500,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's3',
      role: 'senior-engineer',
      model: 'claude-opus-5',
      inputTokens: 50,
    }),
    // A role the hardcoded ['implementer', 'senior-engineer'] pair below would never check -- the
    // invariant loop must derive which roles to check from the report's own data, not from a fixed
    // list, or a break scoped to any other role passes unseen.
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's7',
      role: 'team-lead',
      model: 'claude-opus-5',
      inputTokens: 40,
    }),
    // A second ticket, with its own ownTranscript gap and a different implementer/model mix, so
    // the loop below iterates more than once -- a bug in buildPerTicketReport's per-ticket
    // aggregation that only shows up across multiple ticket rows would pass undetected against a
    // single-ticket fixture.
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's4',
      role: 'implementer',
      model: 'claude-sonnet-5',
      inputTokens: 300,
    }),
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's5',
      role: 'implementer',
      model: 'claude-opus-5',
      ownTranscript: false,
      inputTokens: 700,
    }),
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's6',
      role: 'senior-engineer',
      model: 'claude-opus-5',
      inputTokens: 20,
    }),
  ]
  const report = buildPerTicketReport(responses)
  assert.equal(report.tickets.length, 2, 'fixture carries two distinct ticket rows')

  for (const row of report.tickets) {
    // Every role present on either side of the split, not a hardcoded pair -- a role that shows up
    // in tokensByRoleModel with nothing in tokensByRole (or vice versa) must still be checked, and a
    // fixed list can only ever name roles someone remembered to add to it.
    const roles = new Set<Role>([
      ...(Object.keys(row.tokensByRole) as Role[]),
      ...(Object.keys(row.tokensByRoleModel) as Role[]),
    ])
    for (const role of roles) {
      const ownTranscriptTotal = responses
        .filter(
          (response) =>
            response.ticket === row.ticket &&
            response.role === role &&
            response.ownTranscript !== false
        )
        .reduce((total, response) => total + response.inputTokens, 0)
      const byModel: Record<string, number> = row.tokensByRoleModel[role] ?? {}
      const modelSum: number = Object.values(byModel).reduce(
        (total: number, value: number) => total + value,
        0
      )
      assert.equal(
        modelSum,
        ownTranscriptTotal,
        `${row.ticket} ${role}: model split must account for exactly its ownTranscript tokens`
      )
      assert.ok(
        modelSum <= (row.tokensByRole[role] ?? 0),
        `${row.ticket} ${role}: model split must never exceed the role's own total`
      )
    }
  }

  const flow1 = report.tickets.find((ticket) => ticket.ticket === 'FLOW-1')
  assert.ok(flow1 !== undefined)
  // implementer's ownTranscript subset (1000) is strictly less than tokensByRole.implementer (1500)
  // -- the gap a "sums to the same total" assertion would have missed entirely.
  assert.equal(flow1.tokensByRole.implementer, 1500)
  assert.equal(
    Object.values(flow1.tokensByRoleModel.implementer ?? {}).reduce(
      (total, value) => total + value,
      0
    ),
    1000
  )
})

test('coverage: tokensBySource sums to tokensWithTicket', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      ticketSource: 'workflow-state',
      inputTokens: 10,
    }),
    usageResponse({
      ticket: 'FLOW-2',
      rawSessionId: 's2',
      ticketSource: 'spawn-prompt',
      inputTokens: 20,
    }),
    usageResponse({ ticket: undefined, rawSessionId: 's3', role: 'solo', inputTokens: 999 }),
  ])
  const sum = Object.values(report.coverage.tokensBySource).reduce(
    (total, value) => total + value,
    0
  )
  assert.equal(sum, report.coverage.tokensWithTicket)
})

test('the coverage footer states the real numbers, not placeholders', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      ticketSource: 'workflow-state',
      inputTokens: 300,
    }),
    usageResponse({ ticket: undefined, rawSessionId: 's2', role: 'solo', inputTokens: 100 }),
  ])
  const output = formatPerTicketReport(report)
  assert.match(output, /Ticket coverage: 1\/2 sessions, 300 of 400 tokens \(75\.0%\)/)
  assert.match(output, /workflow-state 300/)
  assert.match(output, /Unattributed: 100 tokens \(25\.0%\)/)
})

test('the coverage footer splits unattributed tokens: recorded-not-ticket-shaped vs never recorded', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      ticketSource: 'workflow-state',
      inputTokens: 300,
    }),
    // Had a workflow-state record, but it named no ticket-shaped token — a literal board key.
    usageResponse({
      ticket: undefined,
      rawSessionId: 's2',
      role: 'solo',
      recordedNonTicket: true,
      inputTokens: 60,
    }),
    // No workflow-state record at all.
    usageResponse({ ticket: undefined, rawSessionId: 's3', role: 'solo', inputTokens: 40 }),
  ])
  assert.equal(report.coverage.tokensRecordedNonTicket, 60)
  const output = formatPerTicketReport(report)
  assert.match(output, /Unattributed: 100 tokens \(25\.0%\)/)
  assert.match(output, /recorded, not ticket-shaped: 60 tokens \(15\.0%\)/)
  assert.match(output, /never recorded: 40 tokens \(10\.0%\)/)
})

test('the tickets table has an Other column for solo/other roles, not a silent drop', () => {
  const report = buildPerTicketReport([
    usageResponse({ ticket: 'FLOW-9', rawSessionId: 's1', role: 'implementer', inputTokens: 100 }),
    usageResponse({ ticket: 'FLOW-9', rawSessionId: 's2', role: 'solo', inputTokens: 300 }),
    usageResponse({ ticket: 'FLOW-9', rawSessionId: 's3', role: 'other', inputTokens: 150 }),
  ])
  const ticket = report.tickets.find((row) => row.ticket === 'FLOW-9')
  assert.equal(ticket?.totalTokens, 550)
  const output = formatPerTicketReport(report)
  assert.match(output, /\bOther\b/)
  // 450 = solo(300) + other(150). Without a dedicated column those tokens render nowhere, even
  // though they are already counted in the row's Total Tokens (550) — a row that reads
  // Implementer 100 / Senior 0 / Lead 0 next to a Total of 550 with no accounting for the gap.
  assert.match(output, /450/)
})

// The 'tokensByRole sums to totalTokens' test above pins that invariant on the data model; this
// pins the same invariant on what actually renders, parsed back out of the rendered text rather
// than read off the TicketRow — a column pulling from the wrong role field or a render-layer
// double-count would fail here even with a correct TicketRow underneath it.
test('the four rendered role columns sum to the rendered Total Tokens', () => {
  const report = buildPerTicketReport([
    // Tokens chosen so the total clears 1,000 -- formatNumber inserts a thousands separator, which
    // a parse that doesn't strip it first would turn into NaN instead of catching a real mismatch.
    usageResponse({
      ticket: 'FLOW-9',
      rawSessionId: 's1',
      role: 'implementer',
      inputTokens: 1000,
    }),
    usageResponse({
      ticket: 'FLOW-9',
      rawSessionId: 's2',
      role: 'senior-engineer',
      inputTokens: 500,
    }),
    usageResponse({ ticket: 'FLOW-9', rawSessionId: 's3', role: 'team-lead', inputTokens: 250 }),
    usageResponse({ ticket: 'FLOW-9', rawSessionId: 's4', role: 'solo', inputTokens: 100 }),
    usageResponse({ ticket: 'FLOW-9', rawSessionId: 's5', role: 'other', inputTokens: 50 }),
  ])
  const output = formatPerTicketReport(report)
  const row = output.split('\n').find((line) => line.includes('FLOW-9'))
  assert.ok(row, 'the FLOW-9 row renders')
  const cells = row!
    .split('│')
    .map((cell) => cell.trim().replaceAll(',', ''))
    .filter((cell) => cell.length > 0)
  const [, , , implementer, , senior, lead, other, totalTokens] = cells
  const renderedSum = [implementer, senior, lead, other]
    .map((value) => Number(value))
    .reduce((total, value) => total + value, 0)
  assert.equal(renderedSum, Number(totalTokens))
})

// Execution pins for the three per-ticket tables — full literal borders and column widths
// from one response, not the substring/regex matches the tests above use. A column reordered, a
// border miscounted, or a width computed off the wrong row would slip past `assert.match` but not
// past these.
test('the tickets table renders with exact borders and column widths', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      inputTokens: 60,
      cacheReadInputTokens: 40,
    }),
  ])
  const output = formatPerTicketReport(report)
  assert.ok(
    output.includes(
      '┌────────┬──────────┬──────────┬─────────────┬────────────┬────────┬──────┬────────────┬──────────────┬──────────────┐\n' +
        '│ Ticket │ Sessions │ Requests │ Implementer │ Impl Model │ Senior │ Lead │ Solo/Other │ Total Tokens │ Cache Read % │\n' +
        '├────────┼──────────┼──────────┼─────────────┼────────────┼────────┼──────┼────────────┼──────────────┼──────────────┤\n' +
        '│ FLOW-1 │        1 │        1 │         100 │ opus-5     │      0 │    0 │          0 │          100 │        40.0% │\n' +
        '└────────┴──────────┴──────────┴─────────────┴────────────┴────────┴──────┴────────────┴──────────────┴──────────────┘'
    )
  )
})

test('the stats table renders all five roles plus teammate with exact borders', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      inputTokens: 60,
      cacheReadInputTokens: 40,
    }),
  ])
  const output = formatPerTicketReport(report)
  assert.ok(
    output.includes(
      '┌─────────────────┬─────────┬──────┬────────┬───────┬──────────┐\n' +
        '│ Role            │ Tickets │ Mean │ Median │ Worst │ Worst On │\n' +
        '├─────────────────┼─────────┼──────┼────────┼───────┼──────────┤\n' +
        '│ teammate        │       1 │  100 │    100 │   100 │ FLOW-1   │\n' +
        '├─────────────────┼─────────┼──────┼────────┼───────┼──────────┤\n' +
        '│ implementer     │       1 │  100 │    100 │   100 │ FLOW-1   │\n' +
        '├─────────────────┼─────────┼──────┼────────┼───────┼──────────┤\n' +
        '│ senior-engineer │       0 │    0 │      0 │     0 │ —        │\n' +
        '├─────────────────┼─────────┼──────┼────────┼───────┼──────────┤\n' +
        '│ team-lead       │       0 │    0 │      0 │     0 │ —        │\n' +
        '├─────────────────┼─────────┼──────┼────────┼───────┼──────────┤\n' +
        '│ solo            │       0 │    0 │      0 │     0 │ —        │\n' +
        '├─────────────────┼─────────┼──────┼────────┼───────┼──────────┤\n' +
        '│ other           │       0 │    0 │      0 │     0 │ —        │\n' +
        '└─────────────────┴─────────┴──────┴────────┴───────┴──────────┘'
    )
  )
})

test('the by-day-and-role table renders with exact borders and column widths', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      inputTokens: 60,
      cacheReadInputTokens: 40,
    }),
  ])
  const output = formatPerTicketReport(report)
  assert.ok(
    output.includes(
      '┌────────────┬─────────────┬──────────┬──────────┬──────────────┬──────────────┐\n' +
        '│ Date       │ Role        │ Sessions │ Requests │ Total Tokens │ Cache Read % │\n' +
        '├────────────┼─────────────┼──────────┼──────────┼──────────────┼──────────────┤\n' +
        '│ 2026-08-23 │ implementer │        1 │        1 │          100 │        40.0% │\n' +
        '└────────────┴─────────────┴──────────┴──────────┴──────────────┴──────────────┘'
    )
  )
})

test('days groups by date and role, summing tokens and counting distinct sessions', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      rawSessionId: 's1a',
      role: 'implementer',
      inputTokens: 100,
    }),
    // Second raw session, same date+role -- sessions must count 2, not collapse to 1.
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      rawSessionId: 's1b',
      role: 'implementer',
      inputTokens: 50,
    }),
    // A different date keeps its own row rather than folding into the one above.
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-24',
      rawSessionId: 's2',
      role: 'implementer',
      inputTokens: 20,
    }),
    // Same date as day1, different role -- a grouping key that dropped role would fold this into
    // day1's implementer row instead of giving it a row of its own.
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      rawSessionId: 's1c',
      role: 'solo',
      inputTokens: 999,
    }),
  ])
  const day1 = report.days.find((row) => row.date === '2026-08-23' && row.role === 'implementer')
  const day2 = report.days.find((row) => row.date === '2026-08-24' && row.role === 'implementer')
  const day1Solo = report.days.find((row) => row.date === '2026-08-23' && row.role === 'solo')
  assert.equal(day1?.sessions, 2)
  assert.equal(day1?.requests, 2)
  assert.equal(day1?.totalTokens, 150)
  assert.equal(day2?.sessions, 1)
  assert.equal(day2?.totalTokens, 20)
  assert.equal(day1Solo?.sessions, 1)
  assert.equal(day1Solo?.totalTokens, 999)
})

test('days sorts by date, then by role within a date', () => {
  const report = buildPerTicketReport([
    // Inserted out of order on both axes -- a stable insertion-order return would fail this even
    // though buildDayRoleRows groups correctly, since the sort is a separate step.
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-24',
      rawSessionId: 's1',
      role: 'solo',
      inputTokens: 1,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      rawSessionId: 's2',
      role: 'team-lead',
      inputTokens: 1,
    }),
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      rawSessionId: 's3',
      role: 'implementer',
      inputTokens: 1,
    }),
  ])
  assert.deepEqual(
    report.days.map((row) => `${row.date}\0${row.role}`),
    ['2026-08-23\0implementer', '2026-08-23\0team-lead', '2026-08-24\0solo']
  )
})

test('the By day and role table renders the grouped rows', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      date: '2026-08-23',
      rawSessionId: 's1',
      role: 'team-lead',
      inputTokens: 400,
    }),
  ])
  const output = formatPerTicketReport(report)
  assert.match(output, /By day and role/)
  assert.match(output, /2026-08-23 │ team-lead │ {8}1 │ {8}1 │ {10}400/)
})

test('a report with zero tickets renders without throwing or NaN', () => {
  const report = buildPerTicketReport([])
  const output = formatPerTicketReport(report)
  assert.doesNotMatch(output, /NaN/)
  assert.match(output, /Ticket coverage: 0\/0 sessions, 0 of 0 tokens \(0\.0%\)/)
})

test('cache-read percentage is cacheReadTokens over totalTokens, to one decimal', () => {
  const report = buildPerTicketReport([
    usageResponse({
      ticket: 'FLOW-1',
      rawSessionId: 's1',
      role: 'implementer',
      inputTokens: 2,
      cacheReadInputTokens: 1,
    }),
  ])
  const output = formatPerTicketReport(report)
  assert.match(output, /33\.3%/)
})

const usageResponse = ({
  date = '2026-08-23',
  sessionId = 'session-one',
  model = 'claude-opus-5',
  rawSessionId,
  ownTranscript = true,
  subagentType,
  role,
  ticket,
  ticketSource,
  recordedNonTicket,
  project,
  inputTokens = 0,
  outputTokens = 0,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
}: Partial<UsageResponse> & { rawSessionId: string }): UsageResponse => ({
  date,
  sessionId,
  model,
  rawSessionId,
  ownTranscript,
  subagentType,
  role,
  ticket,
  ticketSource,
  recordedNonTicket,
  project,
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
})
