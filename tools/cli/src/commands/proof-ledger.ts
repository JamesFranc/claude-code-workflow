import { readFileSync } from 'node:fs'
import { buildCommand, buildRouteMap } from '@stricli/core'
import { parseNonBlankString } from '../parse.ts'
import type { CaptureKind, ExpectedCommand } from '../proof-ledger/ledger.ts'
import { runRecord, runShow, runCheck, runGuarded } from '../proof-ledger/run.ts'

const ticketFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--ticket'),
  brief: 'Ticket id this ledger belongs to',
  optional: false as const,
}

const taskFlag = {
  kind: 'parsed' as const,
  parse: parseNonBlankString('--task'),
  brief: 'Task name, as named in the implementation plan',
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
  brief: 'Commit sha the capture was taken against',
  optional: false as const,
}

// Takes the flag name so a bad value points the caller at the flag it actually typed — `--capture`
// on `record`/`show`, `--require` on `check`, which has no `--capture` flag at all for a shared
// unparametrized message to misname.
const parseCaptureKind =
  (flagName: string) =>
  (value: string): CaptureKind => {
    if (value !== 'sweep' && value !== 'red' && value !== 'green' && value !== 'evidence')
      throw new Error(`${flagName} must be one of sweep, red, green, evidence, got: ${value}`)
    return value
  }

const parseExitStatus = (value: string): number => {
  if (!/^\d+$/.test(value.trim()))
    throw new Error(`--exit must be a non-negative integer, got: ${value}`)
  return Number(value.trim())
}

const parseRequired = (value: string): CaptureKind[] =>
  value.split(',').map((piece) => parseCaptureKind('--require')(piece.trim()))

const parseScope = (value: string): string[] => {
  const dirs = value
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
  if (dirs.length === 0) throw new Error(`--scope must name at least one dir, got: ${value}`)
  return dirs
}

// "<kind>:<command>" — split on the FIRST colon only, since the command half routinely contains its
// own colons (a path, a flag value). The kind half must be one of the four known kinds; there is no
// fifth kind an expected command could name.
const parseExpectedCommand = (value: string): ExpectedCommand => {
  const idx = value.indexOf(':')
  if (idx <= 0) throw new Error(`--expect-command must be "<kind>:<command>", got: ${value}`)
  const kindPart = value.slice(0, idx)
  if (kindPart !== 'sweep' && kindPart !== 'red' && kindPart !== 'green' && kindPart !== 'evidence')
    throw new Error(
      `--expect-command kind must be one of sweep, red, green, evidence, got: ${kindPart}`
    )
  const command = value.slice(idx + 1).trim()
  if (command.length === 0)
    throw new Error(`--expect-command command half must not be blank, got: ${value}`)
  return { kind: kindPart, command }
}

const recordCommand = buildCommand({
  docs: {
    brief:
      'Record a proof capture for a task at a sha — exits 6 if --sha does not resolve to a commit in --repo-root (checked for every capture kind, including --sha-is-label — the label exempts a capture from the tree-content checks below, never from --sha existing at all), if --capture red is missing --mutation-file, has a --mutation-file that is not a recognisable unified diff (a "--- "/"+++ " header pair or a "diff --git" line, an "@@ ... @@" hunk header, and at least one real +/- changed-content line), has --exit 0, or if the output is empty or whitespace-only without --note. A non-zero --exit is accepted under a real task key only for red, or for sweep with --exit 1 (grep/rg\'s own no-match convention — --exit 2 or higher means grep/rg itself failed to run, and is refused here same as any other kind; `git grep` also uses exit 1 for no-match but conflates it with some of its own errors, a bad path among them, so this exemption is not sound for a `git grep` sweep — verify the target path some other way). Every other non-zero --exit is only accepted under a task prefixed "fixture-" — record a deliberately-invalid capture (a counter-example, a corrupt-ledger reproduction) there, never under a real task key, or it poisons that key\'s coverage check forever. Those are examples rather than the set; the shape throughout is that a capture which cannot be tied to what it claims is refused, or records exactly which part went untied. A sweep also requires `--scope` unless `--sha-is-label`, which refuses it — the package dir(s) of the changed files — and is refused when a scope dir is not one of those or a found path (in grep/rg\'s line or listing format) lies outside them.',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      task: taskFlag,
      capture: {
        kind: 'parsed',
        parse: parseCaptureKind('--capture'),
        brief: 'Capture kind: sweep, red, green, or evidence',
        optional: false,
      },
      sha: shaFlag,
      command: {
        kind: 'parsed',
        parse: parseNonBlankString('--command'),
        brief: 'The exact command that was run',
        optional: false,
      },
      exit: {
        kind: 'parsed',
        parse: parseExitStatus,
        brief:
          "The command's observed exit status — record trusts this as typed and never runs --command itself to check it, so a mismatched value here still produces a capture that reads valid",
        optional: false,
      },
      'output-file': {
        kind: 'parsed',
        parse: parseNonBlankString('--output-file'),
        brief: "Path to a file holding the command's full output",
        optional: true,
      },
      output: {
        kind: 'parsed',
        parse: (value: string): string => value,
        brief: "The command's full output, given inline",
        optional: true,
      },
      'mutation-file': {
        kind: 'parsed',
        parse: parseNonBlankString('--mutation-file'),
        brief:
          'Path to the git diff of the mutation actually applied — required for --capture red, ' +
          'and refused on every other capture kind',
        optional: true,
      },
      note: {
        kind: 'parsed',
        parse: parseNonBlankString('--note'),
        brief: 'Optional free-text note',
        optional: true,
      },
      'repo-root': {
        kind: 'parsed',
        parse: parseNonBlankString('--repo-root'),
        brief:
          'Repo root record observes actual git state against — refuses a non-red capture taken ' +
          'while this working tree is dirty, and refuses a red capture whose --mutation-file, ' +
          'reversed against what is on disk, does not reproduce exactly what --sha holds ' +
          '(defaults to cwd)',
        optional: true,
      },
      'sha-is-label': {
        kind: 'boolean',
        brief:
          "This capture's --command does not read the tree at all (a process check, a session-" +
          'lifecycle read) — --sha only names which commit the capture belongs to, so skip the non-' +
          'red dirty-tree and checked-out-commit checks --repo-root would otherwise run against it. ' +
          '--sha must still resolve to a real commit in --repo-root — the label exempts it from the ' +
          'tree-content checks, never from existing at all',
        default: false,
      },
      scope: {
        kind: 'parsed',
        parse: parseScope,
        brief:
          'Sweep only, required unless --sha-is-label — a label sweep reads no tree and carries no ' +
          'scope: comma-separated repo-relative package dir(s) the sweep ran over — each must be the ' +
          'package dir (nearest manifest-bearing ancestor below the root, else ".") of a file the ' +
          "diff against origin/main changes at --sha; a found path outside them, in grep/rg's " +
          'line or listing format, is refused',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    task: string
    capture: CaptureKind
    sha: string
    command: string
    exit: number
    'output-file'?: string
    output?: string
    'mutation-file'?: string
    note?: string
    'repo-root'?: string
    'sha-is-label': boolean
    scope?: string[]
  }) {
    runGuarded(() => {
      const outputFile = flags['output-file']
      const outputInline = flags.output
      if (outputFile === undefined && outputInline === undefined)
        throw new Error('exactly one of --output-file or --output is required')
      if (outputFile !== undefined && outputInline !== undefined)
        throw new Error('--output-file and --output are mutually exclusive')
      const output = outputFile !== undefined ? readFileSync(outputFile, 'utf-8') : outputInline!

      const mutationFile = flags['mutation-file']
      const mutationDiff =
        mutationFile !== undefined ? readFileSync(mutationFile, 'utf-8') : undefined

      runRecord(
        { kind: 'check', repoRoot: flags['repo-root'] ?? process.cwd() },
        flags.ticket,
        flags.task,
        flags.capture,
        flags.sha,
        flags.command,
        flags.exit,
        output,
        mutationDiff,
        flags.note,
        flags['sha-is-label'],
        flags.scope
      )
    })
  },
})

const showCommand = buildCommand({
  docs: {
    brief: 'Print recorded proof captures as JSON, optionally filtered by sha, task, capture, id',
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      sha: {
        kind: 'parsed',
        parse: parseFullSha('--sha'),
        brief: 'Filter to captures at this sha',
        optional: true,
      },
      task: {
        kind: 'parsed',
        parse: parseNonBlankString('--task'),
        brief: 'Filter to captures for this task',
        optional: true,
      },
      capture: {
        kind: 'parsed',
        parse: parseCaptureKind('--capture'),
        brief: 'Filter to captures of this kind',
        optional: true,
      },
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Filter to the capture with this id',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; sha?: string; task?: string; capture?: CaptureKind; id?: string }) {
    runShow(flags.ticket, flags.sha, flags.task, flags.capture, flags.id)
  },
})

const checkCommand = buildCommand({
  docs: {
    brief:
      "Coverage check over the required capture kinds for a task at a sha — exits 3 if any required kind is missing or failing, or 4 if the ledger has a line it could not parse. --require is mandatory: name the kinds this task actually needs (sweep,evidence for a swept task; red,green for a guard/regression test; evidence alone for a sentinel task like repo-gates) — there is no default, since a fine-grained sub-proof task and its parent gate check need different kinds and the task name alone does not say which. Without --expect-command this checks presence per kind (one valid capture satisfies a kind), not count; name --expect-command to check that each expected capture under a kind exists individually. The required set can grow beyond --require and --expect-command from the ledger's own capture history for this task; there is no flag to disable that growth",
  },
  parameters: {
    flags: {
      ticket: ticketFlag,
      sha: shaFlag,
      task: taskFlag,
      require: {
        kind: 'parsed',
        parse: parseRequired,
        brief:
          "Comma-separated capture kinds required, e.g. sweep,evidence or red,green — mandatory, since a fine-grained sub-proof task and a task's parent gate check need different kinds and there is no way to infer which from the task name alone. The effective set can grow beyond what is named here, from the ledger's own history for this task (a task that has ever recorded a red requires red at every future sha; a valid red at the checked sha also requires green). There is no flag to opt out of that growth. Recording red and green at two different shas satisfies neither check: red's cross-sha requirement makes every future sha require red once any sha has one, and green only joins the required set when a valid red exists AT THE SHA BEING CHECKED — so record both at the same sha, typically $(git rev-parse HEAD) for both, to see them read ok together. A missing row at a sha that never recorded the kind is a true statement, not noise",
        optional: false,
      },
      'expect-command': {
        kind: 'parsed',
        parse: parseExpectedCommand,
        variadic: true,
        default: [],
        brief:
          '"<kind>:<command>" naming one specific capture expected under that kind (repeatable) — without this, one valid capture satisfies a kind regardless of how many were expected',
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    ticket: string
    sha: string
    task: string
    require: CaptureKind[]
    'expect-command': ExpectedCommand[]
  }) {
    runCheck(flags.ticket, flags.sha, flags.task, flags.require, flags['expect-command'])
  },
})

export const proofLedgerRoutes = buildRouteMap({
  routes: {
    record: recordCommand,
    show: showCommand,
    check: checkCommand,
  },
  docs: {
    brief:
      'Proof-capture ledger: one record per (task, capture kind, sha), and a coverage check over the required kinds',
  },
})
