import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { atomicWrite } from '../workflow-store/store.ts'

export type EnsureAction = 'already-trusted' | 'trusted' | 'refused' | 'failed'

type EnsureOutput = {
  repoRoot: string
  launchDir: string
  action: EnsureAction
  reason?: string
}

export type ConfigSnapshot = { raw: string; parsed: Record<string, unknown> }

export type ConfigIO = {
  read: (path: string) => ConfigSnapshot
  write: (path: string, content: string) => void
}

const TRUST_KEY = 'hasTrustDialogAccepted'

const REFUSAL_REASON =
  'repo root is outside the directory this command was invoked from — if you `cd`ed before ' +
  'running this, re-run from the original launch directory instead; if the repo genuinely ' +
  'belongs outside the launch dir, ask the user before trusting it'

const UNRESOLVABLE_REASON =
  'repo path does not exist on disk — refusing rather than trusting an unverified location'

const STDERR_MARKER: Record<EnsureAction, string> = {
  trusted: '✓',
  'already-trusted': '·',
  refused: '✗',
  failed: '‼',
}

const MAX_CONCURRENCY_ATTEMPTS = 3

// Claude Code 2.1.232 stops its trust ancestor-walk at the enclosing git repo root, so a trusted
// directory ABOVE a repo no longer covers that repo or its worktrees. A teammate is a fresh `claude`
// process whose cwd is the worktree path passed at spawn time — or the team lead's own cwd when none
// is passed — so an unregistered repo root can stop it on the trust dialog in a pane nobody is
// watching. Registering the key ahead of the spawn is what prevents that.
export const runWorkspaceTrustEnsure = (repoPath: string | undefined): void => {
  const requestedRepo = repoPath ?? process.cwd()
  const launchDir = canonicalPath(process.cwd())
  const repoRoot = trustKeyFor(requestedRepo)

  if (launchDir === null || repoRoot === null) {
    emit({
      repoRoot: repoRoot ?? requestedRepo,
      launchDir: launchDir ?? process.cwd(),
      action: 'refused',
      reason: UNRESOLVABLE_REASON,
    })
    setRequestedExitCode(1)
    return
  }

  if (!isWithin(launchDir, repoRoot)) {
    emit({ repoRoot, launchDir, action: 'refused', reason: REFUSAL_REASON })
    setRequestedExitCode(1)
    return
  }

  try {
    emit({ repoRoot, launchDir, action: grantTrust(repoRoot) })
    setRequestedExitCode(0)
  } catch (error) {
    emit({ repoRoot, launchDir, action: 'failed', reason: errorMessage(error) })
    setRequestedExitCode(2)
  }
}

// Mirrors Claude Code's own key derivation: the canonical git root when the path is inside a repo,
// otherwise the resolved path itself. `--git-common-dir` is what maps a linked worktree to its MAIN
// repo root — confirmed against the real Claude Code 2.1.232 binary from both a plain repo root and
// from inside a linked worktree: both produce the same key Claude Code itself names in
// `set projects["<key>"].hasTrustDialogAccepted: true`.
const trustKeyFor = (path: string): string | null => {
  const commonDir = gitCommonDir(path)
  if (commonDir !== null && basename(commonDir) === '.git') return canonicalPath(dirname(commonDir))
  return canonicalPath(path)
}

const gitCommonDir = (path: string): string | null => {
  try {
    const stdout = execFileSync(
      'git',
      ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return stdout.trim()
  } catch {
    return null
  }
}

// realpath so a symlinked path and its target produce one key. Returns null — never a lexical
// stand-in — when the path can't be resolved on disk: a lexical fallback here would let a path
// through the launch-dir guard without ever confirming what it actually points at.
const canonicalPath = (path: string): string | null => {
  try {
    return realpathSync(resolve(path))
  } catch {
    return null
  }
}

const isWithin = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

// Exported so a test can inject a write that never lands, or a read whose bytes change out from
// under us, without faking the filesystem — the production call site above always uses the real IO.
export const grantTrust = (repoRoot: string, io: ConfigIO = realIO): EnsureAction => {
  const path = globalConfigPath()

  const prepared = prepareWrite(io, path, repoRoot, 1)
  if (prepared.kind === 'already-trusted') return 'already-trusted'

  writeTrustEntry(io, path, prepared.config, prepared.projects, repoRoot, prepared.project)
  if (trustEntrySet(io, path, repoRoot)) return 'trusted'

  // Two accepted losses remain (user decision):
  //
  // - Our own key can still be lost if a write lands after this process has already exited —
  //   self-correcting on the next run; no mechanism inside this process can cover that window.
  // - A write landing inside our read→write window used to be silently overwritten by our stale
  //   snapshot, undetectable here because this check only confirms OUR OWN key survived, never
  //   anyone else's data. `prepareWrite`'s concurrency check narrows that window to the small gap
  //   between its final comparison and the actual write/rename below — it does not close it. One
  //   retry of the whole prepare-then-write cycle, same as before.
  const retryPrepared = prepareWrite(io, path, repoRoot, 1)
  if (retryPrepared.kind === 'already-trusted') return 'already-trusted'

  writeTrustEntry(
    io,
    path,
    retryPrepared.config,
    retryPrepared.projects,
    repoRoot,
    retryPrepared.project
  )
  if (trustEntrySet(io, path, repoRoot)) return 'trusted'

  throw new Error(
    `wrote ${TRUST_KEY} for ${repoRoot} to ${path} but the write did not survive a retry`
  )
}

type PreparedWrite =
  | { kind: 'already-trusted' }
  | {
      kind: 'ready'
      config: Record<string, unknown>
      projects: Record<string, unknown>
      project: Record<string, unknown>
    }

// Reads the config, and — if a write is actually needed — re-reads immediately before returning to
// confirm nothing changed in between. Claude Code rewrites this file itself; a write landing in that
// window would otherwise be silently discarded by a write built from our now-stale snapshot. On a
// mismatch, retry from a fresh read (bounded) so the write this produces merges onto whatever is on
// disk now rather than clobbering it.
const prepareWrite = (
  io: ConfigIO,
  path: string,
  repoRoot: string,
  attempt: number
): PreparedWrite => {
  const { raw, parsed } = io.read(path)
  const projects = asObjectOrAbsent(parsed.projects, `${path}: projects`)
  const project = asObjectOrAbsent(projects[repoRoot], `${path}: projects["${repoRoot}"]`)

  if (project[TRUST_KEY] === true) return { kind: 'already-trusted' }

  const check = io.read(path)
  if (check.raw === raw) return { kind: 'ready', config: parsed, projects, project }

  if (attempt >= MAX_CONCURRENCY_ATTEMPTS) {
    throw new Error(
      `${path} changed concurrently on every read for ${MAX_CONCURRENCY_ATTEMPTS} consecutive tries; refusing to write a stale snapshot over it`
    )
  }
  return prepareWrite(io, path, repoRoot, attempt + 1)
}

const writeTrustEntry = (
  io: ConfigIO,
  path: string,
  config: Record<string, unknown>,
  projects: Record<string, unknown>,
  repoRoot: string,
  project: Record<string, unknown>
): void => {
  const updated = {
    ...config,
    projects: { ...projects, [repoRoot]: { ...project, [TRUST_KEY]: true } },
  }
  io.write(path, JSON.stringify(updated, null, 2) + '\n')
}

// Verification-only: this never feeds a write, so a malformed shape here can stay lenient (asRecord,
// not asObjectOrAbsent) — it simply reads as "not verified yet" and falls through to the retry,
// whose own read (above) carries the strict guard and will throw there if the config is genuinely
// malformed rather than mid-write.
const trustEntrySet = (io: ConfigIO, path: string, repoRoot: string): boolean => {
  const projects = asRecord(io.read(path).parsed.projects)
  return asRecord(projects[repoRoot])[TRUST_KEY] === true
}

// Claude Code resolves its global config the same way — join(CLAUDE_CONFIG_DIR || homedir(),
// '.claude.json') — so honouring the env var keeps the key we write and the key it reads on one
// file. It doubles as the tests' seam onto a temp config.
const globalConfigPath = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json')

// Malformed JSON or a non-object config throws rather than defaulting to `{}` — unlike this
// codebase's other guarded-parse readers (dashboard/registry.ts, dashboard/state.ts,
// workflow-state/state.ts), which fail open because they only ever read. Failing open here would
// make the write below clobber whatever was actually in the file.
//
// `readFile` is a seam only — production always uses the real `readFileSync` (the default) — so a
// test can simulate a torn read (fails once, succeeds on retry) without racing a real concurrent
// writer. A single JSON.parse failure is ambiguous between genuine corruption and a bare read
// catching a concurrent, non-atomic rewrite of this file mid-write; one re-read resolves that in
// practice, the same reasoning behind retrying a write twice in `grantTrust`. A parse that succeeds
// but yields the wrong shape is not that kind of ambiguity — it throws immediately, not retried.
export const readConfig = (
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')
): ConfigSnapshot => {
  if (!existsSync(path)) return { raw: '', parsed: {} }

  const first = tryParseConfigFile(path, readFile)
  if (first.ok) return first.value

  const second = tryParseConfigFile(path, readFile)
  if (second.ok) return second.value

  throw new Error(`${path} is not valid JSON: ${second.error}`, { cause: second.cause })
}

type ParseAttempt =
  { ok: true; value: ConfigSnapshot } | { ok: false; error: string; cause: unknown }

const tryParseConfigFile = (path: string, readFile: (p: string) => string): ParseAttempt => {
  const raw = readFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: errorMessage(error), cause: error }
  }
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`)
  return { ok: true, value: { raw, parsed } }
}

// Declared after readConfig, not before: a top-level const initializer runs at module-load time in
// file order, so referencing readConfig here before its own declaration would throw (TDZ) on import.
const realIO: ConfigIO = { read: readConfig, write: atomicWrite }

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// `projects` and a per-project entry are read here only to be spread into a write below. `undefined`
// (the key was never set) is the normal cold-start shape and becomes `{}`; anything present but not
// an object throws instead of silently collapsing to `{}` — asRecord's coercion would otherwise let
// a malformed `projects` map, or a malformed per-project entry, be discarded and overwritten with a
// plausible-looking `trusted` result.
const asObjectOrAbsent = (value: unknown, context: string): Record<string, unknown> => {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${context} is not a JSON object`)
  return value
}

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const emit = (output: EnsureOutput): void => {
  console.error(formatStderrLine(output))
  process.stdout.write(JSON.stringify(output) + '\n')
}

const formatStderrLine = (output: EnsureOutput): string =>
  `${STDERR_MARKER[output.action]} workspace-trust: ${output.action} — ${output.reason ?? output.repoRoot}`
