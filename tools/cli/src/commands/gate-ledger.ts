import { readFileSync } from 'node:fs'
import { buildCommand, buildRouteMap } from '@stricli/core'
import { parseNonBlankString } from '../parse.ts'
import type { RerunCondition } from '../gate-ledger/ledger.ts'
import type { GateRole } from '../gate-ledger/manifest.ts'
import { runRecord, runShow, runCheck, runDeclare, runGuarded } from '../gate-ledger/run.ts'

const ticketFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--ticket'),
  brief: 'Ticket id this ledger belongs to',
  optional: false as const,
}

// Full sha only — no 7-40 character range like the shared parseShaLike. An abbreviation is git-legal
// only as an exact prefix of the full sha, and this ledger's record/check/show paths all make
// coverage decisions by comparing shas: accepting an abbreviation here would let a short prefix at
// `check` be satisfied by a different commit's green record. The boundary is this flag, not the
// shared parser — parseShaLike has callers outside this ledger that still want the 7-40 range.
const parseFullSha =
  (flagName: string) =>
  (value: string): string => {
    const trimmed = parseNonBlankString(flagName)(value)
    if (!/^[0-9a-f]{40}$/.test(trimmed))
      throw new Error(`${flagName} must be a full 40-character lowercase hex sha, got: ${trimmed}`)
    return trimmed
  }

const shaFlag = {
  kind: 'parsed' as const,
  parse: parseFullSha('--sha'),
  brief: 'Commit sha the gate ran against',
  optional: false as const,
}

const gateFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--gate'),
  brief: 'Gate name, as declared for the ticket',
  optional: false as const,
}

const manifestFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--manifest'),
  brief:
    "Explicit manifest file — overrides the ticket's declared gates; defaults to what `declare` wrote for the ticket",
  optional: true as const,
}

const fileFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--file'),
  brief:
    'Path to a local JSON file declaring this ticket\'s gates: { "gates": [{ "name", "command", "owner" }] }',
  optional: false as const,
}

const parseRole = (value: string): GateRole => {
  if (value !== 'implementer' && value !== 'team-lead' && value !== 'senior')
    throw new Error(`--role must be implementer, team-lead, or senior, got: ${value}`)
  return value
}

const parseCondition = (value: string): RerunCondition => {
  if (value !== 'inconsistent' && value !== 'contradicted' && value !== 'superseded')
    throw new Error(`--condition must be inconsistent, contradicted, or superseded, got: ${value}`)
  return value
}

const parseExitStatus = (value: string): number => {
  if (!/^\d+$/.test(value.trim()))
    throw new Error(`--exit must be a non-negative integer, got: ${value}`)
  return Number(value.trim())
}

const declareCommand = buildCommand({
  docs: {
    brief:
      'Declare this ticket\'s gates from a local JSON file into the workflow store — exits 8 if the file does not declare a usable "gates" array',
  },
  parameters: {
    flags: { ticket: ticketFlag, file: fileFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; file: string }) {
    runDeclare(flags.ticket, flags.file)
  },
})

const recordCommand = buildCommand({
  docs: {
    brief:
      'Record a gate run at a sha — exits 5 if --gate is not declared for the ticket, exits 6 if a re-run or a non-owning role is missing --condition/--reason',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      gate: gateFlag,
      sha: shaFlag,
      exit: {
        kind: 'parsed',
        parse: parseExitStatus,
        brief: 'Exit status the gate command produced',
        optional: false,
      },
      role: {
        kind: 'parsed',
        parse: parseRole,
        brief: 'Who ran the gate',
        optional: false,
      },
      'output-file': {
        kind: 'parsed',
        parse: parseNonBlankString('--output-file'),
        brief: "Path to a file holding the gate command's full output",
        optional: true,
      },
      output: {
        kind: 'parsed',
        parse: (value: string): string => value,
        brief: "The gate command's full output, given inline",
        optional: true,
      },
      condition: {
        kind: 'parsed',
        parse: parseCondition,
        brief: 'Why a re-run, or a non-owning role, is licensed',
        optional: true,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief: 'Required alongside --condition',
        optional: true,
      },
      manifest: manifestFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    gate: string
    sha: string
    exit: number
    role: GateRole
    'output-file'?: string
    output?: string
    condition?: RerunCondition
    reason?: string
    manifest?: string
  }) {
    runGuarded(() => {
      const outputFile = flags['output-file']
      const outputInline = flags.output
      if (outputFile === undefined && outputInline === undefined)
        throw new Error('exactly one of --output-file or --output is required')
      if (outputFile !== undefined && outputInline !== undefined)
        throw new Error('--output-file and --output are mutually exclusive')
      const output = outputFile !== undefined ? readFileSync(outputFile, 'utf-8') : outputInline!

      runRecord(
        flags.ticket,
        flags.gate,
        flags.sha,
        flags.exit,
        flags.role,
        output,
        flags.condition,
        flags.reason,
        flags.manifest
      )
    })
  },
})

const showCommand = buildCommand({
  docs: { brief: 'Print recorded gate runs as JSON, optionally filtered by sha and/or gate' },
  parameters: {
    flags: {
      ticket: ticketFlag,
      sha: {
        kind: 'parsed',
        parse: parseFullSha('--sha'),
        brief: 'Filter to runs at this sha',
        optional: true,
      },
      gate: {
        kind: 'parsed',
        parse: parseNonBlankString('--gate'),
        brief: 'Filter to runs of this gate',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; sha?: string; gate?: string }) {
    runShow(flags.ticket, flags.sha, flags.gate)
  },
})

const checkCommand = buildCommand({
  docs: {
    brief:
      'Coverage check over the declared gates at a sha — exits 3 if any declared gate is missing, failing or invalid, exits 8 if no gates are declared for the ticket',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      sha: shaFlag,
      manifest: manifestFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; sha: string; manifest?: string }) {
    runCheck(flags.ticket, flags.sha, flags.manifest)
  },
})

export const gateLedgerRoutes = buildRouteMap({
  routes: {
    declare: declareCommand,
    record: recordCommand,
    show: showCommand,
    check: checkCommand,
  },
  docs: {
    brief:
      'Gate-run ledger: one record per (gate, sha), and a coverage check over the declared gates',
  },
})
