import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  collectClaudeUsage,
  formatUsageTable,
  getScanRoots,
  listTranscriptFiles,
  runClaudeUsage,
  type UsageRow,
} from './main.ts'

test('groups usage by UTC day, parent session, and model without double-counting responses', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  const subagentDir = join(projectDir, 'session-one', 'subagents')
  mkdirSync(subagentDir, { recursive: true })

  writeTranscript(join(projectDir, 'session-one.jsonl'), [
    customTitleRecord('session-one', 'Renamed session'),
    spawnedTeammateRecord('session-one', 'agent-one@usage-team'),
    usageRecord({ requestId: 'request-1', model: 'claude-opus-5', input: 10, output: 2 }),
    usageRecord({ requestId: 'request-1', model: 'claude-opus-5', input: 10, output: 2 }),
    usageRecord({
      requestId: 'request-2',
      model: 'claude-sonnet-5',
      input: 3,
      output: 4,
      timestamp: '2026-08-23T23:30:00Z',
    }),
    usageRecord({ requestId: 'synthetic', model: '<synthetic>', input: 0, output: 0 }),
  ])
  writeTranscript(join(subagentDir, 'agent-one.jsonl'), [
    usageRecord({
      requestId: 'request-3',
      model: 'claude-opus-5',
      input: 5,
      output: 6,
      cacheCreation: 7,
      cacheRead: 8,
    }),
    '{not json',
  ])
  writeTranscript(join(projectDir, 'teammate-one.jsonl'), [
    teammateRecord('teammate-one', 'usage-team', 'agent-one'),
    // A model no other response in this fixture uses, so this response is always the sole occupant
    // of its group — the row-shape assertion below must not depend on file scan order deciding
    // which response seeds a shared row.
    usageRecord({
      requestId: 'request-4',
      sessionId: 'teammate-one',
      model: 'claude-haiku-5',
      input: 9,
      output: 10,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
    })

    assert.equal(report.filesScanned, 3)
    assert.equal(report.malformedLines, 1)
    assert.equal(report.usageEntries, 5)
    assert.equal(report.uniqueRequests, 4)
    assert.equal(report.duplicateEntries, 1)
    assert.deepEqual(report.rows, [
      {
        date: '2026-08-23',
        sessionId: 'session-one',
        sessionName: 'Renamed session',
        model: 'claude-haiku-5',
        requests: 1,
        inputTokens: 9,
        outputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 19,
      },
      {
        date: '2026-08-23',
        sessionId: 'session-one',
        sessionName: 'Renamed session',
        model: 'claude-opus-5',
        requests: 2,
        inputTokens: 15,
        outputTokens: 8,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 8,
        totalTokens: 38,
      },
      {
        date: '2026-08-23',
        sessionId: 'session-one',
        sessionName: 'Renamed session',
        model: 'claude-sonnet-5',
        requests: 1,
        inputTokens: 3,
        outputTokens: 4,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 7,
      },
    ])

    const teammateRow = report.rows.find(
      (row) => row.sessionId === 'session-one' && row.model === 'claude-haiku-5'
    )
    assert.ok(teammateRow !== undefined)
    // A grouped row carries exactly these keys. Any attribution field reaching a row is a
    // misattribution: this key collapses a lead and its teammate, so a per-session value here is
    // whichever response was scanned first, presented as the row's own.
    assert.deepEqual(Object.keys(teammateRow).sort(), [
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'date',
      'inputTokens',
      'model',
      'outputTokens',
      'requests',
      'sessionId',
      'sessionName',
      'totalTokens',
    ])
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('filters after grouping timestamps into dates', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-filter-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'sessions.jsonl'), [
    usageRecord({ requestId: 'old', timestamp: '2026-08-22T23:59:59Z' }),
    usageRecord({ requestId: 'kept', timestamp: '2026-08-23T00:00:00Z' }),
    usageRecord({ requestId: 'new', timestamp: '2026-08-24T00:00:00Z' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      since: '2026-08-23',
      until: '2026-08-23',
      utc: true,
    })
    assert.deepEqual(
      report.rows.map((row) => row.date),
      ['2026-08-23']
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('defaults to the Claude project mapped from the invocation directory', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-project-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  const otherDir = join(projectsDir, '-workspace-other')
  mkdirSync(selectedDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  writeTranscript(join(selectedDir, 'selected.jsonl'), [usageRecord({ requestId: 'selected' })])
  writeTranscript(join(otherDir, 'other.jsonl'), [usageRecord({ requestId: 'other' })])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    assert.equal(report.filesScanned, 1)
    assert.equal(report.uniqueRequests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test("--project implies scanning every project, not just the invocation directory's", async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-project-implies-all-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  const otherDir = join(projectsDir, '-workspace-other')
  mkdirSync(selectedDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  writeTranscript(join(selectedDir, 'selected.jsonl'), [
    usageRecord({ requestId: 'selected', cwd: '/workspace/selected.project_name' }),
  ])
  writeTranscript(join(otherDir, 'other.jsonl'), [
    usageRecord({ requestId: 'other', cwd: '/workspace/other' }),
  ])

  try {
    // allProjects: false, invocation directory maps to selectedDir -- but --project names "other",
    // a different project entirely, so the scan must reach otherDir anyway or this always returns 0
    // rows.
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      project: 'other',
      utc: true,
    })
    // Both files scanned (not just selectedDir's) -- proves the scan root widened to every
    // project, not merely that the filter happened to admit something.
    assert.equal(report.filesScanned, 2)
    // And the one row that survives the project filter is otherDir's -- selectedDir's slug does
    // not contain "other", so if the bug were present (scan stays pinned to selectedDir) this
    // would be 0 rows, not 1.
    assert.equal(report.rows.length, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('projectOf attributes a nested subagent transcript to the top-level project, not its subagents directory', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-project-of-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-nested')
  const subagentDir = join(projectDir, 'session-one', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  writeTranscript(join(subagentDir, 'agent-one.jsonl'), [usageRecord({ requestId: 'nested' })])

  try {
    // projectOf takes relative(projectsDir, file).split(sep)[0] -- the first path segment. If it
    // instead returned a deeper segment (e.g. "session-one" or "subagents"), a --project filter
    // for the real top-level project would find nothing.
    const matching = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: false,
      project: 'project-nested',
      utc: true,
    })
    assert.equal(matching.rows.length, 1)

    const wrongSegment = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: false,
      project: 'subagents',
      utc: true,
    })
    assert.equal(wrongSegment.rows.length, 0)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('maps Windows-style paths to Claude project slugs', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-windows-project-test-'))
  const projectDir = join(claudeDir, 'projects', 'C--Users-me-my-app')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'selected.jsonl'), [usageRecord({ requestId: 'selected' })])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: String.raw`C:\Users\me\my.app`,
      allProjects: false,
      utc: true,
    })
    assert.equal(report.filesScanned, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('returns an empty report when the invocation directory has no Claude project', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-empty-project-test-'))
  mkdirSync(join(claudeDir, 'projects'), { recursive: true })

  try {
    let stderrOutput = ''
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/missing',
      allProjects: false,
      utc: true,
      stderr: (chunk) => {
        stderrOutput += chunk
      },
    })
    assert.equal(report.filesScanned, 0)
    assert.equal(report.uniqueRequests, 0)
    assert.deepEqual(report.rows, [])
    assert.match(formatUsageTable(report.rows), /│ Date\s+│ Session\s+│ Model\s+│/)
    // Neither the exact-key directory nor any descendant exists -- the "no project found"
    // message must still fire (getScanRoots' empty-list check), not just the empty result above.
    assert.match(stderrOutput, /no Claude project found for \/workspace\/missing/)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('scanning the invocation directory also reaches a descendant project directory (e.g. a worktree)', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-descendant-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  const descendantDir = join(projectsDir, '-workspace-selected-project-name-worktree')
  mkdirSync(selectedDir, { recursive: true })
  mkdirSync(descendantDir, { recursive: true })
  writeTranscript(join(selectedDir, 'selected.jsonl'), [
    usageRecord({ requestId: 'selected', sessionId: 'selected-session' }),
  ])
  writeTranscript(join(descendantDir, 'descendant.jsonl'), [
    usageRecord({ requestId: 'descendant', sessionId: 'descendant-session' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    assert.equal(report.filesScanned, 2)
    // Not just a count -- the descendant directory's own transcript must actually surface in the
    // result, not merely be opened and discarded.
    assert.ok(
      report.rows.some((row) => row.sessionId === 'descendant-session'),
      "the descendant directory's transcript must appear in the result"
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a descendant project directory is scanned even when the invocation directory itself has no Claude project (worktree-only case)', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-descendant-only-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const descendantDir = join(projectsDir, '-workspace-selected-project-name-worktree')
  mkdirSync(descendantDir, { recursive: true })
  writeTranscript(join(descendantDir, 'descendant.jsonl'), [
    usageRecord({ requestId: 'descendant' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    // The exact-key directory doesn't exist here -- a naive existsSync(exactDir) guard would report
    // an empty result. The descendant alone must still be found and scanned, with no error.
    assert.equal(report.filesScanned, 1)
    assert.equal(report.uniqueRequests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a hyphen-named sibling directory that collides with the descendant prefix is excluded by cwd, not by directory name', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-sibling-collision-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  // Key-only, this directory is indistinguishable from a real descendant of
  // /workspace/selected.project_name -- directoryToProjectKey maps both '/' and '-' to the same
  // character, so '/workspace/selected-project-name-sibling' (an unrelated sibling) and
  // /workspace/selected.project_name/sibling (a real child) produce the identical key. Only each
  // record's own cwd tells them apart.
  const siblingDir = join(projectsDir, '-workspace-selected-project-name-sibling')
  mkdirSync(selectedDir, { recursive: true })
  mkdirSync(siblingDir, { recursive: true })
  writeTranscript(join(selectedDir, 'selected.jsonl'), [
    usageRecord({ requestId: 'selected', cwd: '/workspace/selected.project_name' }),
  ])
  writeTranscript(join(siblingDir, 'sibling.jsonl'), [
    usageRecord({ requestId: 'sibling', cwd: '/workspace/selected-project-name-sibling' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    // Both files are opened -- the directory-key prefix match can't tell them apart -- but only the
    // real descendant's record survives the cwd filter.
    assert.equal(report.filesScanned, 2)
    assert.equal(report.uniqueRequests, 1)
    assert.equal(report.rows.length, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('the prefix match requires the hyphen boundary -- a directory name that merely starts with the key text is not scanned', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-hyphen-boundary-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  // Extends the key as a bare string, with no hyphen (or anything else) joining them -- unlike a
  // real descendant, whose key always gains a leading '-' from the path separator. A prefix match
  // that dropped the hyphen requirement would scan this directory too.
  const noBoundaryDir = join(projectsDir, '-workspace-selected-project-nameextra')
  mkdirSync(selectedDir, { recursive: true })
  mkdirSync(noBoundaryDir, { recursive: true })
  writeTranscript(join(selectedDir, 'selected.jsonl'), [usageRecord({ requestId: 'selected' })])
  writeTranscript(join(noBoundaryDir, 'no-boundary.jsonl'), [
    usageRecord({ requestId: 'no-boundary' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    assert.equal(
      report.filesScanned,
      1,
      'only the exact-key directory is scanned, not the boundary-less lookalike'
    )
    assert.equal(report.uniqueRequests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('the exact-key directory can collide with an unrelated path under the same key, and cwd excludes it', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-exact-key-collision-test-'))
  const projectsDir = join(claudeDir, 'projects')
  // '/workspace/foo-bar' and '/workspace/foo/bar' both map to the key '-workspace-foo-bar' --
  // directoryToProjectKey maps '-' and '/' to the same character, so this collision exists on the
  // exact-key directory too, not only on prefix-matched descendants.
  const exactDir = join(projectsDir, '-workspace-foo-bar')
  mkdirSync(exactDir, { recursive: true })
  writeTranscript(join(exactDir, 'transcript.jsonl'), [
    usageRecord({ requestId: 'real', cwd: '/workspace/foo-bar' }),
    usageRecord({ requestId: 'collision', cwd: '/workspace/foo/bar' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/foo-bar',
      allProjects: false,
      utc: true,
    })
    assert.equal(report.filesScanned, 1, 'the exact-key directory is still scanned')
    assert.equal(
      report.uniqueRequests,
      1,
      'only the record whose cwd actually matches /workspace/foo-bar survives the same-key collision'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('the cwd match requires a trailing separator -- a sibling path that merely starts with projectDirectory is excluded', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cwd-boundary-test-'))
  const projectDir = join(claudeDir, 'projects', '-workspace-foo')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'transcript.jsonl'), [
    usageRecord({ requestId: 'real', cwd: '/workspace/foo' }),
    // '/workspace/foo-extra' is a sibling directory, not a descendant of /workspace/foo -- it only
    // shares a string prefix. A cwd check missing the trailing '/' would admit it.
    usageRecord({ requestId: 'sibling', cwd: '/workspace/foo-extra' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/foo',
      allProjects: false,
      utc: true,
    })
    assert.equal(
      report.uniqueRequests,
      1,
      'the sibling path is excluded even though it starts with projectDirectory as a bare string'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a usage record with no cwd field is kept when its directory was selected', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-no-cwd-test-'))
  const projectDir = join(claudeDir, 'projects', '-workspace-selected-project-name')
  mkdirSync(projectDir, { recursive: true })
  // No cwd field at all -- parseUsageResponse still returns a response; the fallback in
  // withinProjectScope must keep it rather than treat a missing cwd as "not in scope."
  writeTranscript(join(projectDir, 'selected.jsonl'), [usageRecord({ requestId: 'no-cwd' })])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    assert.equal(report.uniqueRequests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('--all scans every project directory and applies no cwd filter', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-all-unfiltered-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const oneDir = join(projectsDir, 'project-one')
  const otherDir = join(projectsDir, 'project-two')
  mkdirSync(oneDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  writeTranscript(join(oneDir, 'one.jsonl'), [
    usageRecord({ requestId: 'one', cwd: '/workspace/one' }),
  ])
  writeTranscript(join(otherDir, 'other.jsonl'), [
    // cwd is unrelated to the projectDirectory passed below -- proving --all skips the cwd-scope
    // filter entirely rather than merely widening which directories feed it.
    usageRecord({ requestId: 'other', cwd: '/somewhere/else/entirely' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
    })
    assert.equal(report.filesScanned, 2)
    assert.equal(report.uniqueRequests, 2)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a stray file directly under the projects directory that matches the key prefix is not treated as a project directory', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-stray-file-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  mkdirSync(selectedDir, { recursive: true })
  writeTranscript(join(selectedDir, 'selected.jsonl'), [usageRecord({ requestId: 'selected' })])
  // A file, not a directory, whose name matches the same key-prefix a real descendant would use --
  // getScanRoots' entry.isDirectory() guard must exclude it. Without that guard this file would be
  // treated as a scan root and handed to listTranscriptFiles, which calls readdirSync on it and
  // throws ENOTDIR since it isn't a directory.
  writeFileSync(join(projectsDir, '-workspace-selected-project-name-stray.jsonl'), '')

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected.project_name',
      allProjects: false,
      utc: true,
    })
    assert.equal(report.filesScanned, 1, 'only the real directory is scanned, not the stray file')
    assert.equal(report.uniqueRequests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test("getScanRoots' isDirectory() guard excludes a stray file matching the key prefix", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-get-scan-roots-test-'))
  const projectsDir = join(claudeDir, 'projects')
  const selectedDir = join(projectsDir, '-workspace-selected-project-name')
  mkdirSync(selectedDir, { recursive: true })
  // Same name a real descendant directory would use, but a file -- asserted directly against
  // getScanRoots' own return value, not through what a downstream readdirSync does with it (the
  // end-to-end test above still covers that path, but the crash it throws on a missing guard is not
  // what makes this a guard: a caller that wraps that downstream call in a try/catch would make the
  // end-to-end test pass with the guard gone, silently).
  writeFileSync(join(projectsDir, '-workspace-selected-project-name-stray.jsonl'), '')

  try {
    const roots = getScanRoots(projectsDir, '/workspace/selected.project_name', false, () => {})
    assert.deepEqual(roots, [selectedDir])
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('keeps a teammate session separate when its parent cannot be identified', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-unmatched-teammate-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'teammate-one.jsonl'), [
    teammateRecord('teammate-one', 'missing-team', 'agent-one'),
    usageRecord({ requestId: 'teammate', sessionId: 'teammate-one' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
    })
    assert.equal(report.rows[0]?.sessionId, 'teammate-one')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('attributes role, ticket, and project end-to-end from transcripts on disk', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-attributed-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-999' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    JSON.stringify({
      type: 'user',
      sessionId: 'lead-1',
      toolUseResult: {
        status: 'teammate_spawned',
        agent_id: 'impl-a@team-z',
        agent_type: 'workflow:implementer',
      },
    }),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({ requestId: 'impl-request', sessionId: 'impl-1' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })

    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-999')
    assert.ok(ticket !== undefined, 'FLOW-999 must resolve from workflow-state and be inherited')

    // Two raw sessions, one parent sessionId: this is the pair that collapses into a single UsageRow.
    assert.equal(ticket.sessions, 2)
    assert.ok(
      (ticket.tokensByRole.implementer ?? 0) > 0,
      'the teammate is attributed as implementer'
    )
    assert.ok(
      (ticket.tokensByRole['team-lead'] ?? 0) > 0,
      'the spawning session is attributed as lead'
    )
    assert.ok(
      ticket.teammateTokens > 0 && ticket.teammateTokens < ticket.totalTokens,
      'teammate tokens must be non-zero and must exclude the lead'
    )

    // Both cascade tiers fired: the lead read its own workflow-state, the teammate inherited it.
    const bySource = report.perTicket?.coverage.tokensBySource
    assert.ok((bySource?.['workflow-state'] ?? 0) > 0)
    assert.ok((bySource?.inherited ?? 0) > 0)

    // "and project" in this test's name was previously unasserted -- project isn't exposed on a
    // row or ticket directly, so exercise it through the filter it drives: a matching --project
    // still finds FLOW-999, a non-matching one finds nothing.
    const matching = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: false,
      project: 'project-alpha',
      utc: true,
      perTicket: true,
    })
    assert.ok(
      matching.perTicket?.tickets.some((row) => row.ticket === 'FLOW-999'),
      'a --project substring matching the real project directory still finds the ticket'
    )
    const nonMatching = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: false,
      project: 'no-such-project',
      utc: true,
      perTicket: true,
    })
    assert.equal(
      nonMatching.perTicket?.tickets.length,
      0,
      'a --project substring matching nothing finds nothing'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a sub-agent transcript nested under the implementer session counts toward tokensByRole but not tokensByRoleModel', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-subagent-model-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  const subagentDir = join(projectDir, 'impl-1', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-998' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    JSON.stringify({
      type: 'user',
      sessionId: 'lead-1',
      toolUseResult: {
        status: 'teammate_spawned',
        agent_id: 'impl-a@team-z',
        agent_type: 'workflow:implementer',
      },
    }),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'impl-request',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 100,
      output: 0,
    }),
  ])
  // A sub-agent spawned by the implementer is stamped with the parent's own sessionId ('impl-1'),
  // not a distinct one of its own -- its tokens must still count toward the implementer role, but
  // its model must not appear in tokensByRoleModel, since it is not the implementer role's own model.
  writeTranscript(join(subagentDir, 'agent-one.jsonl'), [
    usageRecord({
      requestId: 'subagent-request',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 500,
      output: 0,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-998')
    assert.ok(ticket !== undefined, 'FLOW-998 must resolve from workflow-state')
    assert.equal(
      ticket.tokensByRole.implementer,
      600,
      'the sub-agent tokens are still counted under the role that spawned it'
    )
    assert.deepEqual(ticket.tokensByRoleModel.implementer, { 'claude-sonnet-5': 100 })
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a sub-agent response carries subagentType from its sibling meta.json, falling back to unknown, and rolls into tokensBySubagent', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-subagent-type-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  const subagentDir = join(projectDir, 'impl-1', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-999' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    JSON.stringify({
      type: 'user',
      sessionId: 'lead-1',
      toolUseResult: {
        status: 'teammate_spawned',
        agent_id: 'impl-a@team-z',
        agent_type: 'workflow:implementer',
      },
    }),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'impl-request',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 100,
      output: 0,
    }),
  ])
  writeTranscript(join(subagentDir, 'agent-a.jsonl'), [
    usageRecord({
      requestId: 'subagent-a-request',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 500,
      output: 0,
    }),
  ])
  writeFileSync(
    join(subagentDir, 'agent-a.meta.json'),
    JSON.stringify({ agentType: 'workflow:preflight-reviewer' })
  )
  // agent-b has no sibling meta.json -- its response must still keep its tokens and role, falling
  // back to the 'unknown' subagentType sentinel.
  writeTranscript(join(subagentDir, 'agent-b.jsonl'), [
    usageRecord({
      requestId: 'subagent-b-request',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 300,
      output: 0,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-999')
    assert.ok(ticket !== undefined, 'FLOW-999 must resolve from workflow-state')
    assert.deepEqual(ticket.tokensBySubagent.implementer, {
      'workflow:preflight-reviewer': 500,
      unknown: 300,
    })
    // The parent's own response carries no subagentType and still lands only in tokensByRoleModel.
    assert.deepEqual(ticket.tokensByRoleModel.implementer, { 'claude-sonnet-5': 100 })
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a sub-agent transcript nested one directory level deeper than subagents/<file> is still excluded from tokensByRoleModel', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-subagent-depth-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  // One level deeper than the known shape: <project>/<session>/subagents/<extra>/agent-one.jsonl.
  // segments.at(-2) here is 'nested-run', not 'subagents', so a predicate keyed only on the segment
  // immediately before the file would misread this as the session's own top-level transcript.
  const deepSubagentDir = join(projectDir, 'impl-1', 'subagents', 'nested-run')
  mkdirSync(deepSubagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-994' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    spawnedTeammateRecord('lead-1', 'impl-a@team-z'),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'impl-request',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 100,
      output: 0,
    }),
  ])
  writeTranscript(join(deepSubagentDir, 'agent-one.jsonl'), [
    usageRecord({
      requestId: 'subagent-request',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 500,
      output: 0,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-994')
    assert.ok(ticket !== undefined, 'FLOW-994 must resolve from workflow-state')
    assert.equal(
      ticket.tokensByRole.implementer,
      600,
      'the deeper sub-agent tokens are still counted under the role that spawned it'
    )
    assert.deepEqual(ticket.tokensByRoleModel.implementer, { 'claude-sonnet-5': 100 })
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a project directory literally named "subagents" is not mistaken for a nested sub-agent transcript', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-subagent-trap-test-'))
  const projectDir = join(claudeDir, 'projects', 'subagents')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-997' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    JSON.stringify({
      type: 'user',
      sessionId: 'lead-1',
      toolUseResult: {
        status: 'teammate_spawned',
        agent_id: 'impl-a@team-z',
        agent_type: 'workflow:implementer',
      },
    }),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  // This transcript is a top-level session file directly inside the project directory -- not
  // nested under a parent session's `subagents` directory -- even though the encoded project name
  // itself is the literal string "subagents".
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'impl-request',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 50,
      output: 0,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-997')
    assert.ok(ticket !== undefined, 'FLOW-997 must resolve from workflow-state')
    // A path-fragment match on the word "subagents" anywhere in the path would misclassify this as
    // a nested sub-agent transcript and wrongly drop it from tokensByRoleModel.
    assert.deepEqual(ticket.tokensByRoleModel.implementer, { 'claude-opus-5': 50 })
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a sub-agent transcript one directory level shallower than <session>/subagents/<file> is still excluded from tokensByRoleModel', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-subagent-shallow-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-gamma')
  // One level shallower than the known shape: <project>/subagents/<file>, with no parent-session
  // directory in between. segments.slice(1, -1) here is just ['subagents'], the same middle segment
  // a genuine nested transcript produces one level down -- so this shape is caught on the same basis,
  // not on any minimum path length.
  const subagentDir = join(projectDir, 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-993' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    spawnedTeammateRecord('lead-1', 'impl-a@team-z'),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'impl-request',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 100,
      output: 0,
    }),
  ])
  writeTranscript(join(subagentDir, 'agent-one.jsonl'), [
    usageRecord({
      requestId: 'subagent-request',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 500,
      output: 0,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-993')
    assert.ok(ticket !== undefined, 'FLOW-993 must resolve from workflow-state')
    assert.equal(
      ticket.tokensByRole.implementer,
      600,
      'the shallower sub-agent tokens are still counted under the role that spawned it'
    )
    assert.deepEqual(ticket.tokensByRoleModel.implementer, { 'claude-sonnet-5': 100 })
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

// A sub-agent's transcript is stamped with the parent's own sessionId, so the harness can write the
// same physical response behind two files: the session's own top-level transcript (ownTranscript:
// true) and a nested subagents/ copy (ownTranscript: false) -- sharing one requestId, so they merge
// into a single response. `files.sort()` visits the top-level file first ('.' 0x2E sorts before '/'
// 0x2F), so it is `previous` and the nested copy is `current` -- the exact order under which a naive
// "current wins" merge would silently drop this response from tokensByRoleModel.
test('mergeDuplicate keeps a response in tokensByRoleModel when its nested subagents/ duplicate is scanned last', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-merge-own-transcript-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  const subagentDir = join(projectDir, 'impl-1', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-996' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    spawnedTeammateRecord('lead-1', 'impl-a@team-z'),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  // Named 'impl-1.jsonl', not just 'impl.jsonl' -- it must share the 'impl-1' prefix with the nested
  // subagents/ directory below so files.sort() actually reproduces the '.' (0x2E) vs '/' (0x2F)
  // ordering the finding describes; a differently-named top-level file would sort by an earlier,
  // unrelated character and prove nothing about scan order.
  writeTranscript(join(projectDir, 'impl-1.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'dup-own',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 300,
    }),
  ])
  writeTranscript(join(subagentDir, 'agent-one.jsonl'), [
    usageRecord({
      requestId: 'dup-own',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 300,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-996')
    assert.ok(ticket !== undefined, 'FLOW-996 must resolve from workflow-state')
    assert.equal(ticket.requests, 2, 'lead + one deduped implementer response, not two')
    assert.equal(
      ticket.tokensByRole.implementer,
      301,
      'the duplicate pair merges into a single 301-token response'
    )
    assert.deepEqual(
      ticket.tokensByRoleModel.implementer,
      { 'claude-sonnet-5': 301 },
      'ownTranscript must win true even though the nested copy is scanned last'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

// The same duplicate pair as above, but the two copies disagree on model. ownTranscript's true-wins
// rule still makes the merged response own-transcript, so an unguarded model field would let the
// nested subagents/ copy's foreign model win via the `...current` spread -- the same model-bleed
// the merge path was written to prevent. Guarded, disagreement must fall back to
// 'unknown' rather than either candidate.
test('mergeDuplicate does not let a disagreeing model win tokensByRoleModel under ownTranscript true-wins', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-merge-model-disagree-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  const subagentDir = join(projectDir, 'impl-1', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-995' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    spawnedTeammateRecord('lead-1', 'impl-a@team-z'),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl-1.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'dup-disagree',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 300,
    }),
  ])
  writeTranscript(join(subagentDir, 'agent-one.jsonl'), [
    usageRecord({
      requestId: 'dup-disagree',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 300,
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-995')
    assert.ok(ticket !== undefined, 'FLOW-995 must resolve from workflow-state')
    assert.deepEqual(
      ticket.tokensByRoleModel.implementer,
      { unknown: 301 },
      "a disagreeing model must fall back to 'unknown', never the nested copy's foreign model"
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('mergeDuplicate books a sub-agent response under "unknown" when duplicate copies disagree on subagentType', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-merge-subagent-type-disagree-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  const subagentDir = join(projectDir, 'impl-1', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'lead-1'), { recursive: true })
  writeFileSync(
    join(claudeDir, 'workflow-state', 'sessions', 'lead-1', 'workflow-x.json'),
    JSON.stringify({
      workflow: { phase: 'implementation', via: 'dashboard-enter', key: 'FLOW-992' },
    })
  )

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    spawnedTeammateRecord('lead-1', 'impl-a@team-z'),
    usageRecord({ requestId: 'lead-request', sessionId: 'lead-1' }),
  ])
  writeTranscript(join(projectDir, 'impl.jsonl'), [
    teammateRecord('impl-1', 'team-z', 'impl-a'),
    usageRecord({
      requestId: 'impl-request',
      sessionId: 'impl-1',
      model: 'claude-sonnet-5',
      input: 100,
      output: 0,
    }),
  ])
  // Two sub-agent transcripts logging the same physical request (shared requestId) under different
  // sibling meta.json agentType values -- the harness quirk mergeDuplicate's subagentType guard
  // exists for.
  writeTranscript(join(subagentDir, 'agent-x.jsonl'), [
    usageRecord({
      requestId: 'dup-subagent-type',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 400,
      output: 0,
    }),
  ])
  writeFileSync(
    join(subagentDir, 'agent-x.meta.json'),
    JSON.stringify({ agentType: 'workflow:preflight-reviewer' })
  )
  writeTranscript(join(subagentDir, 'agent-y.jsonl'), [
    usageRecord({
      requestId: 'dup-subagent-type',
      sessionId: 'impl-1',
      model: 'claude-opus-5',
      input: 400,
      output: 0,
    }),
  ])
  writeFileSync(
    join(subagentDir, 'agent-y.meta.json'),
    JSON.stringify({ agentType: 'workflow:code-review' })
  )

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-992')
    assert.ok(ticket !== undefined, 'FLOW-992 must resolve from workflow-state')
    assert.deepEqual(
      ticket.tokensBySubagent.implementer,
      { unknown: 400 },
      "a disagreeing subagentType must fall back to 'unknown', never either candidate's own type"
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

// mergeDuplicate must not pick an attribution winner by scan order. Two physical records behind
// the same response key agreeing on session keeps attribution; disagreeing drops it -- and both
// candidate sessions below resolve to their OWN real, distinct ticket. That's deliberate: a fixture
// where only one side has a ticket can't tell "attribution dropped" apart from "attribution handed
// to the ticket-less loser," since both outcomes leave that one ticket un-credited. Giving both
// sides a real ticket means ANY winner-picking rule -- last-scanned, first-scanned, or anything else
// -- credits some real ticket with the disagreeing tokens, which the assertions below catch either
// way; only "neither wins" leaves both tickets exactly at their agreeing-only total.
//
// The disagreeing key below carries THREE records, not two: session A, then session B (disagrees),
// then a second session B record (agrees with the second). This is the shape mergeDuplicate's own
// comment claims -- attribution "stays absent even if a third record for the same key agrees with
// one side" -- and a two-record fixture can't reach it: that sentence is about the fold running
// again on an already-poisoned accumulator, which only a third record exercises. It's also a shape
// the real corpus takes: of 756 cross-session response keys, 394 carry more than two records (147 at
// 4, 229 at 6, 16 at 8, one at 12, one at 16), and all 756 span exactly two distinct sessions -- never
// three. (The other 362 carry exactly two records; the fixture's agreeing pair covers that side.)
//
// The third record agrees with the SECOND (B), not the first (A): with A first and B last, a
// last-scanned-wins mutation and a first-scanned-wins mutation land on different tickets, so each is
// caught by its own assertion below rather than both tripping the same one -- if the third record
// agreed with A instead, both winner-picking directions would land on FLOW-700 and the FLOW-800
// assertion could never fail.
test('mergeDuplicate keeps attribution when duplicate records agree on session, drops it when they disagree', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-merge-duplicate-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  mkdirSync(projectDir, { recursive: true })
  for (const [sessionId, ticket] of [
    ['impl-1', 'FLOW-700'],
    ['other-session', 'FLOW-800'],
  ] as const) {
    mkdirSync(join(claudeDir, 'workflow-state', 'sessions', sessionId), { recursive: true })
    writeFileSync(
      join(claudeDir, 'workflow-state', 'sessions', sessionId, 'workflow-x.json'),
      JSON.stringify({ workflow: { phase: 'implementation', via: 'dashboard-enter', key: ticket } })
    )
  }

  writeTranscript(join(projectDir, 'transcript.jsonl'), [
    // Agrees: recorded twice under the same session id -- attribution must survive the merge.
    usageRecord({ requestId: 'agree-request', sessionId: 'impl-1', input: 5, output: 5 }),
    usageRecord({ requestId: 'agree-request', sessionId: 'impl-1', input: 5, output: 5 }),
    // Disagrees, three records for one key, in fold order: A (FLOW-700) resolves attribution first,
    // B (FLOW-800) disagrees and drops it, then a second B record agrees with the SECOND record --
    // attribution must stay dropped rather than being restored by that later agreement.
    usageRecord({ requestId: 'disagree-request', sessionId: 'impl-1', input: 7, output: 7 }),
    usageRecord({ requestId: 'disagree-request', sessionId: 'other-session', input: 7, output: 7 }),
    usageRecord({ requestId: 'disagree-request', sessionId: 'other-session', input: 7, output: 7 }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })

    const flow700 = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-700')
    assert.ok(flow700 !== undefined, 'FLOW-700 must resolve for the agreeing duplicate')
    // 5+5 input, 5+5 output, deduped to ONE response (10 tokens) -- not doubled, and not carrying
    // any share of the disagreeing triple's 14 tokens (a first-scanned-wins rule would add all 14
    // here, since the triple's first record is session A).
    assert.equal(flow700.totalTokens, 10)
    assert.equal(flow700.sessions, 1)

    // FLOW-800 has no agreeing pair on the winning side of an agreement -- it must not appear at all.
    // A last-scanned-wins rule would surface it here carrying the disagreeing triple's 14 tokens,
    // since the triple's last two records are both session B.
    const flow800 = report.perTicket?.tickets.find((row) => row.ticket === 'FLOW-800')
    assert.equal(flow800, undefined, 'FLOW-800 must not resolve from the disagreeing duplicate')

    const coverage = report.perTicket?.coverage
    assert.ok(coverage !== undefined)
    // The disagreeing triple's 7+7=14 tokens land in "unattributed" -- neither FLOW-700 nor FLOW-800
    // won the attribution, even though either alone would have resolved a real ticket, and even
    // though the third record agrees with the same session the second record carried.
    assert.equal(coverage.totalTokens - coverage.tokensWithTicket, 14)

    // sessionId is guarded the same way rawSessionId is. The agreeing pair keeps its real session
    // id; the disagreeing triple (A, then B, then a second B that agrees with B, not A) collapses to
    // the 'unknown' sentinel rather than surfacing whichever session the scan visited last.
    const agreedRow = report.rows.find((row) => row.sessionId === 'impl-1')
    assert.ok(agreedRow !== undefined, 'agreeing duplicate keeps its real sessionId')
    assert.equal(agreedRow.totalTokens, 10)

    const unknownRow = report.rows.find((row) => row.sessionId === 'unknown')
    assert.ok(unknownRow !== undefined, 'disagreeing duplicate collapses to the unknown sentinel')
    assert.equal(unknownRow.totalTokens, 14)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

// mergeDuplicate's date tiebreak must not let scan order decide which day a response's tokens land
// on. Both records below carry the SAME requestId, so they merge into one response, with timestamps
// on opposite sides of UTC midnight -- the earlier record's date must win regardless of which record
// the scan visits first, which is why the pair runs twice below, once per fold order.
test('mergeDuplicate keeps the earlier date when the earlier record is scanned first', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-merge-date-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  mkdirSync(projectDir, { recursive: true })

  writeTranscript(join(projectDir, 'transcript.jsonl'), [
    usageRecord({
      requestId: 'dup-date',
      sessionId: 'session-one',
      input: 3,
      output: 4,
      timestamp: '2026-08-16T23:59:00Z',
    }),
    usageRecord({
      requestId: 'dup-date',
      sessionId: 'session-one',
      input: 3,
      output: 4,
      timestamp: '2026-08-17T00:01:00Z',
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
    })

    assert.equal(report.rows.length, 1, 'the duplicate pair merges into one response, one row')
    assert.equal(report.rows[0].date, '2026-08-16', 'the earlier date wins')
    assert.equal(report.rows[0].requests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('mergeDuplicate keeps the earlier date when the earlier record is scanned second (reversed fold order)', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-merge-date-reversed-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  mkdirSync(projectDir, { recursive: true })

  writeTranscript(join(projectDir, 'transcript.jsonl'), [
    usageRecord({
      requestId: 'dup-date',
      sessionId: 'session-one',
      input: 3,
      output: 4,
      timestamp: '2026-08-17T00:01:00Z',
    }),
    usageRecord({
      requestId: 'dup-date',
      sessionId: 'session-one',
      input: 3,
      output: 4,
      timestamp: '2026-08-16T23:59:00Z',
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
    })

    assert.equal(report.rows.length, 1, 'the duplicate pair merges into one response, one row')
    assert.equal(
      report.rows[0].date,
      '2026-08-16',
      'the earlier date still wins, fold order reversed'
    )
    assert.equal(report.rows[0].requests, 1)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('admits a branch ticket from a project key seen only in a spawn prompt', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-spawn-branch-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-alpha')
  mkdirSync(projectDir, { recursive: true })
  // No workflow-state anywhere in claudeDir: the disk source contributes nothing, so DEV-501 can
  // only resolve if the spawn-prompt ticket below reaches the tier-4 vocabulary.

  writeTranscript(join(projectDir, 'lead.jsonl'), [
    JSON.stringify({
      type: 'user',
      sessionId: 'lead-1',
      toolUseResult: {
        status: 'teammate_spawned',
        agent_id: 'impl-a@team-z',
        agent_type: 'workflow:implementer',
        prompt: 'first action: `workflow-state record-entry --phase implementation --key DEV-500`',
      },
    }),
  ])
  writeTranscript(join(projectDir, 'sibling.jsonl'), [
    JSON.stringify({
      requestId: 'sibling-request',
      timestamp: '2026-08-23T12:00:00Z',
      sessionId: 'sibling-1',
      gitBranch: 'feat/dev-501-sibling',
      message: {
        id: 'message-sibling-request',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })

    const ticket = report.perTicket?.tickets.find((row) => row.ticket === 'DEV-501')
    assert.ok(
      ticket !== undefined,
      'DEV-501 must resolve from a project key seen only in a spawn prompt, not workflow-state'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('runClaudeUsage renders the per-ticket report instead of the day/session/model table when requested', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-run-per-ticket-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'session.jsonl'), [usageRecord({ requestId: 'request-1' })])

  try {
    let withoutFlag = ''
    await runClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      json: false,
      stdout: (chunk) => {
        withoutFlag += chunk
      },
    })
    assert.match(withoutFlag, /Claude Code Usage by Day \/ Session \/ Model/)
    assert.doesNotMatch(withoutFlag, /Claude Code Usage by Ticket \/ Role/)

    let withFlag = ''
    let withFlagStderr = ''
    await runClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      json: false,
      perTicket: true,
      stdout: (chunk) => {
        withFlag += chunk
      },
      stderr: (chunk) => {
        withFlagStderr += chunk
      },
    })
    assert.match(withFlag, /Claude Code Usage by Ticket \/ Role/)
    assert.doesNotMatch(withFlag, /Claude Code Usage by Day \/ Session \/ Model/)
    // Without a stderr writer this falls back to the real process.stderr -- asserting here, rather
    // than only on stdout, is what proves the per-ticket render path was actually exercised through
    // this in-process entry point instead of leaving its stderr channel unobserved. Scan coverage
    // prints even with nothing to report, so a clean run still shows its 0s rather than going silent.
    assert.match(
      withFlagStderr,
      /ignored 0 duplicate entries and 0 malformed lines/,
      'a clean corpus still reports scan coverage, at 0/0'
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

// This test closes the stdout/stderr half of the three-part grid (stdout, stderr, exit code) at
// this in-process level — until now only stdout was ever asserted here. runClaudeUsage never
// touches process exit code (it doesn't import runtime-exit-code.ts; that channel is closed at the
// subprocess boundary by commands/claude-usage.test.ts instead), so stdout+stderr is the full grid
// available here, and stderr's own branch (main.ts's duplicate/malformed summary) had no coverage
// at all before this test.
test('runClaudeUsage writes a stderr scan-coverage summary always, not window-scoped despite --since/--until', async () => {
  const dirtyDir = mkdtempSync(join(tmpdir(), 'claude-usage-stderr-dirty-test-'))
  const dirtyProjectDir = join(dirtyDir, 'projects', 'project-one')
  mkdirSync(dirtyProjectDir, { recursive: true })
  writeTranscript(join(dirtyProjectDir, 'session.jsonl'), [
    // Duplicated, but outside the --since window used below -- if the summary were counting
    // duplicates only within the window (instead of across the whole scan, as "not window-scoped"
    // in the label above it claims), it would report 0 duplicates instead of 1.
    usageRecord({ requestId: 'request-1', timestamp: '2026-08-20T12:00:00Z' }),
    usageRecord({ requestId: 'request-1', timestamp: '2026-08-20T12:00:00Z' }),
    usageRecord({ requestId: 'request-2', timestamp: '2026-08-23T12:00:00Z' }),
    '{not json',
  ])

  const cleanDir = mkdtempSync(join(tmpdir(), 'claude-usage-stderr-clean-test-'))
  const cleanProjectDir = join(cleanDir, 'projects', 'project-one')
  mkdirSync(cleanProjectDir, { recursive: true })
  writeTranscript(join(cleanProjectDir, 'session.jsonl'), [usageRecord({ requestId: 'request-3' })])

  try {
    let dirtyStdout = ''
    let dirtyStderr = ''
    // perTicket: true -- the summary is written by runClaudeUsage itself, above the branch that
    // picks which table to render, so this also covers the per-ticket render path's stderr, not
    // just the day/session/model path's.
    await runClaudeUsage({
      claudeDir: dirtyDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      json: false,
      perTicket: true,
      since: '2026-08-21',
      stdout: (chunk) => {
        dirtyStdout += chunk
      },
      stderr: (chunk) => {
        dirtyStderr += chunk
      },
    })
    // request-1's duplicate falls entirely outside the --since window, so the window-scoped count
    // would be 0 -- 1 here proves the line is counting the whole scan, not just the window the table
    // below it renders. (malformedLines can't be given the same treatment: an unparseable line
    // carries no date to filter on.)
    assert.match(dirtyStderr, /ignored 1 duplicate entries and 1 malformed lines/)
    // request-1 (out of window) and request-2 (in window) are both unique requestIds, so the
    // whole-scan unique count is 2 -- but the window (--since 2026-08-21) admits only request-2, so a
    // window-scoped count would report 1. Asserting the whole-scan figure by itself is what closes
    // this: the duplicate-count assertion above stays the same either way (request-1's duplicate is
    // entirely out of window, so window-scoping it would report 0 duplicates, not a smaller nonzero
    // number), but uniqueRequests does not -- it moves from 2 to 1, which only this line catches.
    assert.match(dirtyStderr, /2 unique requests/)
    // This line reports totals that aren't window-scoped, not the --since/--until window's — it must
    // say so, not just carry the right numbers.
    assert.match(dirtyStderr, /not window-scoped/)
    assert.match(dirtyStderr, /scanned 1 files/)
    assert.notEqual(dirtyStdout, '', 'the usage table still renders alongside the stderr summary')
    // The table itself IS window-scoped: only request-2's date should appear in it, not the
    // out-of-window duplicate's.
    assert.match(dirtyStdout, /2026-08-23/)
    assert.doesNotMatch(dirtyStdout, /2026-08-20/)

    let cleanStdout = ''
    let cleanStderr = ''
    await runClaudeUsage({
      claudeDir: cleanDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      json: false,
      perTicket: true,
      stdout: (chunk) => {
        cleanStdout += chunk
      },
      stderr: (chunk) => {
        cleanStderr += chunk
      },
    })
    // Scan coverage prints even at 0/0 -- a clean run must not go silent about how much it scanned.
    assert.match(cleanStderr, /ignored 0 duplicate entries and 0 malformed lines/)
    assert.match(cleanStderr, /scanned 1 files/)
    assert.notEqual(cleanStdout, '', 'the usage table still renders')
  } finally {
    rmSync(dirtyDir, { recursive: true, force: true })
    rmSync(cleanDir, { recursive: true, force: true })
  }
})

// The stderr summary's uniqueRequests/duplicateEntries are not window-scoped but ARE scope-filtered: unlike
// filesScanned/malformedLines, they're counted after the project-scope filter runs (see
// collectClaudeUsage), so in default mode (neither --all nor --project passed) they reflect only
// records within projectDirectory, not the whole scan. This pins that split against a fixture with an
// in-scope and out-of-scope record in the same file, and pins recordsOutOfScope/the stderr clause it
// drives -- the figure that makes the drop visible instead of silent.
test('the stderr summary counts only in-scope records for uniqueRequests/duplicateEntries, and reports what the scope filter dropped', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-scope-drop-test-'))
  const projectDir = join(claudeDir, 'projects', '-workspace-selected')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'session.jsonl'), [
    usageRecord({ requestId: 'in-scope', cwd: '/workspace/selected' }),
    usageRecord({ requestId: 'out-of-scope-1', cwd: '/workspace/other' }),
    usageRecord({ requestId: 'out-of-scope-2', cwd: '/workspace/other' }),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected',
      allProjects: false,
      utc: true,
    })
    assert.equal(report.uniqueRequests, 1, 'only the in-scope record counts')
    // Catches a mutation that moves the scope filter below usageEntries += 1: the dropped records
    // would then still be excluded from `responses` (continue still runs) but would inflate
    // usageEntries, so duplicateEntries (usageEntries - responses.size) would read 2 instead of 0
    // even though nothing actually duplicated.
    assert.equal(report.duplicateEntries, 0, 'out-of-scope records are not counted as duplicates')
    assert.equal(
      report.recordsOutOfScope,
      2,
      'both out-of-scope records are counted, not silently dropped'
    )

    let stderr = ''
    await runClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected',
      allProjects: false,
      utc: true,
      json: false,
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk
      },
    })
    assert.match(stderr, /ignored 2 records outside \/workspace\/selected/)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('the out-of-scope clause is omitted when the scope filter drops nothing', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-scope-no-drop-test-'))
  const projectDir = join(claudeDir, 'projects', '-workspace-selected')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'session.jsonl'), [
    usageRecord({ requestId: 'in-scope', cwd: '/workspace/selected' }),
  ])

  try {
    let stderr = ''
    await runClaudeUsage({
      claudeDir,
      projectDirectory: '/workspace/selected',
      allProjects: false,
      utc: true,
      json: false,
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk
      },
    })
    assert.match(stderr, /scanned 1 files/)
    assert.doesNotMatch(stderr, /ignored .* records outside/)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('report carries a perTicket key only when --per-ticket was requested', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-per-ticket-flag-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  mkdirSync(projectDir, { recursive: true })
  writeTranscript(join(projectDir, 'session.jsonl'), [usageRecord({ requestId: 'request-1' })])

  try {
    const withoutFlag = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
    })
    assert.equal('perTicket' in withoutFlag, false)

    const withFlag = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      perTicket: true,
    })
    assert.equal('perTicket' in withFlag, true)
    assert.ok(withFlag.perTicket !== undefined)
    assert.deepEqual(Object.keys(withFlag.perTicket).sort(), [
      'coverage',
      'days',
      'stats',
      'tickets',
    ])
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('project filter keeps only rows from a matching project directory', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-project-filter-test-'))
  for (const name of ['project-alpha', 'project-beta']) {
    const directory = join(claudeDir, 'projects', name)
    mkdirSync(directory, { recursive: true })
    writeTranscript(join(directory, 'session.jsonl'), [
      usageRecord({ requestId: `${name}-request`, sessionId: name }),
    ])
  }

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: '/unused',
      allProjects: true,
      utc: true,
      project: 'ALPHA',
    })

    // The filter runs on responses, before grouping; rows do not carry `project`, so assert on what
    // survived rather than on a field a row has no honest value for. The fixture names each session
    // after its project directory.
    assert.deepEqual(
      report.rows.map((row) => row.sessionId),
      ['project-alpha']
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('listTranscriptFiles walks past a self-referencing symlink instead of looping on it', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-symlink-test-'))
  try {
    const projectDir = join(claudeDir, 'projects', 'project-one')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'session-one.jsonl'), '')

    try {
      symlinkSync(projectDir, join(projectDir, 'self'), 'dir')
    } catch (error) {
      assert.fail(
        `sandbox could not create a symlink to prove listTranscriptFiles' cycle safety: ${error}`
      )
    }

    const files = listTranscriptFiles(claudeDir)
    assert.deepEqual(files, [join(projectDir, 'session-one.jsonl')])
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('formats terminal output for scanning across sessions and models', () => {
  const rows: UsageRow[] = [
    usageRow({
      sessionName: 'Renamed work',
      model: 'claude-opus-5',
      inputTokens: 123456,
      totalTokens: 9876543,
    }),
    usageRow({ sessionName: 'Renamed work', model: 'claude-sonnet-5', outputTokens: 23456 }),
  ]

  const output = formatUsageTable(rows)

  assert.match(output, /Claude Code Usage by Day \/ Session \/ Model/)
  assert.match(output, /│ Date {7}│ Session {6}│ Model {4}│ Requests │/)
  assert.match(output, /│ 2026-08-23 │ Renamed work │ opus-5 {3}│\s+1 │\s+123,456 │/)
  assert.match(output, /│\s+│\s+│ sonnet-5 │\s+1 │/)
  assert.match(output, /9,876,543/)
  assert.doesNotMatch(output, /claude-opus-5/)
  assert.doesNotMatch(output, /session-one/)
})

const usageRecord = ({
  requestId,
  model = 'claude-opus-5',
  input = 1,
  output = 1,
  cacheCreation = 0,
  cacheRead = 0,
  timestamp = '2026-08-23T12:00:00Z',
  sessionId = 'session-one',
  cwd,
}: {
  requestId: string
  model?: string
  input?: number
  output?: number
  cacheCreation?: number
  cacheRead?: number
  timestamp?: string
  sessionId?: string
  cwd?: string
}): string => {
  return JSON.stringify({
    requestId,
    timestamp,
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    message: {
      id: `message-${requestId}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
    },
  })
}

const teammateRecord = (sessionId: string, teamName: string, agentName: string): string => {
  return JSON.stringify({ type: 'user', sessionId, teamName, agentName })
}

const spawnedTeammateRecord = (sessionId: string, agentId: string): string => {
  return JSON.stringify({
    type: 'user',
    sessionId,
    toolUseResult: {
      status: 'teammate_spawned',
      agent_id: agentId,
      agent_type: 'workflow:implementer',
    },
  })
}

const customTitleRecord = (sessionId: string, customTitle: string): string => {
  return JSON.stringify({ type: 'custom-title', sessionId, customTitle })
}

const usageRow = (overrides: Partial<UsageRow>): UsageRow => ({
  date: '2026-08-23',
  sessionId: 'session-one',
  model: 'claude-opus-5',
  requests: 1,
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
  totalTokens: 10,
  ...overrides,
})

const writeTranscript = (path: string, records: string[]): void => {
  writeFileSync(path, `${records.join('\n')}\n`)
}
