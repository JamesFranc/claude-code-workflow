import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { STORE_UNREADABLE_EXIT, StoreUnreadableError } from '../workflow-store/store.ts'
import { readSidecar } from '../workflow-store/captured-output.ts'
import { MAX_LINE_BYTES } from '../workflow-store/line-budget.ts'
import {
  appendProofCapture,
  capturesFor,
  captureId,
  readProofLedger,
  writeMutationDiff,
  writeProofOutput,
  type CaptureKind,
  type ExpectedCommand,
  type ProofCaptureEvent,
  type ProofLedger,
} from './ledger.ts'
import { describeExecError, GIT_MAX_BUFFER_BYTES } from './git-exec.ts'

// The run layer. Every command prints JSON on stdout, exactly as gate-ledger/run.ts does. Exit
// codes:
//
//   0 — success; `check` with every required kind present at the sha.
//   3 — `check`: at least one required capture kind is missing at this sha, or ANY capture recorded
//       for that kind at this (task, sha) — not just the latest — is invalid: a non-zero exitStatus
//       where the kind requires zero (every kind but `red`, and but `sweep` when its exit is 0 or 1 —
//       grep/rg's own match/no-match convention, not command success (`git grep` shares the
//       convention but also uses 1 for some of its own errors — see the guard's own comment below); a
//       sweep exit of 2 or more means grep/rg itself failed to run, which IS invalid), or (for `red`)
//       a zero exitStatus or a mutation sidecar that is missing or not a recognisable diff, or (for
//       any kind) an output — or, for `red`, mutation — sidecar that is missing on disk, present but
//       could not be read (a parent directory denying traversal, say — distinct from missing, since
//       the evidence is intact and re-running the work would be wrong), or whose content no longer
//       matches the digest recorded at capture time, or an output sidecar digest shared with another
//       capture at the same (task, sha) — of any kind, not just this one — that asserts a different
//       exitStatus: at most one exit status can be true of one fixed output, so every capture sharing
//       that digest is invalid, not just whichever one is being read.
//   4 — `check`: the ledger has one or more lines it could not parse (`skippedLines > 0`). A skipped
//       line could have been the very `red` or `green` this check's `required` set is derived from —
//       gate-ledger's required set comes from a manifest external to its ledger, so a corrupt line
//       there degrades to a `missing` gate (safe); this ledger's required set is computed FROM the
//       ledger's own content, so without this exit a corrupt line degrades to "not required" instead
//       (unsafe — it would let a truncated ledger read as compliant). 4 is distinct from 3: 3 means
//       "the readable content is not enough", 4 means "the ledger cannot be trusted to say what
//       content it holds", and 4 always wins — it fires regardless of what `missing`/`failing` would
//       otherwise report.
//   6 — `record` with a `--sha` that does not resolve to a commit in `--repo-root` — checked for
//       every capture kind, including `--sha-is-label`, since the label exempts a capture from the
//       tree-content checks below, never from `--sha` naming a real commit at all; `record
//       --capture red` with no `--mutation-file`, with one whose content isn't a recognisable
//       diff, with one whose hunk header line counts do not match what its own body contains — a real
//       `git diff` cannot disagree with itself, so this is a hand-composed or hand-edited diff, not a
//       captured one (door 30); runs for every red regardless of `--repo-root`, unlike
//       the mismatch check below, since it needs no tree at all — or with `--exit 0` (a mutation that
//       never turned the test red is not a red baseline, no matter how the mutation file reads);
//       `record` with a non-zero --exit for any capture kind
//       other than red, and other than sweep with --exit 1, under a task not prefixed `fixture-` (a
//       deliberately-invalid capture recorded under a real task key would poison that key's coverage
//       check forever); `record` with an --output/--output-file that is empty or whitespace-only and
//       no `--note`; `record --repo-root <path>` for a non-red capture while <path>'s working tree is
//       dirty (uncommitted changes are, by definition, not part of the tree --sha names, so a non-red
//       capture taken against them cannot certify what --sha claims), or while <path>'s working tree
//       is clean but checked out at a commit other than --sha (a clean tree still isn't the tree
//       --sha names unless --sha IS the commit checked out — door 28) — neither half
//       of this pair applies when --sha-is-label is passed, for a sweep or evidence capture whose
//       --command never reads the tree at all (a process check, a session-lifecycle read): it has no
//       tree for --sha to be checked against, and --sha-is-label says so explicitly rather than
//       leaving it to be inferred — a red or green never reaches this exemption in practice, since
//       `record --capture red` or `record --capture green` with --sha-is-label is refused outright rather than
//       silently dropped — a red that also supplies --mutation-file gets --sha tied to the tree by
//       content (redMutationMismatch/unverifiedMutationPaths below), which --sha-is-label directly
//       contradicts, and a green is by definition the passing half of a run made against the tree at
//       --sha, so a --command that never read the tree leaves nothing for --sha-is-label to describe;
//       `record
//       --repo-root <path>` for a red capture whose --mutation-file, reversed against what is on disk
//       at <path> right now, does not reproduce exactly what --sha's tree holds for every file the
//       mutation touches — same
//       class as the dirty-tree case, since a red's mutation evidence is exactly as caller-typed as
//       --sha itself until it is checked against the tree --sha names, and a --mutation-file carried
//       forward from an earlier record onto a later --sha is exactly as uncertifiable as an
//       uncommitted change (see `redMutationMismatch` below for the mechanism; a file the mutation
//       touches that cannot be located under <path> is left unverified rather than refused — see
//       `resolveUnderRepoRoot`); `record --capture sweep` with no `--scope` when `--repo-root` is
//       checked and `--sha-is-label` is not set, with a `--scope` dir that is not the package dir
//       (nearest manifest-bearing ancestor below the root, else `.`) of any file the diff against
//       `origin/main` changes at `--sha`, with a found path in its output outside every `--scope`
//       dir, or when `origin/main` cannot be resolved to compute that; `--scope` on any capture kind
//       but sweep, or with `--sha-is-label` — a label sweep reads no tree and carries no scope; or
//       `record` with a --command too large to fit the ledger line budget
//       even with --note and the output tail fully shrunk to nothing (--command is never shrunk to
//       make room — see line-budget.ts — so this is a refusal, not a silent divergence between what
//       was passed and what got stored).
//   9 — an unexpected error, message on stdout under "error". This is every throw NOT already listed
//       under one of the specific codes above, StoreUnreadableError excepted (see 26 below) — a
//       specified, reachable, tested refusal belongs under its own code instead, so a caller can tell
//       "you gave record input it refuses" apart from "the tool broke".
//  26 — the ledger exists and could not be read (STORE_UNREADABLE_EXIT, shared with gate-ledger and
//       review-ledger). Under the generic 9 this would be indistinguishable from any other unexpected
//       throw, so a caller could not tell "no captures recorded here" from "this ledger could not be
//       read at all" — the same distinction gate-ledger/run.ts's own 26 draws for a manifest.
//
// `check` walks the kinds you name for the task you name. There is no proofs manifest, so a task
// never named here is invisible to it — the implementation plan's task list is what enumerates
// tasks, and the lead walks that. Do not read a green `check` as "this ticket's proofs are
// complete"; read it as "these kinds are present for this task at this sha". "Present" means EVERY
// capture recorded for this (task, kind, sha) is examined, not just the most recent — one invalid
// capture fails the row even when a later, valid one exists alongside it. And "recorded" is verified,
// not trusted: every capture's output sidecar (and, for `red`, its mutation sidecar) is re-read from
// disk and re-hashed against the digest stored at capture time — a sidecar deleted or silently
// swapped after recording fails the row exactly as a missing or non-diff mutation does, because a
// digest that is written and never read back is not a binding, it is a note to nobody.
//
// What `check` CANNOT observe without `--expect-command`: how many captures were expected under a
// kind. `required` is a set of kinds, not a count — one valid capture makes a kind's row `ok` whether
// it is the only one recorded or one of five, so a task that ought to carry five gate runs (or five
// guard tests) sharing one task key reads identically clean with only one of the five ever recorded.
// `--expect-command <kind>:<command>` (repeatable) is how a caller closes that hole for a kind: name
// every command expected under it and the row splits one-per-command, so an expected command with no
// matching capture reports `missing` by name instead of vanishing into an already-`ok` kind. A caller
// that names no expected commands for a kind gets the at-least-one-valid-capture behavior described
// above, unchanged — `check` never infers a count on its own. Naming a command narrows which
// captures get a NAMED row; it never narrows which captures get validity-checked. Every capture
// recorded under a kind — named by an `--expect-command` or not — is examined, and an invalid one
// that nobody named still fails the kind, reported under its own actual command.
//
// 252 is Stricli's own parse-failure code, not set by this module — documented here only so a
// caller reading this file for "what can this command exit with" finds the answer in one place.

// Every exported run* function's entire body runs inside this, the same guarantee
// gate-ledger/run.ts's runGuarded gives: an unexpected throw lands as JSON+exit 9, not a raw stack
// trace.
export const runGuarded = (fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    // A store that exists and cannot be read gets its own code. Under the generic 9 it is
    // indistinguishable from any other unexpected throw, so a caller cannot tell "no captures
    // recorded here" from "this ledger could not be read at all".
    if (err instanceof StoreUnreadableError) {
      writeJson({ error: err.message, code: err.code })
      setRequestedExitCode(STORE_UNREADABLE_EXIT)
      return
    }
    writeJson({ error: err instanceof Error ? err.message : String(err) })
    setRequestedExitCode(9)
  }
}

// Whether `record` observes the tree at all, and where — required, not optional, so every call site
// answers deliberately instead of a caller silently getting no verification by omitting a flag. The
// CLI always passes `check` (defaulting --repo-root to its own cwd); `no-check` exists for callers —
// direct-`runRecord` unit tests exercising something other than this mechanism — that say plainly
// they mean no verification, in code, visibly.
export type RepoRootCheck = { kind: 'check'; repoRoot: string } | { kind: 'no-check' }
export const NO_REPO_ROOT_CHECK: RepoRootCheck = { kind: 'no-check' }

export const runRecord = (
  repoRootCheck: RepoRootCheck,
  ticket: string,
  task: string,
  capture: CaptureKind,
  sha: string,
  command: string,
  exitStatus: number,
  output: string,
  mutationDiff?: string,
  note?: string,
  shaIsLabel = false,
  scope?: string[]
): void =>
  runGuarded(() => {
    if (shaIsLabel && capture === 'red') {
      writeJson({
        error:
          '--sha-is-label cannot be declared on a red capture: a red that supplies --mutation-file ' +
          'gets --sha tied to the tree by content (redMutationMismatch), and unverifiedMutationPaths ' +
          'is recorded as proof that check ran — --sha-is-label asserts the opposite, that --command ' +
          'never read the tree at all, so the two cannot both be true of the same line',
      })
      setRequestedExitCode(6)
      return
    }

    if (shaIsLabel && capture === 'green') {
      writeJson({
        error:
          '--sha-is-label cannot be declared on a green capture: green is by definition the passing ' +
          'half of a red baseline, a run made against the tree at --sha, so a --command that never ' +
          'read the tree leaves nothing for --sha-is-label to describe — --sha names the tree a ' +
          'green must certify, not a commit it is free to merely label',
      })
      setRequestedExitCode(6)
      return
    }

    if (shaIsLabel && scope !== undefined) {
      writeJson({
        error:
          '--scope is refused with --sha-is-label: a label sweep reads live state, not the tree at ' +
          '--sha, so its scope cannot be verified and an unverified scope must not be recorded — ' +
          "team-cleanup's teardown checks are the case",
      })
      setRequestedExitCode(6)
      return
    }

    // Every other check below ties --sha to the tree in some way (head-match for a non-red,
    // non-label capture; redMutationMismatch's own tree-content comparison for red, which now relies
    // on this check having already run) — the one capture with no such tie at all is --sha-is-label,
    // which skips the tree checks entirely. Checked here, once, for every capture kind rather than
    // only on the label path: existence is a
    // precondition every other check already assumes, not a property specific to one flag
    // combination. A repoRoot that is not a git repository at all fails the same exec the same way a
    // genuinely nonexistent sha does, so the message names both causes rather than blaming the sha
    // for what may be a wrong --repo-root — see shaResolvesToCommit's own hardening above this
    // function for what "resolves" verifies beyond a literal `git rev-parse`.
    if (repoRootCheck.kind === 'check' && !shaResolvesToCommit(repoRootCheck.repoRoot, sha)) {
      writeJson({
        error:
          `--sha ${sha} does not resolve to a commit in ${repoRootCheck.repoRoot}: either the sha ` +
          `names nothing there, or ${repoRootCheck.repoRoot} is not a git repository — pass ` +
          '--repo-root pointing at the repo the sha belongs to',
      })
      setRequestedExitCode(6)
      return
    }

    if (capture !== 'sweep' && scope !== undefined) {
      writeJson({
        error:
          '--scope is only valid on --capture sweep: it names the package dirs a sweep was allowed ' +
          'to run over, which no other capture kind is bounded by',
      })
      setRequestedExitCode(6)
      return
    }

    if (capture === 'sweep' && repoRootCheck.kind === 'check' && !shaIsLabel) {
      if (scope === undefined) {
        writeJson({
          error:
            'a sweep capture requires --scope: the package dir(s) of the files this ticket ' +
            'changes, comma-separated and repo-relative — for each changed file, the nearest ' +
            'ancestor below the root holding package.json, pyproject.toml, go.mod, Cargo.toml or ' +
            'Gemfile, else "." — a sweep with no stated scope cannot be aged (skills/team-dispatch/' +
            'SKILL.md step 18) and cannot be checked for widening',
        })
        setRequestedExitCode(6)
        return
      }
      const refusal = sweepScopeRefusal(repoRootCheck.repoRoot, sha, scope, output)
      if (refusal !== undefined) {
        writeJson({ error: refusal })
        setRequestedExitCode(6)
        return
      }
    }

    if (
      repoRootCheck.kind === 'check' &&
      capture !== 'red' &&
      !shaIsLabel &&
      isWorkingTreeDirty(repoRootCheck.repoRoot)
    ) {
      writeJson({
        error:
          `${repoRootCheck.repoRoot}'s working tree has uncommitted changes: a non-red capture ` +
          `cannot certify what --sha ${sha} claims when the tree that produced it does not match ` +
          'that commit — commit first, record --capture red with --mutation-file if this capture ' +
          'is meant to observe the mutation itself, or, for a sweep or evidence capture, pass ' +
          '--sha-is-label if --command does not read the tree at all and --sha is only naming which ' +
          'commit this capture belongs to',
      })
      setRequestedExitCode(6)
      return
    }

    // A clean tree alone (checked above) proves the tree matches SOME commit; it does not prove that
    // commit is --sha. redMutationMismatch (below) ties a red's --sha to the tree by content — its
    // fix was built for red alone (door 28) — so a non-red capture needs its own tie:
    // --sha must name the commit actually checked out, or a caller-typed --sha naming a different
    // commit than a genuinely clean tree still stamps a capture with a tree it never observed.
    // --sha-is-label (below) is the one way out, for a sweep or evidence capture whose --command
    // never reads the tree at all (a process check, a session-lifecycle read): it has no tree to tie
    // --sha to in the first place, and refusing it here would refuse commands this repo's own runtime
    // instructions document. A green never reaches this exemption — it is refused outright above.
    if (repoRootCheck.kind === 'check' && capture !== 'red' && !shaIsLabel) {
      const head = currentHeadSha(repoRootCheck.repoRoot)
      if (head !== sha) {
        writeJson({
          error:
            `${repoRootCheck.repoRoot} has ${head} checked out, not --sha ${sha}: a non-red ` +
            'capture certifies the tree at exactly the commit --sha names, and a clean tree at a ' +
            'different commit is not that tree — check out --sha, record with the sha that is ' +
            'actually checked out, or, for a sweep or evidence capture, pass --sha-is-label if ' +
            '--command does not read the tree at all and --sha is only naming which commit this ' +
            'capture belongs to',
        })
        setRequestedExitCode(6)
        return
      }
    }

    if (capture === 'red' && mutationDiff === undefined) {
      writeJson({
        error:
          'a red capture requires --mutation-file: the git diff of the mutation actually applied',
      })
      setRequestedExitCode(6)
      return
    }

    if (capture !== 'red' && mutationDiff !== undefined) {
      writeJson({
        error:
          '--mutation-file is only valid on --capture red: it names the mutation a red baseline is ' +
          'proving turned the test red, which no other capture kind checks against — record this ' +
          'capture without --mutation-file, or change --capture to red',
      })
      setRequestedExitCode(6)
      return
    }

    if (capture === 'red' && mutationDiff !== undefined && !isMutationDiff(mutationDiff)) {
      writeJson({
        error:
          'a red capture requires --mutation-file to contain a unified diff: a "--- "/"+++ " header pair or a "diff --git" line, an "@@ ... @@" hunk header, and at least one real +/- changed-content line — not blank, non-diff content, or a header with no hunk',
      })
      setRequestedExitCode(6)
      return
    }

    if (capture === 'red' && mutationDiff !== undefined) {
      const corruption = truncatedMutationReason(mutationDiff)
      if (corruption !== undefined) {
        writeJson({ error: corruption })
        setRequestedExitCode(6)
        return
      }
    }

    if (capture === 'red' && mutationDiff !== undefined) {
      const noSection = noResolvableSectionReason(mutationDiff)
      if (noSection !== undefined) {
        writeJson({ error: noSection })
        setRequestedExitCode(6)
        return
      }
    }

    if (capture === 'red' && exitStatus === 0) {
      writeJson({
        error:
          'a red capture requires a non-zero --exit: exitStatus 0 means the mutation never turned the test red, so it is not a red baseline no matter how the mutation file reads',
      })
      setRequestedExitCode(6)
      return
    }

    // undefined (not []) means the check never ran — a NO_REPO_ROOT_CHECK red, or any capture that
    // is not a red with a mutation diff — so its later absence from the persisted event cannot be
    // misread as "ran and found nothing unverified".
    let mutationUnverified: string[] | undefined
    if (repoRootCheck.kind === 'check' && capture === 'red' && mutationDiff !== undefined) {
      const outsideDirty = dirtyPathsOutsideMutation(repoRootCheck.repoRoot, mutationDiff)
      if (outsideDirty.length > 0) {
        writeJson({
          error:
            `${repoRootCheck.repoRoot}'s working tree has uncommitted changes outside ` +
            `--mutation-file's own files (${outsideDirty.join(', ')}): a red capture is exempt from ` +
            'the dirty-tree refusal only for the files its own --mutation-file names, not the rest ' +
            'of the tree — commit or revert the rest before recording',
        })
        setRequestedExitCode(6)
        return
      }

      const { error: mismatch, unverified } = redMutationMismatch(
        repoRootCheck.repoRoot,
        sha,
        mutationDiff
      )
      if (mismatch !== undefined) {
        writeJson({ error: mismatch })
        setRequestedExitCode(6)
        return
      }
      mutationUnverified = unverified
    }

    // A deliberately-non-zero, deliberately-invalid capture of any kind but `red` — a counter-example
    // demonstrating a check's old broken behavior, a corrupt-ledger reproduction — is exactly as
    // invalid to `check`'s P1 sweep as a genuine failure. Recorded under the same task key as the real
    // gate it sits beside, it poisons that key's coverage forever: P1 requires EVERY capture
    // at a (task, kind, sha) to be valid, with no way to tell "this failure is the point" from "this
    // failure is a bug." `sweep` with --exit 1 is exempted because grep and rg both use exit 1
    // exclusively for their own "no match" convention, not command failure — a zero-match sweep, the
    // desired "defect class now absent" outcome, exits 1 under that convention, and that outcome must
    // stay recordable under the real task's own coverage, not shunted to a fixture key no acceptance
    // contract is ever checked against. `git grep` ALSO exits 1 for "no match", but conflates it with
    // several of its own error conditions — a nonexistent path among them — so an exit-1 `git grep`
    // sweep over a bad path is indistinguishable from a genuine zero-match result by exit code alone;
    // this exemption does not close that gap for `git grep`, only for grep/rg, and a caller sweeping
    // with `git grep` must verify the target path exists some other way. A sweep exiting 2 or higher
    // is NOT exempted — for grep/rg that range means the tool itself failed to run (bad path,
    // malformed pattern, binary not found), the same "point" vs. "bug" ambiguity this guard exists to
    // prevent, so it is refused here exactly like any other kind's non-zero exit. `fixture-`-prefixed
    // task keys remain reserved for every other kind's (and every other sweep exit status's)
    // deliberately-invalid capture — so recording a non-zero, non-`red`, non-sweep-exit-1 capture
    // anywhere else is refused here, at the only point that can still stop it.
    const sweepExitIsMatchConvention = capture === 'sweep' && exitStatus === 1
    if (
      capture !== 'red' &&
      !sweepExitIsMatchConvention &&
      exitStatus !== 0 &&
      !task.startsWith('fixture-')
    ) {
      writeJson({
        error:
          'a non-zero --exit for a capture kind other than red, or other than sweep with --exit 1, is only valid under a task prefixed "fixture-" — a deliberately-invalid capture recorded under a real task key poisons the coverage check for that key forever, since every capture at a (task, kind, sha) must be valid for the row to read ok',
      })
      setRequestedExitCode(6)
      return
    }

    if (output.trim().length === 0 && note === undefined) {
      writeJson({
        error:
          'an empty or whitespace-only --output/--output-file requires --note: a result with no visible content is exactly as uninformative as a truly empty one, so it must be told apart from every other such result — name the set the command swept and the input that would have made it fail',
      })
      setRequestedExitCode(6)
      return
    }

    const { outputPath, outputSha256, outputBytes, tail, truncated } = writeProofOutput(
      ticket,
      capture,
      task,
      sha,
      output
    )

    const mutation =
      mutationDiff !== undefined ? writeMutationDiff(ticket, task, sha, mutationDiff) : undefined

    const id = captureId(task, capture, sha, command, outputSha256)

    const event: ProofCaptureEvent = {
      kind: 'proof-capture',
      at: new Date().toISOString(),
      id,
      task,
      capture,
      sha,
      command,
      exitStatus,
      outputPath,
      outputSha256,
      outputBytes,
      tail,
      ...(truncated ? { truncated: true } : {}),
      ...(mutation !== undefined
        ? {
            mutationPath: mutation.outputPath,
            mutationSha256: mutation.outputSha256,
            mutationBytes: mutation.outputBytes,
          }
        : {}),
      ...(note !== undefined ? { note } : {}),
      ...(mutationUnverified !== undefined ? { unverifiedMutationPaths: mutationUnverified } : {}),
      ...(shaIsLabel ? { shaIsLabel: true } : {}),
      ...(scope !== undefined ? { scope: scope.map(normalizeScopeDir) } : {}),
    }

    let appended: { noteTruncated: boolean }
    try {
      appended = appendProofCapture(ticket, event)
    } catch (err) {
      // fitLine (workflow-store/line-budget.ts) throws only once tail and note are both shrunk to
      // nothing and the remaining identifiers still exceed MAX_LINE_BYTES. --command (caller-sized,
      // unbounded) and unverifiedMutationPaths (redMutationMismatch-derived, the caller never sees or
      // sizes it) are the two this branch can isolate and re-measure independently — not the only
      // fields capable of overflowing the budget on their own. outputPath and mutationPath are
      // themselves unbounded strings, and how long a real path gets is filesystem-dependent (Linux's
      // 4096-byte PATH_MAX versus macOS's 1024), so a path-shaped field is never safely assumed
      // short. Blaming --command unconditionally names the wrong cause whenever unverifiedMutationPaths
      // is the actual overflow — the class this branch keeps paying for —
      // so this measures the floor with and without unverifiedMutationPaths before naming either.
      if (err instanceof Error && err.message.startsWith('proof-ledger: event cannot fit in')) {
        // fitLine only stamps lineTruncated: true onto a candidate it successfully shrunk — the throw
        // this catches fires before that assignment, on the pre-shrink candidate, so measuring with
        // lineTruncated included would over-count by that field's own serialized size.
        const floorBytes = (includeMutationUnverified: boolean): number =>
          Buffer.byteLength(
            JSON.stringify({
              ...event,
              tail: '',
              ...(note !== undefined ? { note: '' } : {}),
              ...(includeMutationUnverified ? {} : { unverifiedMutationPaths: undefined }),
            }),
            'utf-8'
          )

        if (
          mutationUnverified !== undefined &&
          floorBytes(true) > MAX_LINE_BYTES &&
          floorBytes(false) <= MAX_LINE_BYTES
        ) {
          writeJson({
            error: `this red capture's mutation-verification result (${mutationUnverified.length} unresolved path(s) recorded by redMutationMismatch) cannot fit the ledger line budget even with --note and the output tail fully shrunk to nothing — unverifiedMutationPaths is derived, not caller-typed, and is never shrunk to make room: narrow --mutation-file so fewer sections go unresolved, or split the capture`,
          })
          setRequestedExitCode(6)
          return
        }

        writeJson({
          error:
            'a --command this large cannot fit the ledger line budget even with --note and the output tail fully shrunk to nothing — command is never shrunk to make room, so this refuses rather than silently storing a command different from what was passed: shorten --command, or move detail into --output/--note instead',
        })
        setRequestedExitCode(6)
        return
      }
      throw err
    }
    const { noteTruncated } = appended

    writeJson({
      ticket,
      id,
      task,
      capture,
      sha,
      exitStatus,
      outputPath,
      outputSha256,
      outputBytes,
      ...(mutation !== undefined
        ? {
            mutationPath: mutation.outputPath,
            mutationSha256: mutation.outputSha256,
            mutationBytes: mutation.outputBytes,
          }
        : {}),
      ...(noteTruncated
        ? {
            warning:
              "--note was shortened to fit the ledger line's 4096-byte budget (MAX_LINE_BYTES) — the removed portion has no sidecar and is not preserved anywhere; narrow the note or move the detail into --output instead",
          }
        : {}),
      // Persisted to the ledger above whenever the check ran at all — shown
      // here on stdout only when there is something to flag, since an empty result is not this
      // command's caller's problem to see at record time.
      ...(mutationUnverified !== undefined && mutationUnverified.length > 0
        ? { unverifiedMutationPaths: mutationUnverified }
        : {}),
      ...(scope !== undefined ? { scope: scope.map(normalizeScopeDir) } : {}),
    })
  })

export const runShow = (
  ticket: string,
  sha?: string,
  task?: string,
  capture?: CaptureKind,
  id?: string
): void =>
  runGuarded(() => {
    const ledger = readProofLedger(ticket)
    const captures = ledger.captures.filter(
      (c) =>
        (sha === undefined || c.sha === sha) &&
        (task === undefined || c.task === task) &&
        (capture === undefined || c.capture === capture) &&
        (id === undefined || c.id === id)
    )
    writeJson({ ticket, captures, skippedLines: ledger.skippedLines })
  })

export const runCheck = (
  ticket: string,
  sha: string,
  task: string,
  required: CaptureKind[],
  expectCommands: ExpectedCommand[] = []
): void =>
  runGuarded(() => {
    const ledger = readProofLedger(ticket)
    const result = checkTask(ledger, task, sha, required, expectCommands)
    const corrupted = ledger.skippedLines > 0

    writeJson({
      ticket,
      sha,
      task: result.task,
      required: result.required,
      rows: result.rows,
      missing: result.missing,
      failing: result.failing,
      skippedLines: ledger.skippedLines,
      ...(corrupted ? { corrupted: true } : {}),
    })
    if (corrupted) {
      setRequestedExitCode(4)
      return
    }
    if (result.missing.length > 0 || result.failing.length > 0) setRequestedExitCode(3)
  })

interface ProofCheckRow {
  capture: CaptureKind
  command?: string
  state: 'missing' | 'failing' | 'ok'
  reason?: string
}

interface TaskCheckResult {
  task: string
  required: CaptureKind[]
  rows: ProofCheckRow[]
  missing: string[]
  failing: string[]
}

// The unit `check` demands under a required kind, named by the caller. Without this, `required` is
// only a set of KINDS — nothing establishes how many captures must exist under one, so one capture
// makes a row `ok` whether it is the only gate run or one of three. Naming expected commands turns
// that silence into a `missing` row per absent command; naming none keeps the at-least-one-valid-
// capture behavior for that kind, unchanged.
const checkTask = (
  ledger: ProofLedger,
  task: string,
  sha: string,
  required: CaptureKind[],
  expectCommands: ExpectedCommand[]
): TaskCheckResult => {
  // A recorded `red` cannot be checked-around by an unnamed requirement, on either axis — the flag
  // (or declaration) or the sha. Once this task has EVER had a red, at any sha, `red` joins the
  // required set for EVERY future check of this task, at every sha — not just the sha the red was
  // recorded at. If no red exists at the checked sha, the row is `missing` below (silence is the
  // defect this exists to surface), and if one exists but is invalid, the row is `failing`. Neither
  // state is ever silently absent from `required`. `green`'s rule stays narrower and sha-scoped: it
  // joins only when a valid red exists AT THE CHECKED SHA — a fix can't be demanded as proof against
  // a baseline that isn't present there, and a missing red already fails the check on its own. A kind
  // named only via an expected command (not `required`) joins `required` here too — naming an
  // expected command for a kind is itself a declaration that the kind is required.
  const digestConflicts = outputDigestConflicts(ledger, task, sha)
  const invalidReason = (c: ProofCaptureEvent): string | undefined =>
    digestConflicts.get(c.id) ?? captureInvalidReason(c)

  const requiredWithExpected: CaptureKind[] = [
    ...new Set([...required, ...expectCommands.map((e) => e.kind)]),
  ]
  const everHadRed = ledger.captures.some((c) => c.task === task && c.capture === 'red')
  const redsAtSha = capturesFor(ledger, task, 'red', sha)
  const hasValidRedAtSha = redsAtSha.some((c) => invalidReason(c) === undefined)
  const withRed: CaptureKind[] = everHadRed
    ? [...requiredWithExpected, 'red']
    : requiredWithExpected
  const withGreen: CaptureKind[] = hasValidRedAtSha ? [...withRed, 'green'] : withRed
  const effectiveRequired: CaptureKind[] = [...new Set(withGreen)]

  const expectedByKind = new Map<CaptureKind, string[]>()
  for (const { kind, command } of expectCommands) {
    const list = expectedByKind.get(kind) ?? []
    list.push(command)
    expectedByKind.set(kind, list)
  }

  // P1: a row is `ok` only when EVERY capture recorded at this (task, kind, sha) is valid — not
  // just the latest. A required kind recorded honestly more than once (N gate commands sharing one
  // sentinel task key, N guard tests) must have all N valid; one invalid capture fails the row even
  // when a later capture at the same key is fine, exactly as `red` already required before this
  // fix, and now every other kind too.
  //
  // A kind named in an expected command gets one row per expected command instead of one row for
  // the whole kind — `captures` is filtered to that exact command string before P1 applies, so a
  // kind with three expected commands and only one recorded reports two rows `missing`, not one
  // row `ok`. A kind with no expected commands keeps the single per-kind row.
  //
  // The seventh door: naming expected commands for a kind must never stop the OTHER
  // captures under that same (task, kind, sha) from being validity-checked. `unnamedInvalidRows`
  // sweeps every capture whose command no expected command named and fails the kind, by that
  // capture's own actual command, on any of them that P1 would reject — additive to the named rows
  // above, never a substitute for them.
  const rows: ProofCheckRow[] = effectiveRequired.flatMap((kind): ProofCheckRow[] => {
    const expectedCommands = expectedByKind.get(kind)
    if (expectedCommands === undefined) {
      const captures = capturesFor(ledger, task, kind, sha)
      if (captures.length === 0) return [{ capture: kind, state: 'missing' }]
      for (const c of captures) {
        const reason = invalidReason(c)
        if (reason !== undefined) return [{ capture: kind, state: 'failing', reason }]
      }
      return [{ capture: kind, state: 'ok' }]
    }
    const namedRows = expectedCommands.map((command): ProofCheckRow => {
      const captures = capturesFor(ledger, task, kind, sha).filter((c) => c.command === command)
      if (captures.length === 0) return { capture: kind, command, state: 'missing' }
      for (const c of captures) {
        const reason = invalidReason(c)
        if (reason !== undefined) return { capture: kind, command, state: 'failing', reason }
      }
      return { capture: kind, command, state: 'ok' }
    })
    return [
      ...namedRows,
      ...unnamedInvalidRows(ledger, task, kind, sha, expectedCommands, invalidReason),
    ]
  })

  const missing = rows
    .filter((r) => r.state === 'missing')
    .map((r) => (r.command !== undefined ? `${r.capture}:${r.command}` : r.capture))
  const failing = rows
    .filter((r) => r.state === 'failing')
    .map((r) => (r.command !== undefined ? `${r.capture}:${r.command}` : r.capture))

  return { task, required: effectiveRequired, rows, missing, failing }
}

// The seventh door's close: every capture under (task, kind, sha) whose command no
// `--expect-command` named still gets P1-validity-checked. A named row already covers its own exact
// command; this covers everything else recorded under the same kind at the same key, so an invalid
// capture cannot hide simply because nobody happened to name its command.
const unnamedInvalidRows = (
  ledger: ReturnType<typeof readProofLedger>,
  task: string,
  kind: CaptureKind,
  sha: string,
  expectedCommands: string[],
  invalidReason: (c: ProofCaptureEvent) => string | undefined
): ProofCheckRow[] => {
  const named = new Set(expectedCommands)
  return capturesFor(ledger, task, kind, sha)
    .filter((c) => !named.has(c.command))
    .flatMap((c): ProofCheckRow[] => {
      const reason = invalidReason(c)
      return reason === undefined
        ? []
        : [{ capture: kind, command: c.command, state: 'failing', reason }]
    })
}

// The twentieth door: two captures at the same (task, sha) — any kinds, not just the same one — can
// share a byte-identical output sidecar digest while asserting `exitStatus` values that cannot both
// be true of that one fixed output (one command run once produces one exit status). Grouping by
// digest instead of by a guessed intent is what makes this structural rather than heuristic — it
// needs no judgment about which capture is the "real" one, only that a shared digest with more than
// one distinct exit status among its group is self-contradictory, so every capture in that group is
// invalid, not just whichever one a caller happens to be checking.
const outputDigestConflicts = (
  ledger: ProofLedger,
  task: string,
  sha: string
): Map<string, string> => {
  const byDigest = new Map<string, ProofCaptureEvent[]>()
  for (const c of ledger.captures) {
    if (c.task !== task || c.sha !== sha) continue
    const group = byDigest.get(c.outputSha256) ?? []
    group.push(c)
    byDigest.set(c.outputSha256, group)
  }

  const reasons = new Map<string, string>()
  for (const [digest, group] of byDigest) {
    const statuses = [...new Set(group.map((c) => c.exitStatus))].sort((a, b) => a - b)
    if (statuses.length <= 1) continue
    const reason = `output sidecar digest ${digest} is shared by ${group.length} captures at this (task, sha) asserting conflicting exit statuses (${statuses.join(', ')}) — at most one can be true of one fixed output`
    for (const c of group) reasons.set(c.id, reason)
  }
  return reasons
}

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

// A red capture is recognisable by an actual mutation, not merely a diff-shaped header — a header
// alone (a banner log mimicking "--- "/"+++ ", a `diff --git` line with no hunk, a mode-only or
// rename-only diff, a markdown fence quoting the format without real content) must not satisfy
// `--mutation-file`. This accepts real output from `git diff`, `git diff -U0`, and plain `diff -u`
// under a "unified diff" contract — `git diff --word-diff` is deliberately still refused, it is not a
// unified diff. A changed-content line is identified by its POSITION, not its own text: a line counts
// only while inside a hunk — after an `@@ ... @@` header and before the next `diff --git` line (which
// resets hunk state for the next file in a multi-file diff). Discriminating on position instead of a
// line's leading characters is what lets a deleted line whose own content starts with "-- " (a SQL,
// Lua, Haskell, Elm, or Ada comment) still count as real change content, while a file's own
// "--- a/path"/"+++ b/path" header lines — which always precede the hunk they introduce — never do.
const isMutationDiff = (content: string): boolean => {
  const trimmed = content.trim()
  if (trimmed.length === 0) return false
  const hasDiffHeader =
    /^diff --git /m.test(trimmed) || (/^--- /m.test(trimmed) && /^\+\+\+ /m.test(trimmed))
  if (!hasDiffHeader) return false

  let inHunk = false
  for (const line of trimmed.split('\n')) {
    if (/^diff --git /.test(line)) {
      inHunk = false
      continue
    }
    if (/^@@ .*@@/.test(line)) {
      inHunk = true
      continue
    }
    if (inHunk && (line.startsWith('+') || line.startsWith('-'))) return true
  }
  return false
}

// Live-observed, not caller-typed: `record` runs this itself against `repoRoot` at the moment it is
// asked to write a capture, rather than trusting a flag. `--sha` alone cannot substitute for this —
// a sha equal to the repo's actual HEAD says nothing about whether the working tree still matches
// that commit's tree, and a non-red capture taken while it does not can never certify what --sha
// claims. Nothing this observes is persisted to the ledger: `check` never reads it back, so
// there is no field whose later absence could be misread as "the tree was clean".
const isWorkingTreeDirty = (repoRoot: string): boolean =>
  execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  })
    .toString()
    .trim().length > 0

const currentHeadSha = (repoRoot: string): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  })
    .toString()
    .trim()

// Reversing the mutation (below) only inspects the files --mutation-file itself names — nothing else
// checks a red capture for changes outside those files, so a red exempted the whole tree from the
// dirty-tree refusal above rather than only the files its own mutation touches (door 28's own
// gap was fixed here for red alone — its non-red half is closed separately, by runRecord's own
// head-sha check above). A red is by definition dirty in its
// mutation's own files; that justifies exempting exactly those files, not the rest of the tree.
const dirtyPathsOutsideMutation = (repoRoot: string, mutationDiff: string): string[] => {
  const mutationPaths = new Set(
    splitDiffByFile(mutationDiff).flatMap(({ aPath, bPath }) => {
      const relPath =
        (bPath !== undefined ? resolveUnderRepoRoot(repoRoot, bPath, 'HEAD') : undefined) ??
        (aPath !== undefined ? resolveUnderRepoRoot(repoRoot, aPath, 'HEAD') : undefined)
      return relPath !== undefined ? [relPath] : []
    })
  )
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  })
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      return arrow === -1 ? path : path.slice(arrow + 4)
    })
    .filter((path) => !mutationPaths.has(path))
}

// `git show <sha>:<path>` fails identically (exit 128) whether <sha> itself does not resolve to any
// commit or <sha> resolves fine and <path> is merely absent from its tree — execFileSync's thrown
// error carries nothing that distinguishes the two. redMutationMismatch's create-shaped-mutation check
// depends on telling them apart: only the second is evidence the path was legitimately absent; the
// first means --sha was never checkable at all, and reading it as "path absent" lets an unresolvable
// --sha slip through as a verified match instead of being refused (E1).
//
// `--no-replace-objects` closes a real type-confusion path verified empirically (git 2.55.0): a
// `refs/replace/<blobSha>` ref pointing at a real commit — installed directly via `git update-ref`,
// bypassing the type check `git replace` itself enforces at creation time — makes `<blobSha>^{commit}`
// resolve successfully, when the blob it actually names never would. That would let a --sha naming
// something other than a commit pass this gate as checkable. `GIT_GRAFT_FILE` carries no matching
// effect here — a graft rewrites an existing commit's parent list, not what type an object is or
// whether it resolves at all — this call is the only one of the file's `--no-replace-objects`
// call sites that also empties the graft file via `GIT_GRAFT_FILE`, and it is retained as a
// defensive lever, not to match anything else here.
const shaResolvesToCommit = (repoRoot: string, sha: string): boolean => {
  try {
    execFileSync(
      'git',
      ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      {
        cwd: repoRoot,
        stdio: 'pipe',
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        env: { ...process.env, GIT_GRAFT_FILE: '/dev/null' },
      }
    )
    return true
  } catch {
    return false
  }
}

const PACKAGE_MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile']

// undefined when every --scope dir is the package dir of a file the diff at `sha` changes and
// every path the output names lies inside one of them; otherwise the refusal, naming what fell
// outside. The licensed set is computed from the diff, never declared: a scope that must equal the
// package set of the changed files has one correct value, and a caller cannot widen it by naming
// a wider one.
const sweepScopeRefusal = (
  repoRoot: string,
  sha: string,
  scope: readonly string[],
  output: string
): string | undefined => {
  const normalized = scope.map(normalizeScopeDir)
  if (normalized.length === 0) return 'a sweep capture requires at least one --scope dir'
  const changed = changedFilesAgainstOriginMain(repoRoot, sha)
  if (changed === null)
    return (
      `cannot resolve the diff against origin/main at ${sha} in ${repoRoot} — a sweep's --scope is ` +
      'checked against the package dirs of the files that diff changes, so origin/main must ' +
      'resolve there: fetch it, or pass --repo-root pointing at a checkout that has it'
    )
  const tracked = trackedFilesAt(repoRoot, sha)
  if (tracked === null) return `cannot list the tree at ${sha} in ${repoRoot}`
  const licensed = new Set(changed.map((path) => packageDirOf(path, tracked)))
  const unlicensed = normalized.filter((dir) => !licensed.has(dir))
  if (unlicensed.length > 0)
    return (
      `--scope ${unlicensed.join(', ')} is not the package dir of any file the diff against ` +
      `origin/main changes at ${sha} — the licensed scope is ${[...licensed].sort().join(', ') || '(nothing changed)'}; ` +
      "a sweep is bounded to the change's own packages, and a site elsewhere is a process note, " +
      'not a finding'
    )
  const outside = foundPaths(output, repoRoot, tracked).filter(
    (path) => !normalized.some((dir) => isUnder(path, dir))
  )
  if (outside.length > 0)
    return (
      `the sweep found ${outside.join(', ')} outside --scope ${normalized.join(', ')} — a sweep ` +
      'does not widen: narrow the command to its scope and re-run, and carry the outside site to ' +
      'the process notes'
    )
  return undefined
}

const changedFilesAgainstOriginMain = (repoRoot: string, sha: string): string[] | null => {
  try {
    const mergeBase = execFileSync('git', ['merge-base', 'origin/main', sha], {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    })
      .toString()
      .trim()
    return execFileSync('git', ['diff', '--name-only', '-z', mergeBase, sha], {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    })
      .toString()
      .split('\0')
      .filter((line) => line.length > 0)
  } catch {
    return null
  }
}

const trackedFilesAt = (repoRoot: string, sha: string): Set<string> | null => {
  try {
    return new Set(
      execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', sha], {
        cwd: repoRoot,
        stdio: 'pipe',
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      })
        .toString()
        .split('\0')
        .filter((line) => line.length > 0)
    )
  } catch {
    return null
  }
}

// The nearest ancestor dir of `path` below the root (its own dir first) holding a package manifest
// at the sha `tracked` lists; '.' when none does — a file with no closer manifest lives in the
// root package, which is the one case the root is a scope.
const packageDirOf = (path: string, tracked: ReadonlySet<string>): string => {
  const parts = path.split('/').slice(0, -1)
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const dir = parts.slice(0, depth).join('/')
    if (PACKAGE_MANIFESTS.some((manifest) => tracked.has(`${dir}/${manifest}`))) return dir
  }
  return '.'
}

const normalizeScopeDir = (dir: string): string => {
  const trimmed = dir.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return trimmed === '' ? '.' : trimmed
}

const isUnder = (path: string, dir: string): boolean =>
  dir === '.' || path === dir || path.startsWith(`${dir}/`)

// The tracked paths a grep/rg-shaped output names: for each line, the text before the first ':'
// when the line contains one (a grep/rg -n hit), else the trimmed line itself (a bare path per
// line — grep/rg -l or --files-with-matches), repo-relative, './'-prefixed, or absolute under
// --repo-root. An absolute candidate is matched by trying its literal spelling and its realpath
// (when it resolves) against both --repo-root's own spelling and --repo-root's realpath. So it
// escapes exactly when neither of its spellings is under either root spelling — which is what a
// line spelled under yet a third symlink to the root does, whether its candidate resolves outside
// the repo or does not resolve at all. A symlinked spelling on either side is otherwise matched:
// macOS /tmp vs /private/tmp, in the root or in the line, and a tracked file that is itself a
// symlink resolving outside --repo-root when the line is spelled under one of --repo-root's own
// two spellings. A candidate that names no tracked file is not a hit — a constructed-positive
// run over a temp file, a summary line — and is left alone. Output that neither leads with the path
// nor is a bare path per line (a custom formatter) is therefore not checked.
const foundPaths = (output: string, repoRoot: string, tracked: ReadonlySet<string>): string[] => {
  const found = new Set<string>()
  const strippedRoot = repoRoot.replace(/\/+$/, '')
  let resolvedRoot: string | undefined
  try {
    resolvedRoot = realpathSync(repoRoot).replace(/\/+$/, '')
  } catch {
    resolvedRoot = undefined
  }
  const rootPrefixes = [
    ...new Set([strippedRoot, resolvedRoot].filter((r): r is string => r !== undefined)),
  ].map((r) => `${r}/`)

  const candidateSpellings = (candidate: string): readonly string[] => {
    if (!candidate.startsWith('/')) return [candidate]
    try {
      const resolved = realpathSync(candidate)
      return resolved === candidate ? [candidate] : [candidate, resolved]
    } catch {
      return [candidate]
    }
  }

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    const rawCandidate = colon === -1 ? line : line.slice(0, colon)

    for (const candidate of candidateSpellings(rawCandidate)) {
      const prefix = rootPrefixes.find((p) => candidate.startsWith(p))
      const path =
        prefix !== undefined ? candidate.slice(prefix.length) : candidate.replace(/^\.\//, '')
      if (tracked.has(path)) {
        found.add(path)
        break
      }
    }
  }
  return [...found].sort()
}

// `git ls-tree <sha> -- <relPath>` reads the tree object only and never touches the blob it names, so
// it can establish presence or absence as an observed fact instead of an exception decoded by exit
// status — unlike `git show <sha>:<path>`, which exits 128 identically whether <sha> itself does not
// resolve, <path> is legitimately absent from its tree, or the blob object <path> names is missing or
// corrupt (all three verified empirically to throw the identical `code=undefined status=128
// signal=null` shape). No `-r` is needed or wanted: an exact nested pathspec (`a/b/c/deep.txt`)
// resolves without it, while `-r` on a pathspec naming a directory silently expands to that
// directory's contents instead of returning the directory's own tree entry — the distinction this
// helper exists to preserve. Any exception from this call refuses unconditionally: there is no
// legitimate throw case left to decode once presence is observed this way — the status-128
// discriminator this replaced treated a corrupt/missing blob object identically to a legitimately
// absent path.
//
// `--no-replace-objects` closes a path distinct from the one `shaResolvesToCommit` above closes, and
// unaffected by that lever: `shaResolvesToCommit` catches a replace ref that makes a non-commit
// resolve as one, but a replace ref between two real commits needs no such forgery — `git replace`
// itself permits it, since both sides are already commits — and `<sha>^{commit}` resolves to `sha`
// either way, levered or not. What changes is which commit's tree this call reads: verified
// empirically (git 2.55.0), a replace ref from a real commit X to a different real commit Y makes
// `ls-tree X` return Y's tree, reporting a path present that is genuinely absent from X (or the
// reverse). `GIT_GRAFT_FILE` has no matching effect here, verified the same way with the replace ref
// removed: a graft only rewrites an existing commit's parent list, never what tree a given sha's
// `ls-tree` call reads.
const TREE_ENTRY_LINE = /^\d+\s+(\S+)\s+\S+\t/

const treeEntryKind = (
  repoRoot: string,
  sha: string,
  relPath: string
): 'blob' | 'other' | 'absent' => {
  const out = execFileSync('git', ['--no-replace-objects', 'ls-tree', sha, '--', relPath], {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  }).toString()
  const line = out.split('\n').find((entry) => entry.length > 0)
  if (line === undefined) return 'absent'
  const type = TREE_ENTRY_LINE.exec(line)?.[1]
  return type === 'blob' ? 'blob' : 'other'
}

// A red capture's mutation evidence is exactly as caller-typed as --sha itself until it is checked
// against the tree --sha names: a --mutation-file generated against an earlier state and carried
// forward onto a later, re-stamped --sha describes a tree the stamped sha never held, the same class
// as a dirty working tree taken for a non-red capture. Reversing the diff against what is on disk
// right now and comparing the result to what --sha's tree actually holds closes it without
// persisting anything new to the ledger — undo the mutation, and what results must equal
// `git show <sha>:<path>` for every file the diff touches, or the stamp does not describe what this
// capture actually observed. `unverified` names every section skipped because neither header side
// resolved under repoRoot — a genuinely external fixture is still accepted (nothing this repo's tree
// can confirm or deny about it), but the caller is told which sections went unchecked rather than the
// capture reading identically to one where every section was actually verified.
const redMutationMismatch = (
  repoRoot: string,
  sha: string,
  mutationDiff: string
): { error: string | undefined; unverified: string[] } => {
  // runRecord's own sha-existence check (above) already refused before this is ever called, so
  // --sha is guaranteed to resolve to a commit here.
  const unverified: string[] = []
  for (const { aPath, bPath, section } of splitDiffByFile(mutationDiff)) {
    const relPath =
      (bPath !== undefined ? resolveUnderRepoRoot(repoRoot, bPath, sha) : undefined) ??
      (aPath !== undefined ? resolveUnderRepoRoot(repoRoot, aPath, sha) : undefined)
    if (relPath === undefined) {
      unverified.push(bPath ?? aPath ?? '(unlabeled section)')
      continue
    }

    const undone = reverseApplyResult(repoRoot, relPath, section)
    if (!undone.applied)
      return {
        error:
          `${relPath} could not be reconciled against --mutation-file in either direction: git apply ` +
          `could not confirm what is on disk now matches the diff, so this red capture's mutation ` +
          `evidence cannot be confirmed against --sha ${sha}`,
        unverified,
      }

    // --sha is already confirmed to resolve (shaResolvesToCommit above). Presence or absence of
    // relPath at --sha's tree is established by treeEntryKind, an observed fact from `git ls-tree`,
    // not decoded from a `git show` exception — `git show` throws the identical exit-128 shape
    // whether the path is legitimately absent or the blob object it names is missing or corrupt, so
    // that exception can no longer stand in for "path absent". Any exception from treeEntryKind
    // itself refuses unconditionally: there is no legitimate throw case left once presence is
    // observed this way.
    let kind: 'blob' | 'other' | 'absent'
    try {
      kind = treeEntryKind(repoRoot, sha, relPath)
    } catch (err) {
      return {
        error:
          `git ls-tree ${sha} -- ${relPath} failed in ${repoRoot} (${describeExecError(err)}) — ` +
          'refusing rather than treating an unchecked path as absent',
        unverified,
      }
    }

    if (kind === 'other')
      return {
        error:
          `--sha ${sha}'s tree holds ${relPath} as something other than a file (a directory or ` +
          `submodule) — a red capture's mutation evidence cannot be compared against a non-blob entry`,
        unverified,
      }

    // `--no-replace-objects` for the same reason as treeEntryKind's own call above: kind was already
    // read from sha's real tree, but this is a separate exec, and left unlevered it would read a
    // replacement commit's blob content for that path instead of the real one.
    let stamped: string | null
    if (kind === 'absent') {
      stamped = null
    } else {
      try {
        stamped = execFileSync('git', ['--no-replace-objects', 'show', `${sha}:${relPath}`], {
          cwd: repoRoot,
          stdio: 'pipe',
          maxBuffer: GIT_MAX_BUFFER_BYTES,
        }).toString()
      } catch (err) {
        return {
          error:
            `git show ${sha}:${relPath} failed even though --sha ${sha}'s tree lists it as a blob ` +
            `(${describeExecError(err)}) — refusing rather than treating an unreadable blob as a ` +
            'verified match',
          unverified,
        }
      }
    }

    if (stamped === null && undone.content === null) continue

    if (stamped === null)
      return {
        error:
          `--sha ${sha} has no ${relPath} to compare against in ${repoRoot} — a red capture's ` +
          'mutation evidence must reverse-apply to exactly what --sha claims',
        unverified,
      }

    if (stamped !== undone.content)
      return {
        error:
          `${relPath}, with --mutation-file's mutation reversed, does not match --sha ${sha}'s tree: ` +
          'the working tree held something the stamped commit does not, so this --sha cannot certify ' +
          'what this red capture actually observed',
        unverified,
      }
  }
  return { error: undefined, unverified }
}

// A unified diff's own path header is not reliable evidence of where its file lives relative to
// repoRoot — this ledger holds headers relative to the repo root, to a subdirectory the diff was
// captured from, and, for a fixture mutation, to a path outside the repo entirely. A direct join
// against repoRoot is tried first; failing that, a tracked file matching the header — either exactly,
// for a header already repo-relative, or as a suffix, on the theory that a shortened header is always
// a suffix of the real one — is searched for. `existsSync` alone cannot resolve a delete-shaped
// mutation's header: the file the mutation removed is absent from the working tree by design, so
// resolution has to fall through to `git ls-files` and, if that also comes up empty, to `git ls-tree
// -r <ref>` — `git ls-files` still lists a deletion that is unstaged (present in the index, absent
// from the working tree), but a deletion staged with `git rm` is gone from the index too, leaving
// only the tree the file last existed in, and the reason the mutation could delete it at all — C2,
// including the staged case. The second lookup is a sequential fallback, tried
// only once the first finds nothing — never a union of both lists, which would make the suffix match
// ambiguous for every normally-tracked path (it appears in both) and turn `tracked.length === 1`
// false across the board.
//
// `ref` is caller-supplied, not a literal `HEAD`, because the two callers compare against different
// trees: `dirtyPathsOutsideMutation` checks `git status --porcelain`, which is HEAD-relative, so it
// passes `'HEAD'`; `redMutationMismatch` checks `git ls-tree <sha>`/`git show <sha>:<path>`, and a red
// capture is exempt from the head-sha check, so `--sha` and `HEAD` need not be equal — it passes
// `sha`. A HEAD-keyed fallback used from the `--sha`-framed caller could resolve a path present at
// `HEAD` and absent at `--sha`, certifying the capture against a tree the file was never in.
// `--no-replace-objects` matches the neighbouring `ls-tree`/`show`
// calls that already read a `--sha`-framed tree, for the same reason they carry it.
//
// A header resolving to neither is left unresolved rather than guessed at —
// the caller tries the diff section's other header side before treating the file as nothing to
// verify. A header carrying enough `../` segments to walk the joined path outside repoRoot is exactly
// the "outside the repo entirely" case above: a real file existing there is not evidence the header
// names a location this ledger should read from or write to, so a resolved path outside repoRoot
// falls through to the tracked-file lookup below instead of being accepted directly — it finds
// nothing there because a tracked path from `git ls-files` or `git ls-tree` never contains a `..`
// segment, not because this function itself special-cases the outside-repoRoot case.
//
// The return value is `relative(repoRoot, joined)`, not `headerPath` verbatim: `dirtyPathsOutsideMutation`
// compares it by string equality against paths `git status --porcelain` reports, which are always
// repo-root-relative and normalized — a header written as `./<path>` or with a `..`-round-trip back
// into repoRoot joins to the same real file but would not string-match git's form, so the file the
// mutation actually touches reads as dirty content OUTSIDE the mutation and the capture is wrongly
// refused. `redMutationMismatch` never does that string comparison — it uses the same
// normalized, repo-root-relative form to reverse-apply the diff against the right file on disk and to
// query `treeEntryKind`/`git show` at `--sha`, so a header written any of those equivalent ways still
// resolves to the one real path those calls need, not several inconsistent ones.
const resolveUnderRepoRoot = (
  repoRoot: string,
  headerPath: string,
  ref: string
): string | undefined => {
  const joined = join(repoRoot, headerPath)
  if ((joined === repoRoot || joined.startsWith(repoRoot + sep)) && existsSync(joined))
    return relative(repoRoot, joined)
  const matchesHeader = (p: string): boolean =>
    p.length > 0 && (p === headerPath || p.endsWith(`/${headerPath}`))
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  })
    .toString()
    .split('\0')
    .filter(matchesHeader)
  if (tracked.length === 1) return tracked[0]
  if (tracked.length > 1) return undefined
  const atRef = execFileSync(
    'git',
    ['--no-replace-objects', 'ls-tree', '-r', ref, '--name-only', '-z'],
    {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    }
  )
    .toString()
    .split('\0')
    .filter(matchesHeader)
  return atRef.length === 1 ? atRef[0] : undefined
}

// A multi-file `diff --git` diff must be checked one file at a time — reverse-applying the whole
// text against one file would try to patch hunks belonging to other files onto it. Each file's
// section is sliced directly out of the original text between its `diff --git` header and the next
// one (or the text's end) — never reconstructed by splitting into lines and joining a subset back
// together, which drops the newline that separated a non-final section from the next file's header,
// corrupting every section but the last in a multi-file diff. `DIFF_GIT_HEADER`
// only finds where a section starts — it never reads a path out of the `diff --git` line itself. A
// real `git diff` always writes that line as `a/<old> b/<new>`, but this ledger also holds
// hand-composed live-to-known-good diffs with the two sides written in the opposite order
// (`diff --git b/<path> a/<path>`, run.test.ts's "record verifies a red capture whose
// --mutation-file spans two files, every diff --git line with a/b reversed — class-2 sweep finding")
// — a path parsed from that line by assuming `a/`-then-`b/` order would silently mis-locate or drop every file in a
// multi-file diff written that way. Each section's own path comes from `headerPathsFromSection`, the
// same `---`/`+++` parse the single-section case below uses, which does not assume an order.
const DIFF_GIT_HEADER = /^diff --git .+$/gm

// A diff with no `diff --git` line is always exactly one file (isMutationDiff already requires a
// "--- "/"+++ " pair in that case), so its paths come from that pair directly, tolerating either
// `a/`/`b/` prefix on either side and the tab-and-timestamp suffix plain `diff -u` output appends
// after each header path. Both header sides are returned, not collapsed to one —
// a real mutation diff in this ledger has its repo-side path on either side of a `-`/`+` pair
// depending on which way the diff was captured, so resolveUnderRepoRoot must be given the chance to
// resolve each side independently rather than only whichever this function preferred.
const headerPathsFromSection = (
  section: string
): { aPath: string | undefined; bPath: string | undefined } => {
  const plusPath = /^\+\+\+ (?:a\/|b\/)?([^\t\n]+)/m.exec(section)?.[1]
  const minusPath = /^--- (?:a\/|b\/)?([^\t\n]+)/m.exec(section)?.[1]
  return {
    aPath: minusPath !== undefined && minusPath !== '/dev/null' ? minusPath : undefined,
    bPath: plusPath !== undefined && plusPath !== '/dev/null' ? plusPath : undefined,
  }
}

const splitDiffByFile = (
  diffText: string
): { aPath: string | undefined; bPath: string | undefined; section: string }[] => {
  const headers = [...diffText.matchAll(DIFF_GIT_HEADER)]
  if (headers.length > 0) {
    return headers.map((header, i) => {
      const start = header.index ?? 0
      const end =
        i + 1 < headers.length ? (headers[i + 1]!.index ?? diffText.length) : diffText.length
      const section = diffText.slice(start, end)
      return { ...headerPathsFromSection(section), section }
    })
  }

  const { aPath, bPath } = headerPathsFromSection(diffText)
  return aPath === undefined && bPath === undefined ? [] : [{ aPath, bPath, section: diffText }]
}

// A hunk whose header claims an old/new line span its body does not actually contain is not
// evidence of anything — a real `git diff` cannot disagree with its own hunk counts, so a mismatch
// here means the diff was edited by hand after being generated (door 30: four ledger captures each
// short by one or two context lines with the header's counts left unchanged — not truncated
// mid-write, composed). Checked from the diff text alone, never against the target file or
// through git, so it cannot be confused with a hunk's stated *position* having drifted since capture
// (what reverseApplyResult's `--recount` below exists to tolerate): `git apply --check` reports
// drifted position and a miscounted body under the identical "corrupt patch" text when the target
// file is short enough, so shelling out to it cannot tell the two apart — parsing the hunk's own
// bookkeeping can. Every non-empty line inside a hunk starts with its diff marker: `-`/`+` count
// toward the old or new side respectively, a leading space (a real, unstripped context line, even a
// blank source line) counts toward both, and anything else (a "\ No newline" marker, a stray blank
// line from splitting on "\n") counts toward neither — under-counting on a corrupted line is the safe
// direction here, since it can only make the defect easier to detect, never harder.
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

const truncatedHunkReason = (label: string, diffSection: string): string | undefined => {
  const lines = diffSection.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const header = HUNK_HEADER.exec(lines[i])
    if (header === null) continue
    const oldCount = header[1] !== undefined ? Number(header[1]) : 1
    const newCount = header[2] !== undefined ? Number(header[2]) : 1
    let oldSeen = 0
    let newSeen = 0
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break
      if (line.startsWith('-')) oldSeen++
      else if (line.startsWith('+')) newSeen++
      else if (line.startsWith(' ')) {
        oldSeen++
        newSeen++
      }
    }
    if (oldSeen < oldCount || newSeen < newCount)
      return (
        `${label}'s --mutation-file is corrupt: a hunk header claims ${oldCount} old-side and ` +
        `${newCount} new-side line(s), but its body accounts for only ${oldSeen}/${newSeen} — a real ` +
        `git diff cannot disagree with its own hunk counts, so this is not the mismatch check: ` +
        `regenerate --mutation-file rather than looking for a re-stamp`
      )
  }
  return undefined
}

// Runs for every red capture, `no-check` included — a hand-composed diff is exactly as invalid as a
// non-diff, and belongs beside `isMutationDiff`'s shape check in `runRecord`'s own validation, not
// gated behind a `repoRootCheck.kind === 'check'` tree comparison that a caller can opt out of. No
// resolved repo-relative path exists yet at this point, so each section is labeled with whichever
// header side its diff names (`bPath`, falling back to `aPath`) rather than a verified location.
const truncatedMutationReason = (mutationDiff: string): string | undefined => {
  for (const { aPath, bPath, section } of splitDiffByFile(mutationDiff)) {
    const label = bPath ?? aPath ?? '--mutation-file'
    const reason = truncatedHunkReason(label, section)
    if (reason !== undefined) return reason
  }
  return undefined
}

// Same placement as truncatedMutationReason and for the same reason — runs for every red capture,
// `no-check` included, ahead of dirtyPathsOutsideMutation/redMutationMismatch (both gated behind
// `repoRootCheck.kind === 'check'`, and both build their own file set from this same
// splitDiffByFile): a diff whose header sides all fail to name a path (blank headers, `/dev/null` on
// both sides, or any mix) resolves to zero sections, so a caller checking a zero-section diff for
// dirty-tree content outside the mutation would find every path in the tree "outside" a mutation
// that in fact names no files at all, rather than being told what is actually wrong.
// The message names the observed condition — no header side resolved to a path — rather than one
// specific cause: a bare `--- `/`+++ ` header pair with empty paths reaches this exactly as a
// `/dev/null`-on-both-sides header does, and neither contains the string the other might suggest
// searching for.
const noResolvableSectionReason = (mutationDiff: string): string | undefined =>
  splitDiffByFile(mutationDiff).length === 0
    ? 'a red capture requires --mutation-file to have at least one header side that resolves to a ' +
      'path: no header side in this diff named one, so there is nothing for this capture to certify'
    : undefined

// The mutation diff's own recorded direction is not trusted — this ledger holds it both ways (a
// baseline-to-mutation diff, and at least once a live-to-known-good one), so which application
// direction "undoes" the mutation depends on which side the current file already matches, not on
// which side the diff calls `-` or `+`. `git apply` itself is the detector: it refuses to apply a
// hunk whose context does not match what is on disk, so trying both directions against a scratch
// copy and keeping whichever one succeeds is exact, not a heuristic — and it never touches the real
// file at repoRoot. Neither direction succeeding means the diff describes a tree that is not what is
// on disk now, in either direction; reported to the caller as unable to confirm, not as a silent
// pass. The diff's own header path is rewritten to `relPath` first — git apply resolves a hunk's
// target from its header, and the header's own path is exactly what resolveUnderRepoRoot already
// established cannot be trusted. `--recount` is passed for the same reason: a hunk's stated line
// position is stale the moment the file has moved since the diff was captured, and git apply treats
// a stale position on a short file as a corrupt patch rather than searching for the context.
// A file's absence is a legitimate outcome on either side of this reversal, not just a starting
// state: a delete-shaped mutation's current tree has nothing at relPath to seed the scratch copy
// with, and a create-shaped mutation's reversal is expected to remove the scratch copy `git apply`
// just wrote — so `content: null` distinguishes "reversed cleanly, to nothing" from `applied: false`,
// which means neither direction could be applied at all (C2).
const reverseApplyResult = (
  repoRoot: string,
  relPath: string,
  diffSection: string
): { applied: true; content: string | null } | { applied: false } => {
  const originalPath = join(repoRoot, relPath)
  const currentContent = existsSync(originalPath) ? readFileSync(originalPath, 'utf-8') : null
  const normalized = normalizeDiffHeaderPaths(diffSection, relPath)

  const tmp = mkdtempSync(join(tmpdir(), 'proof-ledger-reverse-apply-'))
  try {
    const scratchPath = join(tmp, relPath)
    mkdirSync(dirname(scratchPath), { recursive: true })
    const diffFile = join(tmp, 'mutation.diff')
    writeFileSync(diffFile, normalized)
    for (const args of [['apply', '-R'], ['apply']]) {
      if (currentContent === null) {
        if (existsSync(scratchPath)) rmSync(scratchPath)
      } else {
        writeFileSync(scratchPath, currentContent)
      }
      try {
        execFileSync('git', [...args, '--recount', '--unsafe-paths', diffFile], {
          cwd: tmp,
          stdio: 'pipe',
          maxBuffer: GIT_MAX_BUFFER_BYTES,
        })
        return {
          applied: true,
          content: existsSync(scratchPath) ? readFileSync(scratchPath, 'utf-8') : null,
        }
      } catch {
        continue
      }
    }
    return { applied: false }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// git apply resolves a hunk's target from its own header, and the header's own path is exactly what
// resolveUnderRepoRoot already established cannot be trusted — rewritten to relPath before shelling
// out to git.
const normalizeDiffHeaderPaths = (diffSection: string, relPath: string): string =>
  diffSection
    .split('\n')
    .map((line) => {
      if (/^diff --git /.test(line)) return `diff --git a/${relPath} b/${relPath}`
      if (/^--- /.test(line)) return line.startsWith('--- /dev/null') ? line : `--- a/${relPath}`
      if (/^\+\+\+ /.test(line)) return line.startsWith('+++ /dev/null') ? line : `+++ b/${relPath}`
      return line
    })
    .join('\n')

// P2: a capture's output sidecar (and, for `red`, its mutation sidecar) is re-read from disk and
// re-hashed against the digest the ledger recorded, not trusted because the path exists or because
// the capture passed validation when it was written — the ledger is append-only and its sidecars
// live outside it, so a file deleted or silently swapped after recording must be caught here, at
// read time, not assumed still to hold what its own record claims.
const captureInvalidReason = (c: ProofCaptureEvent): string | undefined => {
  const output = readSidecar(c.outputPath, c.outputSha256, 'output')
  if (!output.ok) return output.reason

  // A `sweep` command's exit status reflects the underlying tool's own match/no-match convention, not
  // command success — grep and rg both exit 1, exclusively, for the canonical "defect class is now
  // absent" zero-match result, the exact outcome a re-swept defect class is recorded to prove; 2 or
  // higher means the tool itself failed to run (bad path, malformed pattern, binary not found), the
  // same signal a non-sweep kind's non-zero exit carries. `git grep` also exits 1 for zero-match, but
  // conflates it with several of its own error conditions — a nonexistent path among them — so this
  // check cannot tell an exit-1 `git grep` bad-path sweep from a genuine zero-match one; that gap is
  // real and this function does not close it, only documents it.
  if (c.capture === 'sweep')
    return c.exitStatus === 0 || c.exitStatus === 1
      ? undefined
      : 'sweep exit status is neither 0 (match found) nor 1 (no-match convention for grep/rg — not sound for `git grep`, which also uses 1 for some of its own errors) — 2 or higher means the tool itself failed to run, not that the defect class is absent'

  if (c.capture !== 'red') return c.exitStatus !== 0 ? 'exit status is non-zero' : undefined

  // A `red` capture is EXPECTED to be non-zero — that's what makes it a RED baseline, so it is never
  // invalid on exit status alone. A `red` capture with exitStatus === 0 IS invalid: a mutation that
  // does not turn the test red proves nothing.
  if (c.exitStatus === 0)
    return 'a red capture requires a non-zero exit status: exitStatus 0 means the mutation never turned the test red'
  if (c.mutationPath === undefined || c.mutationSha256 === undefined)
    return 'red capture is missing its mutation sidecar'
  const mutation = readSidecar(c.mutationPath, c.mutationSha256, 'mutation')
  if (!mutation.ok) return mutation.reason
  const mutationDiff = mutation.content
  if (!isMutationDiff(mutationDiff)) return 'mutation sidecar is not a recognisable diff'
  const corruption = truncatedMutationReason(mutationDiff)
  if (corruption !== undefined) return corruption
  const noSection = noResolvableSectionReason(mutationDiff)
  if (noSection !== undefined) return noSection
  return undefined
}
