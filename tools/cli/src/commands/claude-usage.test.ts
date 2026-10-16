import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Subprocess against the real binary — same pattern commands/workflow-state.test.ts and
// commands/dashboard.test.ts use — so a flag-definition regression (e.g. reverting --project to
// plain `parse: String`) fails here instead of shipping unnoticed.

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const runCli = (
  args: string[],
  claudeDir: string
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-transform-types',
      mainTsPath,
      'claude-usage',
      '--claude-dir',
      claudeDir,
      ...args,
    ],
    { encoding: 'utf8' }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

// collectClaudeUsage requires <claudeDir>/projects to exist even when empty.
const emptyClaudeDir = (): string => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cmd-test-'))
  mkdirSync(join(claudeDir, 'projects'))
  return claudeDir
}

const buildSubagentFixture = (ticket: string): string => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cmd-subagents-test-'))
  mkdirSync(join(claudeDir, 'projects'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  const subagentDir = join(projectDir, 'impl-1', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: ticket },
    })
  )

  const usageLine = (requestId: string, sessionId: string, model: string, input: number): string =>
    JSON.stringify({
      requestId,
      timestamp: '2026-08-23T12:00:00Z',
      sessionId,
      message: {
        id: `message-${requestId}`,
        model,
        usage: {
          input_tokens: input,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })

  writeFileSync(
    join(projectDir, 'lead.jsonl'),
    `${[
      JSON.stringify({
        type: 'user',
        sessionId: 'lead-1',
        toolUseResult: {
          status: 'teammate_spawned',
          agent_id: 'impl-a@team-z',
          agent_type: 'workflow:implementer',
        },
      }),
      usageLine('lead-request', 'lead-1', 'claude-opus-5', 1),
    ].join('\n')}\n`
  )
  writeFileSync(
    join(projectDir, 'impl.jsonl'),
    `${[
      JSON.stringify({
        type: 'user',
        sessionId: 'impl-1',
        teamName: 'team-z',
        agentName: 'impl-a',
      }),
      usageLine('impl-request', 'impl-1', 'claude-sonnet-5', 100),
    ].join('\n')}\n`
  )
  writeFileSync(
    join(subagentDir, 'agent-a.jsonl'),
    `${usageLine('subagent-a-request', 'impl-1', 'claude-opus-5', 500)}\n`
  )
  writeFileSync(
    join(subagentDir, 'agent-a.meta.json'),
    JSON.stringify({ agentType: 'workflow:preflight-reviewer' })
  )

  return claudeDir
}

test('CLI: claude-usage --project "" is rejected at the CLI boundary', () => {
  const claudeDir = emptyClaudeDir()
  try {
    const { stderr, status } = runCli(['--project', ''], claudeDir)
    assert.notEqual(status, 0, 'exits non-zero')
    assert.ok(
      stderr.includes('--project must not be blank'),
      'the blank-project rejection reaches the CLI boundary'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage --project real succeeds (control)', () => {
  const claudeDir = emptyClaudeDir()
  try {
    const { stderr, status } = runCli(['--project', 'real', '--json'], claudeDir)
    assert.equal(status, 0, `exits 0 for a non-blank project filter, got stderr: ${stderr}`)
    assert.equal(stderr, '', 'no stderr output on a clean run')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage --per-ticket renders the per-ticket report, not the day/session/model table', () => {
  const claudeDir = emptyClaudeDir()
  try {
    const { stdout, status } = runCli(['--per-ticket', '--all'], claudeDir)
    assert.equal(status, 0)
    assert.match(stdout, /Claude Code Usage by Ticket \/ Role/)
    assert.doesNotMatch(stdout, /Claude Code Usage by Day \/ Session \/ Model/)
    // Default shape: no --subagents, so no sub-agent breakdown section.
    assert.doesNotMatch(stdout, /Sub-agent spend/)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage --subagents without --per-ticket is rejected at the CLI boundary', () => {
  const claudeDir = emptyClaudeDir()
  try {
    const { stdout, stderr, status } = runCli(['--subagents'], claudeDir)
    assert.equal(
      status,
      1,
      `exits with the guard exit code, not a Stricli parse-error code, got stderr: ${stderr}`
    )
    assert.equal(stderr, 'claude-usage: --subagents requires --per-ticket\n')
    assert.equal(stdout, '')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage --per-ticket --subagents adds the sub-agent breakdown section', () => {
  const claudeDir = buildSubagentFixture('FLOW-243')

  // Pinned exactly, not matched by fragment: one ticket, one role, one sub-agent type means both
  // tables render exactly this box -- any drift in headers, column order, or padding fails here.
  const expectedSection =
    'Sub-agent spend\n' +
    '┌──────────┬─────────────┬─────────────────────────────┬────────┐\n' +
    '│ Ticket   │ Role        │ Sub-agent                   │ Tokens │\n' +
    '├──────────┼─────────────┼─────────────────────────────┼────────┤\n' +
    '│ FLOW-243 │ implementer │ workflow:preflight-reviewer │    500 │\n' +
    '└──────────┴─────────────┴─────────────────────────────┴────────┘\n' +
    '\n' +
    'Sub-agent summary\n' +
    '┌─────────────┬─────────────────────────────┬─────────┬──────┬───────┐\n' +
    '│ Role        │ Sub-agent                   │ Tickets │ Mean │ Total │\n' +
    '├─────────────┼─────────────────────────────┼─────────┼──────┼───────┤\n' +
    '│ implementer │ workflow:preflight-reviewer │       1 │  500 │   500 │\n' +
    '└─────────────┴─────────────────────────────┴─────────┴──────┴───────┘\n' +
    '\n'

  try {
    const { stdout, stderr, status } = runCli(['--per-ticket', '--subagents', '--all'], claudeDir)
    assert.equal(status, 0, `expected exit 0, got stderr: ${stderr}`)
    const headingIndex = stdout.indexOf('Sub-agent spend\n')
    assert.ok(headingIndex !== -1, `expected a "Sub-agent spend" heading, got stdout:\n${stdout}`)
    const endIndex = stdout.indexOf('By day and role\n', headingIndex)
    assert.ok(
      endIndex !== -1,
      `expected a "By day and role" heading after the sub-agent section, got stdout:\n${stdout}`
    )
    const actualSection = stdout.slice(headingIndex, endIndex)
    assert.equal(
      actualSection,
      expectedSection,
      `expected exact sub-agent section, got stdout:\n${stdout}`
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage --per-ticket --json omits tokensBySubagent and subagentStats without --subagents', () => {
  const claudeDir = buildSubagentFixture('FLOW-245')

  try {
    const { stdout, stderr, status } = runCli(['--per-ticket', '--json', '--all'], claudeDir)
    assert.equal(status, 0, `expected exit 0, got stderr: ${stderr}`)
    const report = JSON.parse(stdout) as {
      perTicket: { tickets: Array<{ ticket: string; tokensBySubagent?: unknown }> }
      subagentStats?: unknown
    }
    const ticket = report.perTicket.tickets.find((row) => row.ticket === 'FLOW-245')
    assert.ok(ticket !== undefined, 'FLOW-245 must resolve from workflow-state')
    assert.equal(
      'subagentStats' in report,
      false,
      'subagentStats must be absent from the JSON report without --subagents'
    )
    assert.equal(
      'tokensBySubagent' in ticket,
      false,
      'tokensBySubagent must be absent from the ticket row without --subagents, even though the ' +
        'fixture has sub-agent tokens to report'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage --per-ticket --json --subagents includes tokensBySubagent and subagentStats', () => {
  const claudeDir = buildSubagentFixture('FLOW-244')

  try {
    const { stdout, stderr, status } = runCli(
      ['--per-ticket', '--json', '--subagents', '--all'],
      claudeDir
    )
    assert.equal(status, 0, `expected exit 0, got stderr: ${stderr}`)
    const report = JSON.parse(stdout) as {
      perTicket: { tickets: Array<{ ticket: string; tokensBySubagent?: unknown }> }
      subagentStats: Array<{
        role: string
        subagentType: string
        tickets: number
        meanTokens: number
        totalTokens: number
      }>
    }
    const ticket = report.perTicket.tickets.find((row) => row.ticket === 'FLOW-244')
    assert.deepEqual(ticket?.tokensBySubagent, {
      implementer: { 'workflow:preflight-reviewer': 500 },
    })
    assert.deepEqual(report.subagentStats, [
      {
        role: 'implementer',
        subagentType: 'workflow:preflight-reviewer',
        tickets: 1,
        meanTokens: 500,
        totalTokens: 500,
      },
    ])
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('CLI: claude-usage without --per-ticket renders the day/session/model table (control)', () => {
  const claudeDir = emptyClaudeDir()
  try {
    const { stdout, status } = runCli(['--all'], claudeDir)
    assert.equal(status, 0)
    assert.match(stdout, /Claude Code Usage by Day \/ Session \/ Model/)
    assert.doesNotMatch(stdout, /Claude Code Usage by Ticket \/ Role/)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})
