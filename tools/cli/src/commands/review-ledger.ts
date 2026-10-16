import { buildCommand, buildRouteMap } from '@stricli/core'
import { parseNonBlankString, parseShaLike } from '../parse.ts'
import type {
  FindingOrigin,
  NoteTarget,
  ReviewStance,
  ReviewVerdict,
  SeniorCondition,
} from '../review-ledger/ledger.ts'
import {
  runShowRound,
  runNextRound,
  runStance,
  runShow,
  runOpenFindingScoped,
  runSetFindingStatus,
  runAssignFinding,
  runRecordInstruction,
  runDisposeInstruction,
  runDisposeInstructionBatch,
  runRecordSeniorSpawned,
  runRecordSeniorShutdown,
  runRecordReviewStart,
  runRecordReviewComplete,
  runCloseRound,
  runRoundAdvance,
  runAddNote,
  runDoneNote,
  runGuarded,
} from '../review-ledger/run.ts'

const ticketFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--ticket'),
  brief: 'Ticket id this ledger belongs to',
  optional: false as const,
}

const repoFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--repo-root'),
  brief:
    'Repo to evaluate the predicate in — defaults to the repo containing the current directory',
  optional: true as const,
}

const fixCommitRepoFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--repo-root'),
  brief:
    'Repo to verify --fix-commit resolves in — defaults to the repo containing the current directory',
  optional: true as const,
}

const seniorConditionFlag = {
  kind: 'parsed' as const,
  parse: (s: string): SeniorCondition => {
    if (s !== 'unreachable' && s !== 'already-gone')
      throw new Error(
        `--senior-condition must be unreachable or already-gone, got: ${s}. A senior that was spawned but never recorded is not licensed here — record it with \`review-ledger senior shutdown --ticket <TICKET-ID> --round N --agent-id X\`, which accepts a shutdown with no spawn on record.`
      )
    return s
  },
  brief:
    "Licence to close over a senior with no recorded shutdown (exit 17), or one gone before recording `review complete` (exit 27) — requires --senior-reason. For exit 17 it is recorded as a shutdown for every senior on the round still outstanding; for exit 27, on the round's close. For a senior that was spawned but never recorded, use `senior shutdown` instead: it takes a real agent id and needs no licence.",
  optional: true as const,
}

const seniorReasonFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--senior-reason'),
  brief:
    'Why the round closes over its unaccounted senior(s) — recorded on the ledger with the licence',
  optional: true as const,
}

// Free text and no enum half. There is exactly one legitimate sha reuse — a re-review of a sha that
// did not move because the previous round's findings were all ruled invalid — and a one-member union
// would name a state nothing else can be, which is the category error 'no-senior-spawned' was
// removed for. The durable half of this licence is the shaReuseLicensed marker on the event, not a
// condition the caller picks.
const shaReuseReasonFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--sha-reuse-reason'),
  brief:
    'Why closing at a sha an earlier round already recorded is correct — recorded on the ledger with the licence',
  optional: true as const,
}

const scopeChangeFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--scope-change'),
  brief:
    'What changed to justify an adversarial stance against a computed cleanup — required for that override, recorded on the ledger',
  optional: true as const,
}

const roundCommand = buildCommand({
  docs: {
    brief: 'Print the ticket and current round — exits 8 if the ticket has no ledger on disk',
  },
  parameters: {
    flags: { ticket: ticketFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string }) {
    runGuarded(() => {
      runShowRound(flags.ticket)
    })
  },
})

const nextRoundCommand = buildCommand({
  docs: {
    brief:
      "Close the round that just finished and advance to the next one — every close advances, whether the round that follows is another review round or the ticket's terminal one; `round-close` is a deprecated alias for this same command. Exits 6 if the declared stance contradicts the computed one — an adversarial declaration against computed cleanup requires --scope-change naming what changed, while other contradictions and stance-predicate failures stay licensed by --reason — 9 if another caller already holds the round's advance claim, 17 if any of the round's seniors has no recorded shutdown and no --senior-condition with --senior-reason licenses it, 19 if the round is already closed, 20 if the round carries no trace of a review, 21 if it would stamp the round with a sha an earlier round already recorded and no --sha-reuse-reason licenses it, 27 if the ledger's seniors record their reviews and this round's is not recorded complete, unless --senior-condition with --senior-reason licenses it",
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      'reviewed-sha': {
        kind: 'parsed',
        parse: parseShaLike('--reviewed-sha'),
        brief: 'Commit sha reviewed to close the current round, before it advances',
        optional: false,
      },
      stance: {
        kind: 'parsed',
        parse: (s: string): ReviewStance => {
          if (s !== 'adversarial' && s !== 'cleanup')
            throw new Error(`--stance must be adversarial or cleanup, got: ${s}`)
          return s
        },
        brief:
          'Whether this round reviewed the whole surface (adversarial) or was a fix-up pass (cleanup)',
        optional: false,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief:
          'Why the declared stance stands against a refusal — a contradicting computed stance, or a stance failure computeStance itself hit — required to override, recorded on the ledger',
        optional: true,
      },
      'repo-root': repoFlag,
      'senior-condition': seniorConditionFlag,
      'senior-reason': seniorReasonFlag,
      'sha-reuse-reason': shaReuseReasonFlag,
      'scope-change': scopeChangeFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    'reviewed-sha': string
    stance: ReviewStance
    reason?: string
    'repo-root'?: string
    'senior-condition'?: SeniorCondition
    'senior-reason'?: string
    'sha-reuse-reason'?: string
    'scope-change'?: string
  }) {
    runGuarded(() => {
      runNextRound(
        flags.ticket,
        flags['reviewed-sha'],
        flags.stance,
        flags.reason,
        flags['repo-root'],
        flags['senior-condition'],
        flags['senior-reason'],
        flags['sha-reuse-reason'],
        flags['scope-change']
      )
    })
  },
})

const roundCloseCommand = buildCommand({
  docs: {
    brief:
      "Deprecated alias for `next-round` — kept only so existing callers keep working. Closes the round that just finished AND advances, identically to `next-round`; it no longer closes without advancing. New callers should use `next-round`. Same exit codes: 6 if the declared stance contradicts the computed one — an adversarial declaration against computed cleanup requires --scope-change naming what changed, while other contradictions and stance-predicate failures stay licensed by --reason — 9 if another caller already holds the round's advance claim, 17 if any of the round's seniors has no recorded shutdown and no --senior-condition with --senior-reason licenses it, 19 if the round is already closed, 20 if the round carries no trace of a review, 21 if it would stamp the round with a sha an earlier round already recorded and no --sha-reuse-reason licenses it, 27 if the ledger's seniors record their reviews and this round's is not recorded complete, unless --senior-condition with --senior-reason licenses it",
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      'reviewed-sha': {
        kind: 'parsed',
        parse: parseShaLike('--reviewed-sha'),
        brief: 'Commit sha reviewed to close the current round',
        optional: false,
      },
      stance: {
        kind: 'parsed',
        parse: (s: string): ReviewStance => {
          if (s !== 'adversarial' && s !== 'cleanup')
            throw new Error(`--stance must be adversarial or cleanup, got: ${s}`)
          return s
        },
        brief:
          'Whether this round reviewed the whole surface (adversarial) or was a fix-up pass (cleanup)',
        optional: false,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief:
          'Why the declared stance stands against a refusal — a contradicting computed stance, or a stance failure computeStance itself hit — required to override, recorded on the ledger',
        optional: true,
      },
      'repo-root': repoFlag,
      'senior-condition': seniorConditionFlag,
      'senior-reason': seniorReasonFlag,
      'sha-reuse-reason': shaReuseReasonFlag,
      'scope-change': scopeChangeFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    'reviewed-sha': string
    stance: ReviewStance
    reason?: string
    'repo-root'?: string
    'senior-condition'?: SeniorCondition
    'senior-reason'?: string
    'sha-reuse-reason'?: string
    'scope-change'?: string
  }) {
    runGuarded(() => {
      runCloseRound(
        flags.ticket,
        flags['reviewed-sha'],
        flags.stance,
        flags.reason,
        flags['repo-root'],
        flags['senior-condition'],
        flags['senior-reason'],
        flags['sha-reuse-reason'],
        flags['scope-change']
      )
    })
  },
})

const roundAdvanceCommand = buildCommand({
  docs: {
    brief:
      'Advance the counter past a round closed without advancing, on a ledger written before every close advanced — appends the one missing round event and repairs nothing else. It takes no --round: on a wedged ledger the wedged round IS the current round. Exits 25 if the current round is not closed, which is also what makes re-running it safe.',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief:
          'Why the counter is moving without a close — required, and recorded on the ledger so the advance does not read back as an ordinary one',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; reason: string }) {
    runGuarded(() => {
      runRoundAdvance(flags.ticket, flags.reason)
    })
  },
})

const stanceCommand = buildCommand({
  docs: {
    brief:
      "Compute the review stance for a pinned sha — exits 8 if the ticket has no ledger on disk, 10 if undetermined, 11 on a null anchor, 12 on a failed git precondition, 13 if the previous round's reviewed sha is null at report round 2 or later, 14 if a sha the ledger itself recorded no longer resolves, is ambiguous, or is no longer an ancestor of the pinned sha",
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      sha: {
        kind: 'parsed',
        parse: parseShaLike('--sha'),
        brief: 'The pinned sha to compute the stance for',
        optional: false,
      },
      'repo-root': repoFlag,
      anchor: {
        kind: 'parsed',
        parse: parseShaLike('--anchor'),
        brief:
          "Override the ledger's resolved anchor sha — either replaying a historical round (sha " +
          "is a recorded round's own reviewedSha) or a synthetic anchor at the live tip (sha " +
          'matches no recorded round)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; sha: string; 'repo-root'?: string; anchor?: string }) {
    runGuarded(() => {
      runStance(flags.ticket, flags.sha, flags['repo-root'], flags.anchor)
    })
  },
})

const showCommand = buildCommand({
  docs: {
    brief: 'Print the full folded ledger as JSON — exits 8 if the ticket has no ledger on disk',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      status: {
        kind: 'parsed',
        parse: (s: string): 'open' | 'fixed' | 'withdrawn' => {
          if (s !== 'open' && s !== 'fixed' && s !== 'withdrawn')
            throw new Error(`--status must be open, fixed, or withdrawn, got: ${s}`)
          return s
        },
        brief: 'Filter findings to this status',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; status?: 'open' | 'fixed' | 'withdrawn' }) {
    runGuarded(() => {
      runShow(flags.ticket, flags.status)
    })
  },
})

const findingOpenCommand = buildCommand({
  docs: {
    brief:
      'Open (or idempotently re-open) a finding — refuses with exit 4 if the id is already withdrawn, exits 7 if it re-opens an id already fixed, exits 16 if --file is a check file without --check, or is neither a check file nor a path in the diff against origin/main',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      file: {
        kind: 'parsed',
        parse: parseNonBlankString('--file'),
        brief: 'File the finding is in',
        optional: false,
      },
      symbol: {
        kind: 'parsed',
        parse: parseNonBlankString('--symbol'),
        brief: 'Durable symbol the finding cites',
        optional: false,
      },
      hint: {
        kind: 'parsed',
        parse: parseNonBlankString('--hint'),
        brief: 'Line number or other locator beside the symbol',
        optional: true,
      },
      summary: {
        kind: 'parsed',
        parse: parseNonBlankString('--summary'),
        brief: 'What is wrong, one or two sentences',
        optional: false,
      },
      origin: {
        kind: 'parsed',
        parse: (s: string): FindingOrigin => {
          if (
            s !== 'senior' &&
            s !== 'coderabbit' &&
            s !== 'human' &&
            s !== 'user' &&
            s !== 'team-lead'
          )
            throw new Error(
              `--origin must be senior, coderabbit, human, user, or team-lead, got: ${s}`
            )
          return s
        },
        brief: 'Who raised this finding — defaults to senior when omitted',
        optional: true,
      },
      check: {
        kind: 'parsed',
        parse: parseNonBlankString('--check'),
        brief:
          'Check files only (*-proofs.md, *-3-impl.md, proof-ledger:<id>, gate-ledger:<gate>): the ' +
          'proof-ledger capture id or declared gate whose capture does not support the claim — ' +
          'required there, refused elsewhere',
        optional: true,
      },
      prose: {
        kind: 'boolean',
        brief:
          'Mark this finding as prose accuracy-polish (not a false claim about program behavior) — ' +
          'when --file is a documentation path, routes to note add instead of finding open',
        optional: true,
      },
      'repo-root': repoFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    file: string
    symbol: string
    hint?: string
    summary: string
    origin?: FindingOrigin
    check?: string
    prose?: boolean
    'repo-root'?: string
  }) {
    runGuarded(() => {
      runOpenFindingScoped(
        flags.ticket,
        flags.file,
        flags.symbol,
        flags.summary,
        flags.hint,
        flags.origin,
        flags.check,
        flags['repo-root'],
        flags.prose
      )
    })
  },
})

const findingStatusCommand = buildCommand({
  docs: {
    brief:
      'Set a finding to fixed or withdrawn — exits 5 if the id is not in the ledger, exits 6 if --status withdrawn is missing --reason, exits 15 if --fix-commit does not resolve to a commit in the repo',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      // --id is 12 hex characters (findingId/instructionId in ledger.ts both slice a sha256 hex
      // digest to 12), which makes it look sha-shaped — but it is a content-derived id this tool
      // computes from the finding/instruction's own fields, never a value `git rev-parse` produces,
      // so parseShaLike's commit-sha contract does not apply. Every --id flag in this file (here,
      // in finding assign, and in instruction dispose) stays on parseNonBlankString for the same
      // reason.
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Finding id',
        optional: false,
      },
      status: {
        kind: 'parsed',
        parse: (s: string): 'fixed' | 'withdrawn' => {
          if (s !== 'fixed' && s !== 'withdrawn')
            throw new Error(`--status must be fixed or withdrawn, got: ${s}`)
          return s
        },
        brief: 'New status for the finding',
        optional: false,
      },
      'fix-commit': {
        kind: 'parsed',
        parse: parseShaLike('--fix-commit'),
        brief: 'Commit sha that fixed the finding',
        optional: true,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief: 'Why the finding was withdrawn',
        optional: true,
      },
      'repo-root': fixCommitRepoFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    id: string
    status: 'fixed' | 'withdrawn'
    'fix-commit'?: string
    reason?: string
    'repo-root'?: string
  }) {
    runGuarded(() => {
      runSetFindingStatus(
        flags.ticket,
        flags.id,
        flags.status,
        flags.reason,
        flags['fix-commit'],
        flags['repo-root']
      )
    })
  },
})

const findingAssignCommand = buildCommand({
  docs: { brief: 'Assign a finding an owner — exits 5 if the id is not in the ledger' },
  parameters: {
    flags: {
      ticket: ticketFlag,
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Finding id',
        optional: false,
      },
      owner: {
        kind: 'parsed',
        parse: parseNonBlankString('--owner'),
        brief: 'Who is fixing this finding',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; id: string; owner: string }) {
    runGuarded(() => {
      runAssignFinding(flags.ticket, flags.id, flags.owner)
    })
  },
})

const findingRoutes = buildRouteMap({
  routes: {
    open: findingOpenCommand,
    status: findingStatusCommand,
    assign: findingAssignCommand,
  },
  docs: { brief: 'Manage review findings on the ledger' },
})

const instructionRecordCommand = buildCommand({
  docs: {
    brief:
      'Record a dispatched instruction on the ledger — exits 7 if it re-arms an instruction already disposed',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      text: {
        kind: 'parsed',
        parse: parseNonBlankString('--text'),
        brief: 'The instruction, one line',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; text: string }) {
    runGuarded(() => {
      runRecordInstruction(flags.ticket, flags.text)
    })
  },
})

const instructionDisposeCommand = buildCommand({
  docs: {
    brief:
      'Record an instruction disposition — exits 5 if the id is not in the ledger, exits 6 if --disposition not-acted or not-applicable is missing --reason',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Instruction id',
        optional: false,
      },
      disposition: {
        kind: 'parsed',
        parse: (s: string): 'acted' | 'not-acted' | 'not-applicable' => {
          if (s !== 'acted' && s !== 'not-acted' && s !== 'not-applicable')
            throw new Error(`--disposition must be acted, not-acted, or not-applicable, got: ${s}`)
          return s
        },
        brief: 'Disposition for this instruction',
        optional: false,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief: 'Why (required for anything other than acted)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    id: string
    disposition: 'acted' | 'not-acted' | 'not-applicable'
    reason?: string
  }) {
    runGuarded(() => {
      runDisposeInstruction(flags.ticket, flags.id, flags.disposition, flags.reason)
    })
  },
})

const instructionDisposeBatchCommand = buildCommand({
  docs: {
    brief:
      'Record one disposition for several instructions in a single call — exits 5 if any id is not in the ledger (nothing is disposed), exits 6 if --disposition not-acted or not-applicable is missing --reason',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Instruction id — repeat the flag for each instruction in the batch',
        optional: false,
        variadic: true,
      },
      disposition: {
        kind: 'parsed',
        parse: (s: string): 'acted' | 'not-acted' | 'not-applicable' => {
          if (s !== 'acted' && s !== 'not-acted' && s !== 'not-applicable')
            throw new Error(`--disposition must be acted, not-acted, or not-applicable, got: ${s}`)
          return s
        },
        brief: 'Disposition applied to every instruction in the batch',
        optional: false,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief: 'Why (required for anything other than acted)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    id: string[]
    disposition: 'acted' | 'not-acted' | 'not-applicable'
    reason?: string
  }) {
    runGuarded(() => {
      runDisposeInstructionBatch(flags.ticket, flags.id, flags.disposition, flags.reason)
    })
  },
})

const roundFlag = {
  kind: 'parsed' as const,
  parse: (s: string): number => {
    const n = Number(s)
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`--round must be a positive integer, got: ${s}`)
    return n
  },
  brief: 'The review round this senior was spawned for',
  optional: false as const,
}

const agentIdFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--agent-id'),
  brief: 'The spawned senior agent id',
  optional: false as const,
}

const parseNoteTarget = (s: string): NoteTarget => {
  if (s !== 'pr-body' && s !== 'jira-description' && s !== 'commit-message')
    throw new Error(`--target must be pr-body, jira-description, or commit-message, got: ${s}`)
  return s
}

const noteAddCommand = buildCommand({
  docs: {
    brief:
      'Record a record defect — PR body, Jira description, commit message — for the team lead to fix; never a finding, never gating; exits 7 if it re-arms a note already done',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      target: {
        kind: 'parsed',
        parse: parseNoteTarget,
        brief: 'Which record: pr-body, jira-description, or commit-message',
        optional: false,
      },
      text: {
        kind: 'parsed',
        parse: parseNonBlankString('--text'),
        brief: 'What to fix, one line',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; target: NoteTarget; text: string }) {
    runGuarded(() => {
      runAddNote(flags.ticket, flags.target, flags.text)
    })
  },
})

const noteDoneCommand = buildCommand({
  docs: { brief: 'Mark a record note done — exits 5 if the id is not in the ledger' },
  parameters: {
    flags: {
      ticket: ticketFlag,
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Note id, as printed by note add',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; id: string }) {
    runGuarded(() => {
      runDoneNote(flags.ticket, flags.id)
    })
  },
})

const seniorSpawnedCommand = buildCommand({
  docs: {
    brief:
      "Record the senior spawned for a review round, at spawn time — exits 22 if --round does not match the ledger's current round, 23 if that round already has this same --agent-id on record, 24 if that round is already closed",
  },
  parameters: {
    flags: { ticket: ticketFlag, round: roundFlag, 'agent-id': agentIdFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; round: number; 'agent-id': string }) {
    runGuarded(() => {
      runRecordSeniorSpawned(flags.ticket, flags.round, flags['agent-id'])
    })
  },
})

const seniorShutdownCommand = buildCommand({
  docs: {
    brief:
      "Record the teardown of a round's senior — exits 18 if --agent-id does not match any of the ids recorded for that round at spawn, 22 if --round is ahead of the ledger's current round (a round already closed is accepted, so a teardown reported late still records)",
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      round: roundFlag,
      'agent-id': agentIdFlag,
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief:
          'Why this shutdown was recorded without an acknowledged handshake — an agent already gone, or one that never acknowledged',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; round: number; 'agent-id': string; reason?: string }) {
    runGuarded(() => {
      runRecordSeniorShutdown(flags.ticket, flags.round, flags['agent-id'], flags.reason)
    })
  },
})

const seniorRoutes = buildRouteMap({
  routes: { spawned: seniorSpawnedCommand, shutdown: seniorShutdownCommand },
  docs: { brief: "Record a review round's senior engineer lifecycle on the ledger" },
})

const reviewShaFlag = {
  kind: 'parsed' as const,
  parse: parseShaLike('--sha'),
  brief: 'The pinned commit sha this review is of',
  optional: false as const,
}

const reviewStartCommand = buildCommand({
  docs: {
    brief:
      "Senior: record that your review of the current round has begun — exits 22 if --round is not the ledger's current round, 28 if that round's review is already complete (the round was never closed)",
  },
  parameters: {
    flags: { ticket: ticketFlag, round: roundFlag, sha: reviewShaFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; round: number; sha: string }) {
    runGuarded(() => {
      runRecordReviewStart(flags.ticket, flags.round, flags.sha)
    })
  },
})

const reviewCompleteCommand = buildCommand({
  docs: {
    brief:
      "Senior: record that your review of the current round is finished and every finding is on the ledger — exits 22 if --round is not the ledger's current round, 28 if the round has no review start or is already complete",
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      round: roundFlag,
      sha: reviewShaFlag,
      verdict: {
        kind: 'parsed',
        parse: (s: string): ReviewVerdict => {
          if (s !== 'approve' && s !== 'changes')
            throw new Error(`--verdict must be approve or changes, got: ${s}`)
          return s
        },
        brief: 'approve, or changes when this round raised findings to fix',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; round: number; sha: string; verdict: ReviewVerdict }) {
    runGuarded(() => {
      runRecordReviewComplete(flags.ticket, flags.round, flags.sha, flags.verdict)
    })
  },
})

const reviewRoutes = buildRouteMap({
  routes: { start: reviewStartCommand, complete: reviewCompleteCommand },
  docs: { brief: "Record a review round's start and finish — written by the senior itself" },
})

const instructionRoutes = buildRouteMap({
  routes: {
    record: instructionRecordCommand,
    dispose: instructionDisposeCommand,
    'dispose-batch': instructionDisposeBatchCommand,
  },
  docs: { brief: 'Manage dispatched-instruction dispositions on the ledger' },
})

const noteRoutes = buildRouteMap({
  routes: { add: noteAddCommand, done: noteDoneCommand },
  docs: {
    brief: 'Record notes: PR body, Jira description and commit message defects for the lead',
  },
})

export const reviewLedgerRoutes = buildRouteMap({
  routes: {
    round: roundCommand,
    'round-close': roundCloseCommand,
    'next-round': nextRoundCommand,
    'round-advance': roundAdvanceCommand,
    stance: stanceCommand,
    show: showCommand,
    finding: findingRoutes,
    instruction: instructionRoutes,
    note: noteRoutes,
    senior: seniorRoutes,
    review: reviewRoutes,
  },
  docs: {
    brief: 'Review findings ledger: round-scoped findings and instruction dispositions per ticket',
  },
})
