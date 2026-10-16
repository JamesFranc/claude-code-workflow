import { revParseQuiet } from '../review-ledger/stance.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { readSidecar } from '../workflow-store/captured-output.ts'
import {
  STORE_UNREADABLE_EXIT,
  StoreUnreadableError,
  readClassified,
} from '../workflow-store/store.ts'
import {
  appendGateRun,
  readGateLedger,
  runsFor,
  writeGateOutput,
  type RerunCondition,
} from './ledger.ts'
import {
  manifestPath,
  parseManifest,
  writeManifest,
  type DeclaredGate,
  type GateRole,
} from './manifest.ts'

// The run layer. Every command prints JSON on stdout — the ledger is read by agents, so
// machine-readable output is the contract, exactly as in review-ledger/run.ts. Exit codes:
//
//   0 — success. `check` with every declared gate's latest run green, at the sha or, when the sha has no run of
//       its own, at a sha naming its tree. `declare`
//       with the manifest validated and written to the ticket's store.
//   3 — `check`: at least one declared gate is missing (no run at this sha, and none at a sha naming its tree), failing
//       (latest record's exitStatus !== 0), or invalid (latest record's output sidecar is gone or no
//       longer matches its recorded outputSha256).
//   5 — `record`: --gate names a gate the ticket's declared manifest does not declare. The
//       composite-command guard: `pnpm test` is not a declared name, so recording it fails rather
//       than discharging its conjuncts.
//   6 — `record`: a re-run (a run for this gate already exists at the sha or at a sha whose recorded tree is
//       identical, or at any sha when the tree of the sha being recorded cannot be resolved) or a non-owning role,
//       with --condition or --reason absent.
//   8 — `record`/`check`: no manifest on disk for this ticket and no --manifest override given
//       (error names the TICKET), or a given --manifest override that does not exist (error names
//       the OVERRIDE PATH, not the ticket — the two are told apart so a mistyped --manifest against
//       a ticket that has a good declared gate set cannot be misread as that ticket having none),
//       or the resolved manifest does not parse or parses but declares zero gates. `declare`: the
//       --file does not exist, does not parse, or declares zero gates. Absent only — a manifest
//       that exists and cannot be read is 26, never this.
//   9 — an unexpected error (e.g. a disk I/O failure WRITING the ledger or the gate output,
//       `record`'s --output-file naming a file that can't be read, or --output-file/--output being
//       given together or not at all) that is none of the expected outcomes above. A failure to
//       READ the ledger or the manifest is 26, never this. The error's
//       message is on stdout under "error", like every other exit here — a caller reading this
//       file for "what can this command exit with" never has to also catch a raw stack trace to
//       find out why a run failed.
//  26 — the ledger or the manifest exists and could not be read (STORE_UNREADABLE_EXIT, shared with
//       proof-ledger and review-ledger). Either file raises it and runGuarded maps both here, so
//       this code does not say WHICH was unreadable — the error message names the path. Distinct
//       from 8 because the two prescribe opposite responses: 8 means declare the gates, 26 means do
//       NOT declare them and repair the file instead. Collapsing them let `declare` overwrite a
//       declared gate set it had never read.
//
// 252 is Stricli's own parse-failure code, not set by this module — documented here only so a
// caller reading this file for "what can this command exit with" finds the answer in one place.

// Every exported run* function's entire body runs inside this: the ledger is read by agents, so an
// unexpected throw (a disk I/O failure, say) must still land as JSON+exit 9, not a raw stack trace,
// the same guarantee loadDeclaredGates already gives the one throw site it wraps. Exported so the
// CLI command layer (commands/gate-ledger.ts) can wrap its own pre-dispatch work — reading
// --output-file, validating --output-file/--output are exactly one — in the same guarantee: that
// work runs before any run* function is called, so it sits outside every run* function's own guard.
export const runGuarded = (fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    // A store that exists and cannot be read gets its own code. Under the generic 9 it is
    // indistinguishable from any other unexpected throw, so a caller cannot tell "this ledger
    // reported nothing because it is empty" from "this ledger could not be read at all".
    if (err instanceof StoreUnreadableError) {
      writeJson({ error: err.message, code: err.code })
      setRequestedExitCode(STORE_UNREADABLE_EXIT)
      return
    }
    writeJson({ error: err instanceof Error ? err.message : String(err) })
    setRequestedExitCode(9)
  }
}

export const runRecord = (
  ticket: string,
  gate: string,
  sha: string,
  exitStatus: number,
  role: GateRole,
  output: string,
  condition?: RerunCondition,
  reason?: string,
  manifestPathArg?: string,
  repoRoot: string = process.cwd()
): void =>
  runGuarded(() => {
    const resolvedManifestPath = manifestPathArg ?? manifestPath(ticket)
    const loaded = loadDeclaredGates(resolvedManifestPath)
    if (!loaded.ok && loaded.reason === 'absent') {
      writeJson(
        manifestPathArg === undefined
          ? { error: 'no gates declared for this ticket' }
          : { error: `--manifest ${manifestPathArg} does not exist` }
      )
      setRequestedExitCode(8)
      return
    }
    if (!loaded.ok) {
      writeJson({
        error: `${resolvedManifestPath} does not declare a usable "gates" array`,
        ...(loaded.reason === 'malformed' ? { detail: loaded.detail } : {}),
      })
      setRequestedExitCode(8)
      return
    }
    const declaredGates = loaded.gates
    const declared = declaredGates.find((g) => g.name === gate)
    if (declared === undefined) {
      writeJson({
        error: `gate ${gate} is not declared in ${resolvedManifestPath}`,
        declared: declaredGates.map((g) => g.name),
      })
      setRequestedExitCode(5)
      return
    }

    const tree = revParseQuiet(repoRoot, `${sha}^{tree}`)
    const ledger = readGateLedger(ticket)
    const priorRuns =
      tree === null ? ledger.runs.filter((r) => r.gate === gate) : runsFor(ledger, gate, sha, tree)
    const needsLicence = priorRuns.length > 0 || role !== declared.owner
    if (
      needsLicence &&
      (condition === undefined || reason === undefined || reason.trim().length === 0)
    ) {
      writeJson({
        error: 'a re-run, or a recording by a non-owning role, requires --condition and --reason',
        gate,
        sha,
        tree,
        priorRuns: priorRuns.length,
        owner: declared.owner,
        role,
      })
      setRequestedExitCode(6)
      return
    }

    const { outputPath, outputSha256, outputBytes, tail, truncated } = writeGateOutput(
      ticket,
      gate,
      sha,
      output
    )
    appendGateRun(ticket, {
      kind: 'gate-run',
      at: new Date().toISOString(),
      gate,
      sha,
      ...(tree !== null ? { tree } : {}),
      exitStatus,
      role,
      outputPath,
      outputSha256,
      outputBytes,
      tail,
      ...(truncated ? { truncated: true } : {}),
      ...(condition !== undefined ? { condition } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
    writeJson({
      ticket,
      gate,
      sha,
      tree,
      exitStatus,
      role,
      outputPath,
      outputSha256,
      outputBytes,
      rerun: needsLicence,
    })
  })

export const runShow = (ticket: string, sha?: string, gate?: string): void =>
  runGuarded(() => {
    const ledger = readGateLedger(ticket)
    const runs = ledger.runs.filter(
      (r) => (sha === undefined || r.sha === sha) && (gate === undefined || r.gate === gate)
    )
    writeJson({ ticket, runs, skippedLines: ledger.skippedLines })
  })

interface GateCheckRow extends DeclaredGate {
  state: 'missing' | 'failing' | 'invalid' | 'ok'
  reusedFrom?: string
  condition?: RerunCondition
  reason?: string
  invalidReason?: string
}

export const runCheck = (
  ticket: string,
  sha: string,
  manifestPathArg?: string,
  repoRoot: string = process.cwd()
): void =>
  runGuarded(() => {
    const resolvedManifestPath = manifestPathArg ?? manifestPath(ticket)
    const loaded = loadDeclaredGates(resolvedManifestPath)
    if (!loaded.ok && loaded.reason === 'absent') {
      writeJson(
        manifestPathArg === undefined
          ? { error: 'no gates declared for this ticket' }
          : { error: `--manifest ${manifestPathArg} does not exist` }
      )
      setRequestedExitCode(8)
      return
    }
    if (!loaded.ok) {
      writeJson({
        error: `${resolvedManifestPath} does not declare a usable "gates" array`,
        ...(loaded.reason === 'malformed' ? { detail: loaded.detail } : {}),
      })
      setRequestedExitCode(8)
      return
    }
    const declaredGates = loaded.gates
    const ledger = readGateLedger(ticket)
    const tree = revParseQuiet(repoRoot, `${sha}^{tree}`)

    const rows: GateCheckRow[] = declaredGates.map((declared) => {
      const ownRuns = runsFor(ledger, declared.name, sha)
      const runs = ownRuns.length > 0 ? ownRuns : runsFor(ledger, declared.name, sha, tree)
      if (runs.length === 0) {
        return { ...declared, state: 'missing' }
      }

      const latest = runs[runs.length - 1]!
      const recorded = {
        ...declared,
        ...(latest.sha !== sha ? { reusedFrom: latest.sha } : {}),
        ...(latest.condition !== undefined
          ? { condition: latest.condition, reason: latest.reason }
          : {}),
      }
      if (latest.exitStatus !== 0) {
        return { ...recorded, state: 'failing' }
      }

      const sidecar = readSidecar(latest.outputPath, latest.outputSha256, 'output')
      if (!sidecar.ok) {
        return { ...recorded, state: 'invalid', invalidReason: sidecar.reason }
      }
      return { ...recorded, state: 'ok' }
    })

    const missing = rows.filter((r) => r.state === 'missing').map((r) => r.name)
    const failing = rows.filter((r) => r.state === 'failing').map((r) => r.name)
    const invalid = rows.filter((r) => r.state === 'invalid').map((r) => r.name)

    writeJson({
      ticket,
      sha,
      tree,
      manifest: resolvedManifestPath,
      gates: rows,
      missing,
      failing,
      invalid,
      skippedLines: ledger.skippedLines,
    })
    if (missing.length > 0 || failing.length > 0 || invalid.length > 0) setRequestedExitCode(3)
  })

// Declare a ticket's gates from a local JSON file into the ticket's store — the only way the
// declared-gate list is written. `filePath` is validated with the same shape check `record`/
// `check` apply when they load it back, so a manifest that would fail coverage later is rejected
// here, at the point of authoring, instead.
export const runDeclare = (ticket: string, filePath: string): void =>
  runGuarded(() => {
    const loaded = loadDeclaredGates(filePath)
    if (!loaded.ok && loaded.reason === 'absent') {
      writeJson({ error: `${filePath} does not exist` })
      setRequestedExitCode(8)
      return
    }
    if (!loaded.ok) {
      writeJson({
        error: `${filePath} does not declare a usable "gates" array`,
        ...(loaded.reason === 'malformed' ? { detail: loaded.detail } : {}),
      })
      setRequestedExitCode(8)
      return
    }
    // Declaring reads the --file, never the destination, so without this it would overwrite a
    // manifest it had never read. That is the destructive half of the exit-8 collapse: "no gates
    // declared" told an operator to declare, and declaring silently replaced a real gate set with
    // whatever the --file held. Refusing here is why 26 and 8 have to be different codes.
    const destination = manifestPath(ticket)
    const existing = readClassified(destination)
    if (existing.kind === 'unreadable') throw new StoreUnreadableError(destination, existing.code)
    writeManifest(ticket, JSON.stringify({ gates: loaded.gates }))
    writeJson({
      ticket,
      manifest: manifestPath(ticket),
      gates: loaded.gates.map((g) => g.name),
    })
  })

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

type LoadDeclaredGatesResult =
  | { ok: true; gates: DeclaredGate[] }
  | { ok: false; reason: 'malformed'; detail: string }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'absent' }

// A manifest that throws (malformed JSON, or JSON that fails parseManifest's own shape checks) and
// a manifest that parses but declares zero gates are the same hazard as an absent one: each would
// let `check` report an empty coverage set as fully covered, so both callers send them through the
// same exit-8 path an absent manifest already takes. An UNREADABLE manifest is not in that set and
// raises instead — it is the one state where the caller must not proceed as if nothing were
// declared. The reasons stay distinguishable here, though —
// parseManifest's own caught message is worth surfacing to whoever is debugging a malformed
// manifest, and a message like "expected an object with a \"gates\" array" would be actively wrong
// reported against a manifest that parsed fine but declared zero gates.
//
// Shared by record/check (loading the ticket's declared manifest, or a --manifest override) and
// declare (loading the local --file about to be written into the ticket's store) — one shape check
// for every path a manifest can enter or leave the store through.
const loadDeclaredGates = (manifestPathToLoad: string): LoadDeclaredGatesResult => {
  const read = readClassified(manifestPathToLoad)
  if (read.kind === 'unreadable') throw new StoreUnreadableError(manifestPathToLoad, read.code)
  if (read.kind === 'absent') return { ok: false, reason: 'absent' }
  let declared: DeclaredGate[]
  try {
    declared = parseManifest(manifestPathToLoad, read.content)
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  return declared.length === 0 ? { ok: false, reason: 'empty' } : { ok: true, gates: declared }
}
