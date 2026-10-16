import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  appendLine,
  atomicWrite,
  clearStore,
  ensureDurableDir,
  load,
  resolveDirKey,
  sessionGlobalScope,
  sessionScope,
  storePath,
  storeRoot,
  StoreUnreadableError,
  ticketScope,
  type StoreScope,
} from './store.ts'

// storeRoot() is homedir()-relative (os.homedir() reads $HOME on POSIX) — override HOME so these
// tests never touch the real ~/.claude/workflow-state store.
let homeDir: string
let origHome: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'workflow-store-test-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(homeDir, { recursive: true, force: true })
})

test('durability: storePath lands under storeRoot(), never a flat os.tmpdir() file', () => {
  const scope = sessionScope()
  const path = storePath(scope, 'x.json')
  assert.ok(path.startsWith(storeRoot()))
  // Legacy sinks wrote directly as `join(tmpdir(), name)` — a flat child of tmpdir() with no
  // nested `.claude/workflow-state` segment. The durable path is never that shape: it is always
  // nested under storeRoot(), which is homedir()-derived (never a bare call to os.tmpdir()). Note
  // storeRoot() legitimately resolves *underneath* tmpdir() in this test only because the
  // HOME-override scratch dir itself is created via mkdtemp(tmpdir()) for isolation (mirrors
  // pr-monitor/lock.test.ts) — that nesting is test scaffolding, not the flat legacy shape.
  assert.notEqual(path, join(tmpdir(), 'x.json'))
  assert.ok(path.includes(join('.claude', 'workflow-state')))
  assert.ok(storeRoot().startsWith(homeDir))
})

test('per-dir isolation: two session scopes differing only in dirKey produce different paths', () => {
  const a: StoreScope = { kind: 'session', dirKey: 'proj-a-000000000000', sessionPartition: 's1' }
  const b: StoreScope = { kind: 'session', dirKey: 'proj-b-000000000000', sessionPartition: 's1' }
  assert.notEqual(storePath(a, 'x.json'), storePath(b, 'x.json'))
})

test('per-session isolation: two session scopes differing only in sessionPartition produce different paths', () => {
  const a: StoreScope = { kind: 'session', dirKey: 'proj-000000000000', sessionPartition: 's1' }
  const b: StoreScope = { kind: 'session', dirKey: 'proj-000000000000', sessionPartition: 's2' }
  assert.notEqual(storePath(a, 'x.json'), storePath(b, 'x.json'))
})

test('dir-scope layout: {kind: "dir"} yields <root>/<dirKey>/<name> with no partition segment', () => {
  const scope: StoreScope = { kind: 'dir', dirKey: 'proj-000000000000' }
  assert.equal(storePath(scope, 'x.json'), join(storeRoot(), 'proj-000000000000', 'x.json'))
})

test('resolveDirKey: format + stability across two calls in one cwd', () => {
  const key1 = resolveDirKey()
  const key2 = resolveDirKey()
  assert.match(key1, /^.+-[0-9a-f]{12}$/)
  assert.equal(key1, key2)
})

test('resolveDirKey: pinned at first call — a later chdir neither changes nor re-derives it', () => {
  const pinned = resolveDirKey()
  const elsewhere = mkdtempSync(join(tmpdir(), 'workflow-store-chdir-'))
  const origCwd = process.cwd()
  try {
    process.chdir(elsewhere)
    assert.equal(
      resolveDirKey(),
      pinned,
      'pinned key is stable across a chdir (not re-derived from cwd)'
    )
  } finally {
    process.chdir(origCwd)
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('cold start: no durable, no legacy → null', () => {
  const scope = sessionScope()
  assert.equal(load(scope, 'x.json'), null)
})

test('clearStore: write then clear leaves load returning null', () => {
  const scope = sessionScope()
  atomicWrite(storePath(scope, 'x.json'), 'C')
  clearStore(scope, 'x.json')
  assert.equal(load(scope, 'x.json'), null)
})

test('session-global scope: path lands under sessions/<partition>, not a dirKey dir', () => {
  const path = storePath(sessionGlobalScope(), 'x.json')
  assert.ok(path.includes(join('sessions')))
  assert.ok(!path.includes(resolveDirKey()))
})

test('session-global scope: a value written under one cwd is readable under a different cwd', () => {
  const scope = sessionGlobalScope()
  atomicWrite(storePath(scope, 'x.json'), 'global-content')

  const elsewhere = mkdtempSync(join(tmpdir(), 'workflow-store-global-chdir-'))
  const origCwd = process.cwd()
  try {
    process.chdir(elsewhere)
    assert.equal(load(sessionGlobalScope(), 'x.json'), 'global-content')
  } finally {
    process.chdir(origCwd)
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('session-global scope: an explicit rawSessionId addresses THAT session, independent of the ambient CLAUDE_CODE_SESSION_ID env var', () => {
  const origEnvSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-session-A'

    const pathForA = storePath(sessionGlobalScope(), 'x.json')
    const pathForExplicitB = storePath(sessionGlobalScope('explicit-session-B'), 'x.json')

    assert.notEqual(
      pathForA,
      pathForExplicitB,
      'an explicit rawSessionId resolves a different path than the ambient env session'
    )
    assert.ok(pathForA.includes('env-session-A'), 'no-arg call still uses the env var')
    assert.ok(
      pathForExplicitB.includes('explicit-session-B'),
      'explicit-arg call uses the given rawSessionId, not the env var'
    )
    assert.ok(
      !pathForExplicitB.includes('env-session-A'),
      'the explicit path does not leak the ambient env session id at all'
    )

    // Round-trip: a value written for the explicit session is readable back under that same
    // explicit id, even while the env var still names a totally different session.
    atomicWrite(pathForExplicitB, 'session-B-content')
    assert.equal(load(sessionGlobalScope('explicit-session-B'), 'x.json'), 'session-B-content')
    assert.equal(
      load(sessionGlobalScope(), 'x.json'),
      null,
      'the ambient env session (A) does not see session B data'
    )
  } finally {
    if (origEnvSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = origEnvSession
  }
})

test('atomicWrite creates nested parents under a fresh dirKey', () => {
  const scope: StoreScope = {
    kind: 'session',
    dirKey: 'fresh-nested-000000000000',
    sessionPartition: 'fresh-session',
  }
  const path = storePath(scope, 'x.json')
  atomicWrite(path, 'nested-content')
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, 'utf-8'), 'nested-content')
})

test('atomicWrite repairs a stale tmp file left at 0644 back to 0600 before it lands on the target path', () => {
  // writeFileSync's own `mode` option, like appendFileSync's and mkdirSync's elsewhere in this
  // module, only takes effect when the call CREATES `tmp` — a `tmp` left over from a same-pid
  // crash between an earlier writeFileSync and its renameSync (atomicWriteCounter resets per
  // process, so a same-pid crash can reproduce the same counter value) keeps whatever mode it
  // already had, and renameSync installs that mode on the target path along with the fresh
  // content. atomicWriteCounter is pinned per process and starts at 0, so proving this requires a
  // genuinely fresh process — a same-process second call would land on counter 1, a path this test
  // never seeds.
  const path = join(homeDir, 'atomic-write-mode-check.json')
  const childScript = join(import.meta.dirname, 'test', 'atomic-write-mode.child.ts')
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', childScript, path],
    {
      env: { ...process.env, HOME: homeDir },
      encoding: 'utf-8',
    }
  )
  assert.equal(result.status, 0, `child exited nonzero: ${result.stderr}`)
  const { preconditionMode, mode } = JSON.parse(result.stdout.trim())
  assert.equal(preconditionMode, 0o644, 'precondition: leftover tmp pre-exists at 0644')
  assert.equal(
    mode,
    0o600,
    'atomicWrite must repair a stale tmp file to 0600, not install it at its pre-existing mode'
  )
})

test('ticketScope: an already-safe ticket keeps its exact unhashed segment — no existing ledger is orphaned', () => {
  const path = storePath(ticketScope('FLOW-245'), 'review-ledger.jsonl')
  assert.equal(
    path,
    join(storeRoot(), 'tickets', 'FLOW-245', 'review-ledger.jsonl'),
    'a ticket key that is already a valid segment resolves to its literal, unhashed name'
  )
})

test('ticketScope: two raw tickets that collide under bare safeSegment resolve to different paths', () => {
  // Both 'FLOW/245' and 'FLOW 245' sanitize (via the char-replace regex) to the same 'FLOW_245' —
  // the collision safeSegment alone would produce, closed by hashing whenever sanitization alters
  // the value.
  const pathSlash = storePath(ticketScope('FLOW/245'), 'review-ledger.jsonl')
  const pathSpace = storePath(ticketScope('FLOW 245'), 'review-ledger.jsonl')
  assert.notEqual(pathSlash, pathSpace, 'distinct raw tickets never share a segment')
  assert.ok(!pathSlash.includes(join('tickets', 'FLOW_245', 'review-ledger.jsonl')))
  assert.ok(!pathSpace.includes(join('tickets', 'FLOW_245', 'review-ledger.jsonl')))
})

test('ticketScope: a ticket of ".", "..", or "" never resolves outside tickets/, nor collapses directly into it', () => {
  // '.', '..', and '' are the three raw values safeSegment leaves unchanged that path.join also
  // collapses away — '.' and '..' as path segments, '' as an empty trailing segment. A path that
  // merely stays under ticketsDir is not enough: collapsing straight into ticketsDir makes the
  // ledger a bare file there, sibling to every real ticket's own subdirectory, which is the same
  // failure the hash-suffix fix exists to prevent for '.' and '..' — so each raw value must also
  // get its own subdirectory, not land directly in tickets/.
  const ticketsDir = join(storeRoot(), 'tickets')
  for (const raw of ['.', '..', '']) {
    const path = storePath(ticketScope(raw), 'review-ledger.jsonl')
    const resolved = resolve(path)
    assert.ok(
      resolved.startsWith(ticketsDir + sep),
      `ticket ${JSON.stringify(raw)} resolves to ${resolved}, which must stay under ${ticketsDir}`
    )
    assert.notEqual(
      dirname(resolved),
      ticketsDir,
      `ticket ${JSON.stringify(raw)} must get its own subdirectory under ${ticketsDir}, not collapse directly into it`
    )
  }
})

test('appendLine: two appended lines round-trip through load() in order, newline-terminated', () => {
  const scope = sessionScope()
  const path = storePath(scope, 'log.jsonl')
  appendLine(path, 'first')
  appendLine(path, 'second')
  assert.equal(load(scope, 'log.jsonl'), 'first\nsecond\n')
})

test('appendLine creates nested parent directories on the first call', () => {
  const scope: StoreScope = {
    kind: 'session',
    dirKey: 'fresh-append-000000000000',
    sessionPartition: 'fresh-append-session',
  }
  const path = storePath(scope, 'log.jsonl')
  assert.ok(!existsSync(path))
  appendLine(path, 'only line')
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, 'utf-8'), 'only line\n')
})

test('appendLine: a file it creates from scratch ends at 0600', () => {
  const scope = sessionScope()
  const path = storePath(scope, 'mode-check.jsonl')
  assert.equal(existsSync(path), false, 'precondition: no file yet')
  appendLine(path, 'first line')
  assert.equal(
    statSync(path).mode & 0o777,
    0o600,
    'appendLine must create its file 0600, not the default umask mode'
  )
})

test('appendLine repairs the mode of a file that already exists at 0644 back to 0600', () => {
  // appendFileSync's mode option only takes effect when the call CREATES the file — a file that
  // already exists (e.g. a ledger written before this fix, or one that landed at the default
  // umask mode for any other reason) keeps whatever mode it already had unless appendLine
  // actively repairs it. This is the case the fresh-file test above cannot exercise.
  const scope = sessionScope()
  const path = storePath(scope, 'preexisting-mode.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  // writeFileSync's own `mode` option is masked by the process umask the same way appendFileSync's
  // is — seeding with { mode: 0o644 } directly could silently land at 0o600 under a strict umask
  // (e.g. 077), making the precondition assertion below fail on a machine where nothing is actually
  // wrong. chmodSync is not umask-masked, so it seeds the exact mode regardless of the runner's umask.
  writeFileSync(path, 'seed\n')
  chmodSync(path, 0o644)
  assert.equal(
    statSync(path).mode & 0o777,
    0o644,
    'precondition: file pre-exists at a non-0600 mode'
  )
  appendLine(path, 'appended line')
  assert.equal(
    statSync(path).mode & 0o777,
    0o600,
    'appendLine must repair an existing file to 0600, not just set the mode on creation'
  )
})

test('appendLine repairs a pre-existing directory chain, from storeRoot() through the leaf, from 0755 back to 0700', () => {
  const scope: StoreScope = {
    kind: 'session',
    dirKey: 'preexisting-dir-000000000000',
    sessionPartition: 'preexisting-dir-session',
  }
  const path = storePath(scope, 'log.jsonl')
  const leafDir = dirname(path)

  // mkdirSync's own `mode` option is masked by the umask the same way writeFileSync's is (see the
  // fixture note above) — seed every level explicitly with chmodSync so the precondition holds
  // regardless of the runner's umask.
  mkdirSync(leafDir, { recursive: true })
  for (let dir = leafDir; ; dir = dirname(dir)) {
    chmodSync(dir, 0o755)
    if (dir === storeRoot()) break
  }
  assert.equal(statSync(leafDir).mode & 0o777, 0o755, 'precondition: leaf pre-exists at 0755')
  assert.equal(
    statSync(storeRoot()).mode & 0o777,
    0o755,
    'precondition: storeRoot() pre-exists at 0755'
  )

  appendLine(path, 'first line')

  for (let dir = leafDir; ; dir = dirname(dir)) {
    assert.equal(
      statSync(dir).mode & 0o777,
      0o700,
      `${dir} must be repaired to 0700, not left at its pre-existing mode`
    )
    if (dir === storeRoot()) break
  }
})

test('appendLine never touches the mode of ~/.claude or anything above it, even when it already exists', () => {
  const scope = sessionScope()
  const path = storePath(scope, 'log.jsonl')
  const claudeDir = dirname(storeRoot())

  mkdirSync(claudeDir, { recursive: true })
  chmodSync(claudeDir, 0o750)
  assert.equal(
    statSync(claudeDir).mode & 0o777,
    0o750,
    'precondition: ~/.claude pre-exists at a mode this module did not choose'
  )

  appendLine(path, 'first line')

  assert.equal(
    statSync(claudeDir).mode & 0o777,
    0o750,
    '~/.claude is not ours to re-mode — it must be left exactly as it was found'
  )
})

test('ensureDurableDir normalizes a trailing separator before walking, and still never touches ~/.claude', () => {
  const claudeDir = dirname(storeRoot())
  mkdirSync(claudeDir, { recursive: true })
  chmodSync(claudeDir, 0o750)
  assert.equal(
    statSync(claudeDir).mode & 0o777,
    0o750,
    'precondition: ~/.claude pre-exists at a mode this module did not choose'
  )

  // A trailing separator on storeRoot() itself is the case that defeats an unnormalized walk:
  // isRootOrBeneath's startsWith check still admits it, but the walk's exact-string `current ===
  // root` termination check never fires on `storeRoot() + sep`, so an unnormalized implementation
  // would climb past storeRoot() into claudeDir and repair it too.
  ensureDurableDir(storeRoot() + sep)

  assert.equal(
    statSync(claudeDir).mode & 0o777,
    0o750,
    'a trailing separator on the target must not make the repair walk climb into ~/.claude'
  )
  assert.equal(
    statSync(storeRoot()).mode & 0o777,
    0o700,
    'storeRoot() itself is still repaired to 0700'
  )
})

test('ensureDurableDir resolves a non-normalized but in-boundary path before creating it', () => {
  // Built via string concatenation, not path.join/resolve: join() normalizes '..' segments away as
  // part of building the string, so a join()-built path never reaches ensureDurableDir carrying a
  // literal '..' in the first place — it would arrive already resolved, exercising nothing. This is
  // the shape a caller who built a path by concatenation (or received one from elsewhere) could
  // actually hand in.
  const messy = `${storeRoot()}${sep}a${sep}b${sep}..${sep}c`
  const resolved = join(storeRoot(), 'a', 'c')

  ensureDurableDir(messy)

  assert.ok(existsSync(resolved), 'the normalized target directory is created')
  assert.ok(
    !existsSync(join(storeRoot(), 'a', 'b')),
    'the un-normalized intermediate is never created — resolve() ran before mkdirSync saw the path'
  )
  assert.equal(
    statSync(resolved).mode & 0o777,
    0o700,
    'created at 0700 despite the non-normalized input'
  )
  assert.equal(
    statSync(storeRoot()).mode & 0o777,
    0o700,
    'storeRoot() itself is still repaired/created at 0700'
  )
})

test('ensureDurableDir rejects an escaping path and never touches ~/.claude or its parent', () => {
  const claudeDir = dirname(storeRoot())
  const aboveClaudeDir = dirname(claudeDir)
  mkdirSync(claudeDir, { recursive: true })
  chmodSync(claudeDir, 0o750)
  chmodSync(aboveClaudeDir, 0o750)
  assert.equal(
    statSync(claudeDir).mode & 0o777,
    0o750,
    'precondition: ~/.claude at a mode this module did not choose'
  )
  assert.equal(
    statSync(aboveClaudeDir).mode & 0o777,
    0o750,
    'precondition: the level above ~/.claude at a mode this module did not choose'
  )

  // Same reasoning as above: raw concatenation preserves the literal '..' segments so
  // isRootOrBeneath's string check is exercised against exactly the input that used to fool it.
  const escaping = `${storeRoot()}${sep}..${sep}..`
  ensureDurableDir(escaping)

  assert.equal(
    statSync(claudeDir).mode & 0o777,
    0o750,
    '~/.claude must not be touched by an escaping path'
  )
  assert.equal(
    statSync(aboveClaudeDir).mode & 0o777,
    0o750,
    'the level above ~/.claude must not be touched by an escaping path'
  )
})

test('appendLine on a cold start creates ~/.claude at the ambient default mode, then storeRoot() and the leaf at 0700', () => {
  const scope: StoreScope = {
    kind: 'session',
    dirKey: 'cold-start-000000000000',
    sessionPartition: 'cold-start-session',
  }
  const path = storePath(scope, 'log.jsonl')
  const claudeDir = dirname(storeRoot())
  assert.equal(existsSync(claudeDir), false, 'precondition: ~/.claude does not exist yet')

  appendLine(path, 'first line')

  // A sibling directory created the same unmoded way ~/.claude was (no mode argument to mkdirSync)
  // pins the expected mode without hardcoding a literal that would bake this runner's umask into
  // the assertion.
  const sentinelPath = join(homeDir, 'sentinel')
  mkdirSync(sentinelPath, { recursive: true })
  assert.equal(
    statSync(claudeDir).mode & 0o777,
    statSync(sentinelPath).mode & 0o777,
    '~/.claude must land at the ambient default mode, never a mode this module chose'
  )
  assert.equal(
    statSync(storeRoot()).mode & 0o777,
    0o700,
    'storeRoot() itself must be 0700 even on a cold start'
  )
  assert.equal(
    statSync(dirname(path)).mode & 0o777,
    0o700,
    'the leaf directory must be 0700 on a cold start'
  )
})

test('StoreUnreadableError: only asserts existence for a code that actually establishes it (FLOW-226 finding ae16ce7c4247)', () => {
  assert.match(
    new StoreUnreadableError('/x/ledger.json', 'EACCES').message,
    /^\/x\/ledger\.json exists but could not be read \(EACCES\)/,
    'EACCES fires on the target itself, so existence is real'
  )
  assert.doesNotMatch(
    new StoreUnreadableError('/x/ledger.json', 'ENOTDIR').message,
    /exists but/,
    'ENOTDIR fires resolving a path component before the target is ever reached'
  )
})

test('StoreUnreadableError: ownership advice only for a code ownership can fix (FLOW-226 finding 37bd045f47b8)', () => {
  assert.match(
    new StoreUnreadableError('/x/ledger.json', 'EACCES').message,
    /check its owner and permissions/,
    'EACCES is a permission bit, so chmod/chown actually repairs it'
  )
  assert.match(
    new StoreUnreadableError('/x/ledger.json', 'EPERM').message,
    /check its owner and permissions/,
    'EPERM is a permission bit, so chmod/chown actually repairs it'
  )
  assert.doesNotMatch(
    new StoreUnreadableError('/x/ledger.json', 'EISDIR').message,
    /owner and permissions/,
    'a directory sitting at the path is not an ownership problem'
  )
  assert.doesNotMatch(
    new StoreUnreadableError('/x/ledger.json', 'EIO').message,
    /owner and permissions/,
    'a device-level read failure is not an ownership problem'
  )
})
