import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  attributeSession,
  createAttributionIndex,
  indexGitBranch,
  indexSpawnedTeammate,
  populateProjectKeys,
} from './attribution.ts'

test('resolves role from the spawn record agent_type, not from a team config', () => {
  const index = createAttributionIndex()
  index.agentIdBySession.set('impl-session', 'impl-1@team-a')
  index.agentIdBySession.set('senior-session', 'senior-1@team-a')
  indexSpawnedTeammate(
    index,
    { status: 'teammate_spawned', agent_id: 'impl-1@team-a', agent_type: 'workflow:implementer' },
    'lead-session'
  )
  indexSpawnedTeammate(
    index,
    {
      status: 'teammate_spawned',
      agent_id: 'senior-1@team-a',
      agent_type: 'workflow:senior-engineer',
    },
    'lead-session'
  )

  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-attribution-'))
  try {
    assert.equal(attributeSession('impl-session', index, claudeDir).role, 'implementer')
    assert.equal(attributeSession('senior-session', index, claudeDir).role, 'senior-engineer')
    assert.equal(attributeSession('lead-session', index, claudeDir).role, 'team-lead')
    assert.equal(attributeSession('nobody', index, claudeDir).role, 'solo')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('advanced-implementer spawn records resolve to the implementer role, not other', () => {
  // The failure this pins is silent: an unmapped agent_type resolves to 'other', which is a real
  // role with real tokens, so nothing errors and the Implementer column simply reads zero.
  // The agent type is retired (FLOW-330) but the mapping is not — this pins the historical-transcript
  // path, so the fixture deliberately names an agent type no live spawn produces any more.
  const index = createAttributionIndex()
  index.agentIdBySession.set('impl-session', 'impl-1@team-a')
  index.agentIdBySession.set('advanced-session', 'adv-1@team-a')
  index.agentIdBySession.set('future-session', 'future-1@team-a')
  indexSpawnedTeammate(
    index,
    { status: 'teammate_spawned', agent_id: 'impl-1@team-a', agent_type: 'workflow:implementer' },
    'lead-session'
  )
  indexSpawnedTeammate(
    index,
    {
      status: 'teammate_spawned',
      agent_id: 'adv-1@team-a',
      agent_type: 'workflow:advanced-implementer',
    },
    'lead-session'
  )
  indexSpawnedTeammate(
    index,
    {
      status: 'teammate_spawned',
      agent_id: 'future-1@team-a',
      agent_type: 'workflow:some-future-agent',
    },
    'lead-session'
  )

  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-advanced-implementer-'))
  try {
    assert.equal(attributeSession('impl-session', index, claudeDir).role, 'implementer')
    assert.equal(attributeSession('advanced-session', index, claudeDir).role, 'implementer')
    // The fall-through still works for genuinely unknown types — this fix must not turn 'other'
    // into a dead branch.
    assert.equal(attributeSession('future-session', index, claudeDir).role, 'other')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('resolves the ticket through the four-step cascade in priority order', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cascade-'))
  try {
    writeWorkflowState(claudeDir, 'own-state', 'FLOW-100-resumed')
    writeWorkflowState(claudeDir, 'lead-session', 'FLOW-300')

    const index = createAttributionIndex()
    index.agentIdBySession.set('own-state', 'a1@team')
    index.agentIdBySession.set('from-prompt', 'a2@team')
    index.agentIdBySession.set('inheritor', 'a3@team')
    indexSpawnedTeammate(
      index,
      { status: 'teammate_spawned', agent_id: 'a1@team', agent_type: 'workflow:implementer' },
      'lead-session'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'a2@team',
        agent_type: 'workflow:implementer',
        prompt: 'first action: `workflow-state record-entry --phase implementation --key flow-200`',
      },
      'lead-session'
    )
    indexSpawnedTeammate(
      index,
      { status: 'teammate_spawned', agent_id: 'a3@team', agent_type: 'workflow:implementer' },
      'lead-session'
    )
    indexGitBranch(index, 'feat/FLOW-400-something', 'branch-only')
    // Also gives 'own-state' a git-branch ticket that disagrees with its workflow-state ticket, so a
    // cascade-order regression (branch checked before workflow-state) is observable on assertion 1
    // rather than silently passing because 'own-state' had no branch ticket to compete with.
    indexGitBranch(index, 'branch/FLOW-999-wrong-ticket', 'own-state')
    // The project-key guard needs a real ticket's project key on record before tier 4 accepts
    // anything; FLOW-100 and FLOW-300 above already give it 'FLOW'.
    populateProjectKeys(index, claudeDir)

    // 1 — workflow-state wins over everything, and -resumed is stripped.
    assert.deepEqual(attributeSession('own-state', index, claudeDir), {
      role: 'implementer',
      ticket: 'FLOW-100',
      ticketSource: 'workflow-state',
    })
    // 2 — spawn prompt, uppercased.
    const fromPrompt = attributeSession('from-prompt', index, claudeDir)
    assert.equal(fromPrompt.ticket, 'FLOW-200')
    assert.equal(fromPrompt.ticketSource, 'spawn-prompt')
    // 3 — inherited from the spawning lead's own workflow-state.
    const inherited = attributeSession('inheritor', index, claudeDir)
    assert.equal(inherited.ticket, 'FLOW-300')
    assert.equal(inherited.ticketSource, 'inherited')
    // 4 — git branch, last resort.
    const fromBranch = attributeSession('branch-only', index, claudeDir)
    assert.equal(fromBranch.ticket, 'FLOW-400')
    assert.equal(fromBranch.ticketSource, 'git-branch')
    // none — unattributed, not guessed.
    assert.equal(attributeSession('unknown-session', index, claudeDir).ticket, undefined)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('resolves a spawned agent of an unrecognised type as other, not as solo', () => {
  const index = createAttributionIndex()
  index.agentIdBySession.set('researcher-session', 'r1@team-a')
  index.agentIdBySession.set('typeless-session', 'x1@team-a')
  indexSpawnedTeammate(
    index,
    { status: 'teammate_spawned', agent_id: 'r1@team-a', agent_type: 'workflow:researcher' },
    'lead-session'
  )
  // Spawned, but the record carried no agent_type — the agent id is still proof it is not solo.
  indexSpawnedTeammate(index, { status: 'teammate_spawned', agent_id: 'x1@team-a' }, 'lead-session')

  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-other-role-'))
  try {
    const researcher = attributeSession('researcher-session', index, claudeDir)
    assert.equal(researcher.role, 'other')
    assert.equal(attributeSession('typeless-session', index, claudeDir).role, 'other')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('rejects a branch-shaped token whose project key was never seen on a real ticket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-branch-guard-'))
  try {
    writeWorkflowState(claudeDir, 'real-session', 'FLOW-100')
    // A session directory with no readable workflow file — the ordinary case in a real ~/.claude,
    // and the one that puts an empty key in the vocabulary when addProjectKey stops guarding for it.
    mkdirSync(join(claudeDir, 'workflow-state', 'sessions', 'ticketless-session'), {
      recursive: true,
    })

    const index = createAttributionIndex()
    populateProjectKeys(index, claudeDir)
    assert.deepEqual(
      [...index.projectKeys],
      ['FLOW'],
      'the guard vocabulary comes from real tickets'
    )

    // Every one of these is a real branch name that matches BRANCH_TICKET once uppercased.
    indexGitBranch(index, 'renovate/node-20.x', 'renovate-a')
    indexGitBranch(index, 'renovate/pnpm-10.x', 'renovate-b')
    indexGitBranch(index, 'renovate/actions-checkout-5.x', 'renovate-c')
    indexGitBranch(index, 'chore/update-node-22', 'chore-a')
    indexGitBranch(index, 'feat/flow-242-usage-per-ticket', 'real-branch')

    for (const session of ['renovate-a', 'renovate-b', 'renovate-c', 'chore-a']) {
      const attributed = attributeSession(session, index, claudeDir)
      assert.equal(attributed.ticket, undefined, `${session} must not invent a ticket`)
      assert.equal(attributed.ticketSource, undefined)
    }

    // The guard must not cost a real one: lowercase branch, uppercase ticket, known project key.
    const real = attributeSession('real-branch', index, claudeDir)
    assert.equal(real.ticket, 'FLOW-242')
    assert.equal(real.ticketSource, 'git-branch')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('populateProjectKeys takes its vocabulary from spawn prompts as well as workflow-state', () => {
  const index = createAttributionIndex()
  index.ticketByAgentId.set('a1@team-a', 'DEV-500')
  // Empty claudeDir — no workflow-state at all, so the disk source contributes nothing and cannot
  // mask the assertion that the spawn-prompt source alone populated the vocabulary.
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-spawn-prompt-vocab-'))
  try {
    populateProjectKeys(index, claudeDir)
    assert.deepEqual([...index.projectKeys], ['DEV'])

    indexGitBranch(index, 'feat/dev-501-other-thing', 's1')
    const attributed = attributeSession('s1', index, claudeDir)
    assert.equal(attributed.ticket, 'DEV-501')
    assert.equal(attributed.ticketSource, 'git-branch')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('cascade order 1 vs 2: workflow-state wins over a disagreeing spawn-prompt ticket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cascade-1v2-'))
  try {
    writeWorkflowState(claudeDir, 'own-session', 'FLOW-500')

    const index = createAttributionIndex()
    index.agentIdBySession.set('own-session', 'a1@team')
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'a1@team',
        agent_type: 'workflow:implementer',
        prompt: 'first action: `workflow-state record-entry --phase implementation --key flow-600`',
      },
      'lead-session'
    )

    const attributed = attributeSession('own-session', index, claudeDir)
    assert.equal(attributed.ticket, 'FLOW-500')
    assert.equal(attributed.ticketSource, 'workflow-state')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('cascade order 2 vs 4: spawn-prompt wins over a disagreeing (but valid) git-branch ticket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cascade-2v4-'))
  try {
    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'a1@team')
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'a1@team',
        agent_type: 'workflow:implementer',
        prompt: 'first action: `workflow-state record-entry --phase implementation --key flow-700`',
      },
      'lead-session'
    )
    indexGitBranch(index, 'feat/flow-800-other-work', 'teammate-session')
    // FLOW-700 (from the spawn prompt) puts 'FLOW' in the vocabulary, so FLOW-800 would pass tier
    // 4's project-key guard if tier 2 were skipped — this is a real conflict, not a guard rejection.
    populateProjectKeys(index, claudeDir)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.ticket, 'FLOW-700')
    assert.equal(attributed.ticketSource, 'spawn-prompt')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('cascade order 3 vs 4: inherited wins over a disagreeing (but valid) git-branch ticket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-cascade-3v4-'))
  try {
    writeWorkflowState(claudeDir, 'lead-session', 'FLOW-900')

    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'a1@team')
    // No prompt ticket — this teammate falls through tier 2 and must inherit from the lead.
    indexSpawnedTeammate(
      index,
      { status: 'teammate_spawned', agent_id: 'a1@team', agent_type: 'workflow:implementer' },
      'lead-session'
    )
    indexGitBranch(index, 'feat/flow-950-other-work', 'teammate-session')
    // FLOW-900 on disk puts 'FLOW' in the vocabulary, so FLOW-950 would pass tier 4's guard if tier
    // 3 were skipped — this is a real conflict, not a guard rejection.
    populateProjectKeys(index, claudeDir)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.ticket, 'FLOW-900')
    assert.equal(attributed.ticketSource, 'inherited')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('an agentId spawned by two different parent sessions inherits from neither (collision guard)', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-collision-'))
  try {
    writeWorkflowState(claudeDir, 'lead-a', 'FLOW-100')
    writeWorkflowState(claudeDir, 'lead-b', 'FLOW-200')

    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
    // Same agentId, two different parents, with DIFFERING agent_type and DIFFERING --key prompts —
    // proves the collision guard also forgets role and prompt-ticket, not just the parent session.
    // A fixture where both records agreed on agent_type/prompt could pass even if the guard only
    // protected parentSessionByAgentId, since either record's values would look identical either way.
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-a'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:senior-engineer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-200',
      },
      'lead-b'
    )

    assert.equal(index.parentSessionByAgentId.has('reused-agent@old-team'), false)
    assert.equal(index.ambiguousAgentIds.has('reused-agent@old-team'), true)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    // Must not inherit FLOW-100 (lead-a) or FLOW-200 (lead-b) — either would misattribute tokens to
    // a ticket picked by scan order rather than by a real parent relationship. Must not resolve a
    // role from either colliding record's agent_type either, for the same reason.
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.ticketSource, undefined)
    assert.equal(attributed.role, 'other')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('an agentId spawned by two different parents with AGREEING agent_type and prompt ticket keeps both', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-agreement-'))
  try {
    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
    // Same agentId, two different parents — a parent collision — but agent_type and the --key
    // prompt AGREE across both records. The collision discredits the parent; it must not also
    // discredit a value two independently-scanned records both assert.
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-a'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-b'
    )

    assert.equal(index.parentSessionByAgentId.has('reused-agent@old-team'), false)
    assert.equal(index.ambiguousAgentIds.has('reused-agent@old-team'), true)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.role, 'implementer')
    assert.equal(attributed.ticket, 'FLOW-100')
    assert.equal(attributed.ticketSource, 'spawn-prompt')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('an agentId spawned by two different parents where only one supplies agent_type/prompt discards both', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-asymmetry-'))
  try {
    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
    // Same agentId, two different parents; only the first record supplies agent_type/prompt, the
    // second says nothing about either. Presence on one record and silence on the other is not
    // agreement — the attributed session may belong to whichever parent stayed silent — so neither
    // value survives.
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-a'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
      },
      'lead-b'
    )

    assert.equal(index.parentSessionByAgentId.has('reused-agent@old-team'), false)
    assert.equal(index.ambiguousAgentIds.has('reused-agent@old-team'), true)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.ticketSource, undefined)
    assert.equal(attributed.role, 'other')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('an agentId spawned by three parents where the third contradicts discards both, even though the first two agreed', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-three-parents-'))
  try {
    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
    // Three distinct parents. lead-a and lead-b agree on both fields; lead-c contradicts both — and
    // arrives LAST, deliberately, after the agreement between lead-a/lead-b is already established.
    // A comparison that only ever runs at the first collision (the lead-a vs lead-b transition) would
    // never see lead-c's record and would let the agreed value survive; the rule must keep comparing
    // against every parent that has ever named this agentId, however many arrive and in what order.
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-a'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-b'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:senior-engineer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-999',
      },
      'lead-c'
    )

    assert.equal(index.parentSessionByAgentId.has('reused-agent@old-team'), false)
    assert.equal(index.ambiguousAgentIds.has('reused-agent@old-team'), true)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.ticketSource, undefined)
    assert.equal(attributed.role, 'other')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a single parent spawning the same agentId twice keeps a value the second record omits', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-single-parent-omit-'))
  try {
    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
    // One parent, two records for the same agentId — no collision at all. The first record supplies
    // agent_type and the --key prompt; the second omits both (e.g. a retry log line). A single
    // parent's own silence on a later record must not erase what an earlier record from that same
    // parent already established — that's the asymmetric-discard rule for DIFFERENT parents, and it
    // does not apply here.
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-a'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
      },
      'lead-a'
    )

    assert.equal(index.parentSessionByAgentId.get('reused-agent@old-team'), 'lead-a')
    assert.equal(index.ambiguousAgentIds.has('reused-agent@old-team'), false)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.role, 'implementer')
    assert.equal(attributed.ticket, 'FLOW-100')
    assert.equal(attributed.ticketSource, 'spawn-prompt')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a single parent spawning the same agentId twice with a different agent_type discards it', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-single-parent-contradiction-'))
  try {
    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
    // One parent, two records for the same agentId, naming two DIFFERENT agent_type values. Unlike
    // an omission (previous test), a second, different value from the same parent is treated as
    // untrustworthy rather than an update — deliberately diverging from today's last-writer-wins.
    // See indexSpawnedTeammate's comment for the cost of that choice, and why it's currently
    // theoretical rather than live.
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:implementer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
      },
      'lead-a'
    )
    indexSpawnedTeammate(
      index,
      {
        status: 'teammate_spawned',
        agent_id: 'reused-agent@old-team',
        agent_type: 'workflow:senior-engineer',
        prompt: 'workflow-state record-entry --phase implementation --key FLOW-999',
      },
      'lead-a'
    )

    assert.equal(index.parentSessionByAgentId.get('reused-agent@old-team'), 'lead-a')
    assert.equal(index.ambiguousAgentIds.has('reused-agent@old-team'), false)

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.role, 'other')
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.ticketSource, undefined)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('the same three records resolve the same way in any order', () => {
  // Parent A supplies X on one record and nothing on another; parent B supplies X. Both parents
  // that spoke said X, so the field must survive regardless of which order the three records are
  // scanned in — file read order is `files.sort()`, stable but arbitrary with respect to this.
  const recordASupplied = {
    status: 'teammate_spawned',
    agent_id: 'reused-agent@old-team',
    agent_type: 'workflow:implementer',
    prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
  }
  const recordAOmitted = { status: 'teammate_spawned', agent_id: 'reused-agent@old-team' }
  const recordBSupplied = {
    status: 'teammate_spawned',
    agent_id: 'reused-agent@old-team',
    agent_type: 'workflow:implementer',
    prompt: 'workflow-state record-entry --phase implementation --key FLOW-100',
  }

  const orders = [
    [
      { record: recordASupplied, sessionId: 'lead-a' },
      { record: recordAOmitted, sessionId: 'lead-a' },
      { record: recordBSupplied, sessionId: 'lead-b' },
    ],
    [
      { record: recordBSupplied, sessionId: 'lead-b' },
      { record: recordASupplied, sessionId: 'lead-a' },
      { record: recordAOmitted, sessionId: 'lead-a' },
    ],
    [
      { record: recordAOmitted, sessionId: 'lead-a' },
      { record: recordASupplied, sessionId: 'lead-a' },
      { record: recordBSupplied, sessionId: 'lead-b' },
    ],
  ]

  for (const order of orders) {
    const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-agent-order-independence-'))
    try {
      const index = createAttributionIndex()
      index.agentIdBySession.set('teammate-session', 'reused-agent@old-team')
      for (const { record, sessionId } of order) indexSpawnedTeammate(index, record, sessionId)

      const attributed = attributeSession('teammate-session', index, claudeDir)
      assert.equal(attributed.role, 'implementer')
      assert.equal(attributed.ticket, 'FLOW-100')
      assert.equal(attributed.ticketSource, 'spawn-prompt')
    } finally {
      rmSync(claudeDir, { recursive: true, force: true })
    }
  }
})

test('a workflow-state key with no ticket-shaped token is not a ticket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-shapeless-'))
  try {
    writeWorkflowState(claudeDir, 'board-key-session', 'style-citation-convention')

    const index = createAttributionIndex()
    const attributed = attributeSession('board-key-session', index, claudeDir)
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.ticketSource, undefined)
    // Distinguishes "we saw a record and it wasn't a ticket" from "we never saw a record at all".
    assert.equal(attributed.recordedNonTicket, true)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a session with no workflow-state record at all is not recordedNonTicket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-never-recorded-'))
  try {
    const index = createAttributionIndex()
    const attributed = attributeSession('never-seen', index, claudeDir)
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.recordedNonTicket, undefined)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('extracts the ticket from a workflow-state key carrying a suffix beyond -resumed', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-suffixes-'))
  try {
    writeWorkflowState(claudeDir, 'resumed-2', 'FLOW-100-resumed-2')
    writeWorkflowState(claudeDir, 'collide', 'FLOW-100-collide')
    writeWorkflowState(claudeDir, 'redprobe', 'FLOW-100-redprobe')
    writeWorkflowState(claudeDir, 'v-suffix', 'FLOW-100-v')

    const index = createAttributionIndex()
    for (const session of ['resumed-2', 'collide', 'redprobe', 'v-suffix']) {
      const attributed = attributeSession(session, index, claudeDir)
      assert.equal(attributed.ticket, 'FLOW-100', `${session} must fold back to the real ticket`)
      assert.equal(attributed.ticketSource, 'workflow-state')
    }
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('extracts the ticket from a workflow-state key carrying a branch-shaped prefix', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-prefixes-'))
  try {
    writeWorkflowState(claudeDir, 'eng-branch-key', 'fix/eng-398-ecr-lifecycle-policy-etl-airflow')
    writeWorkflowState(claudeDir, 'flow-branch-key', 'claude-workflow/flow-236-consume-readat')

    const index = createAttributionIndex()
    const eng = attributeSession('eng-branch-key', index, claudeDir)
    assert.equal(eng.ticket, 'ENG-398')
    assert.equal(eng.ticketSource, 'workflow-state')
    const flow = attributeSession('flow-branch-key', index, claudeDir)
    assert.equal(flow.ticket, 'FLOW-236')
    assert.equal(flow.ticketSource, 'workflow-state')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('a ticket-shaped token buried mid-string, not at the start or after a /, is not a ticket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-buried-token-'))
  try {
    // Uppercases to V2-CLEANUP-3, which unanchored extraction would read as ticket CLEANUP-3 -- a
    // renovate/chore-style version prefix, not a project key anyone ever put a ticket under.
    writeWorkflowState(claudeDir, 'v2-session', 'v2-cleanup-3')

    const index = createAttributionIndex()
    const attributed = attributeSession('v2-session', index, claudeDir)
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.ticketSource, undefined)
    assert.equal(attributed.recordedNonTicket, true)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('an inherited workflow-state key with no ticket-shaped token also sets recordedNonTicket', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-inherited-shapeless-'))
  try {
    writeWorkflowState(claudeDir, 'lead-session', 'not-a-ticket-board-key')

    const index = createAttributionIndex()
    index.agentIdBySession.set('teammate-session', 'a1@team')
    indexSpawnedTeammate(
      index,
      { status: 'teammate_spawned', agent_id: 'a1@team', agent_type: 'workflow:implementer' },
      'lead-session'
    )

    const attributed = attributeSession('teammate-session', index, claudeDir)
    assert.equal(attributed.ticket, undefined)
    assert.equal(attributed.recordedNonTicket, true)
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

test('escaping session ids ("", ".", "..") stay inside the sessions directory and resolve to distinct segments', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-usage-traversal-'))
  try {
    const sessionsDir = join(claudeDir, 'workflow-state', 'sessions')
    const workflowStateDir = join(claudeDir, 'workflow-state')
    mkdirSync(sessionsDir, { recursive: true })

    // '.' and '' both resolve to the sessions directory itself when unguarded (join(base, '.') and
    // join(base, '') both equal base) -- a file placed loosely there, not under any per-session
    // subdirectory, is what an unguarded '.' or '' would read.
    writeFileSync(
      join(sessionsDir, 'workflow-loose.json'),
      JSON.stringify({
        workflow: { phase: 'implementation', via: 'record-entry', key: 'FLOW-111' },
      })
    )
    // '..' resolves one level above the sessions directory when unguarded.
    writeFileSync(
      join(workflowStateDir, 'workflow-outside.json'),
      JSON.stringify({
        workflow: { phase: 'implementation', via: 'record-entry', key: 'FLOW-999' },
      })
    )

    const index = createAttributionIndex()
    for (const escaping of ['', '.', '..']) {
      assert.equal(
        attributeSession(escaping, index, claudeDir).ticket,
        undefined,
        `session id ${JSON.stringify(escaping)} must not read a file outside its own segment directory`
      )
    }

    // Distinctness: each of the three must map to its own segment directory, not to each other or to
    // a real session's directory -- proven by giving a real session named after each guard's sentinel
    // ('_', '__', '_empty_') its own ticket and confirming the matching escaping input reads that one.
    writeWorkflowState(claudeDir, '_', 'FLOW-201')
    writeWorkflowState(claudeDir, '__', 'FLOW-202')
    writeWorkflowState(claudeDir, '_empty_', 'FLOW-203')
    assert.equal(attributeSession('.', index, claudeDir).ticket, 'FLOW-201')
    assert.equal(attributeSession('..', index, claudeDir).ticket, 'FLOW-202')
    assert.equal(attributeSession('', index, claudeDir).ticket, 'FLOW-203')
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

const writeWorkflowState = (claudeDir: string, sessionId: string, key: string): void => {
  const directory = join(claudeDir, 'workflow-state', 'sessions', sessionId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'workflow-abc123.json'),
    JSON.stringify({ workflow: { phase: 'implementation', via: 'record-entry', key } })
  )
}
