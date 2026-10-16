import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { invokeDashboardBin, invokeDashboardRaw, resolveDashboardBin } from './invoke.ts'

// ---------------------------------------------------------------------------
// FLOW-233 — a spawned dashboard child must not inherit a cwd that no longer exists (a long-lived
// process's launch dir, once `git worktree remove` deletes it out from under the still-running process).
//
// The stub below MUST be a Node script that calls process.cwd() — matching the real
// ai-workflow-app, which crashes via Node's process.cwd() at module load, not via anything bash
// does at startup. A stub that never reads cwd at all exits 0 either way; see the "does NOT read
// cwd" test below for that trap made explicit.
// ---------------------------------------------------------------------------

/** Write a stub `ai-workflow-app` that prints its own cwd. */
const writeCwdStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(path, '#!/usr/bin/env node\nconsole.log(process.cwd())\n')
  chmodSync(path, 0o755)
  return path
}

/** Write a stub that never reads cwd — the vacuity trap's control. */
const writeInertStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(path, '#!/usr/bin/env node\nprocess.exit(0)\n')
  chmodSync(path, 0o755)
  return path
}

/** chdir into a fresh temp dir, then remove it out from under the process — the FLOW-233
 * failure mode (a worktree removed while a long-lived process still runs from it). */
const removeCwd = (): void => {
  const victim = mkdtempSync(join(tmpdir(), 'flow-233-victim-'))
  process.chdir(victim)
  rmSync(victim, { recursive: true, force: true })
}

let originalCwd: string
let origBin: string | undefined
let origPath: string | undefined
let tempDirs: string[]

/** Create a tracked temp dir, cleaned up in afterEach. */
const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// Capture cwd BEFORE any chdir — process.cwd() throws once the directory is gone.
beforeEach(() => {
  originalCwd = process.cwd()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  origPath = process.env.PATH
  tempDirs = []
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable", never fall
  // through to the real installed ai-workflow-app and drive it against the real board (mirrors
  // dashboard.test.ts's same guard). Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpdir(), 'flow-233-no-such-ai-workflow-app')
})

afterEach(() => {
  // Restore cwd before removing anything — rmSync from a dead cwd is the failure mode under test,
  // not a hazard we want in cleanup, and the removeCwd() victim itself is not tracked here (it's
  // already gone by the time the test body runs).
  process.chdir(originalCwd)
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (origBin === undefined) {
    delete process.env.AI_WORKFLOW_APP_BIN
  } else {
    process.env.AI_WORKFLOW_APP_BIN = origBin
  }
  if (origPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = origPath
  }
})

test('invokeDashboardBin: succeeds when the caller cwd has been removed', () => {
  const stubDir = makeTempDir('flow-233-stub-')
  const stub = writeCwdStub(stubDir)
  removeCwd()

  const result = invokeDashboardBin(stub, ['session', 'list'])

  assert.notEqual(result, null, 'call succeeds even though the caller cwd is gone')
  // realpathSync both sides: process.cwd() (what the child reports) resolves symlinks, so
  // comparing it against an unresolved homedir() would pass or fail on whether the OS happens to
  // symlink the home directory, not on whether the fix pinned it.
  assert.equal(
    realpathSync(result!.trim()),
    realpathSync(homedir()),
    'the child reports the pinned homedir, not a dead cwd'
  )
})

test('invokeDashboardBin: passes the pinned cwd, not the caller cwd', () => {
  const stubDir = makeTempDir('flow-233-stub-')
  const stub = writeCwdStub(stubDir)
  // A valid, unusual cwd that still exists — distinguishes "pins homedir()" from "merely doesn't
  // crash": a fix that only guarded the removed-directory case would still leak this cwd through.
  const validUnusualDir = makeTempDir('flow-233-valid-')
  process.chdir(validUnusualDir)

  const result = invokeDashboardBin(stub, ['session', 'list'])

  assert.equal(
    realpathSync(result!.trim()),
    realpathSync(homedir()),
    'child reports homedir(), not the valid-but-unusual cwd'
  )
  assert.notEqual(
    realpathSync(result!.trim()),
    realpathSync(validUnusualDir),
    'the caller cwd never reaches the child'
  )
})

// `invokeDashboardRaw` is the last of the three spawn sites the header rule covers, added by the
// `item show` story. It resolves the binary itself instead of taking one, so its stub is wired
// through AI_WORKFLOW_APP_BIN rather than passed as an argument.
test('invokeDashboardRaw: passes the pinned cwd, not the caller cwd', () => {
  const stubDir = makeTempDir('flow-233-stub-')
  process.env.AI_WORKFLOW_APP_BIN = writeCwdStub(stubDir)
  const validUnusualDir = makeTempDir('flow-233-valid-')
  process.chdir(validUnusualDir)

  const result = invokeDashboardRaw(['item', 'show', '--item', 'item-1'])

  assert.notEqual(result, null, 'the stub resolved, so this is a real spawn and not a no-op')
  assert.equal(
    realpathSync(result!.stdout.trim()),
    realpathSync(homedir()),
    'child reports homedir(), not the valid-but-unusual cwd'
  )
  assert.notEqual(
    realpathSync(result!.stdout.trim()),
    realpathSync(validUnusualDir),
    'the caller cwd never reaches the child'
  )
})

// `resolveDashboardBin`'s PATH probe is the first of the three spawn sites the header rule covers.
// It prints the binary it resolved and never its own cwd, so cwd is observable here only through a
// PATH entry that is itself relative — `.` resolves against whichever directory the child actually
// runs in. The absolute-PATH assertion below separates a null produced by the pin from one produced
// by a harness that could not find the stub at all. It is a guard in its own right and not a
// control. Replacing PATH keeps beforeEach's guarantee that no test reaches the real installed
// ai-workflow-app, which is why deleting the env var is safe.
test('resolveDashboardBin: the PATH probe resolves from the pinned cwd, not the caller cwd', () => {
  delete process.env.AI_WORKFLOW_APP_BIN
  const callerDir = makeTempDir('flow-233-relative-path-')
  writeCwdStub(callerDir)
  process.chdir(callerDir)

  process.env.PATH = '.'
  const viaRelativePath = resolveDashboardBin()

  process.env.PATH = callerDir
  const viaAbsolutePath = resolveDashboardBin()

  assert.equal(
    viaRelativePath,
    null,
    'a `.` PATH entry resolves against the pinned homedir(), where no stub lives'
  )
  assert.equal(
    realpathSync(viaAbsolutePath!),
    realpathSync(join(callerDir, 'ai-workflow-app')),
    'the same stub IS found when PATH names it absolutely, so the null above is the pin'
  )
})

// Control, not a fix guard: `resolveDashboardBin`'s `AI_WORKFLOW_APP_BIN` branch returns before
// ever spawning, so it is unaffected by cwd either before or after the fix.
test('resolveDashboardBin: returns the explicit binary without spawning (control, not coverage)', () => {
  const stubDir = makeTempDir('flow-233-stub-')
  const stub = writeCwdStub(stubDir)
  process.env.AI_WORKFLOW_APP_BIN = stub
  removeCwd()

  const resolved = resolveDashboardBin()

  assert.equal(resolved, stub, 'resolves via the explicit env var even with a dead cwd')
})

// Control, not a fix guard: documents WHY test 1's stub must read process.cwd(). An inert child
// succeeds from a removed cwd with or without the fix, so this test is expected to pass in the
// RED baseline too — it proves the trap, not the fix.
test('invokeDashboardBin: a child that does NOT read cwd succeeds either way (vacuity control, not fix coverage)', () => {
  const stubDir = makeTempDir('flow-233-stub-')
  const stub = writeInertStub(stubDir)
  removeCwd()

  const result = invokeDashboardBin(stub, ['session', 'list'])

  assert.notEqual(
    result,
    null,
    'an inert child succeeds regardless of cwd — this is why test 1 must read cwd'
  )
})
