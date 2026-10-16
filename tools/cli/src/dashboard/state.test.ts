import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  loadState,
  saveState,
  stateFilePath,
  stateFileIsCorrupt,
  deferredQuestionsOf,
  nextDeferredId,
  refuseCorruptState,
  corruptStateDiagnosis,
  type DeferredQuestion,
  type DashboardSessionState,
} from './state.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

let tmpDir: string
let id: string
let homeDir: string
let origHome: string | undefined

// stateFilePath resolves through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state store.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'state-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  id = `test-state-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'state-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  setRequestedExitCode(0)
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('parentId round-trips through save/load (key present on the loaded object)', () => {
  saveState(id, { registered: true, phase: 'prd', openItemIds: [], parentId: `${id}:PARENT` })

  const state = loadState(id)
  assert.equal(state!.parentId, `${id}:PARENT`, 'parentId round-trips')
  assert.ok('parentId' in state!, 'parentId key is present when the file has one')
})

test('parentId of null round-trips (root-level entered node)', () => {
  saveState(id, { registered: true, phase: 'prd', openItemIds: [], parentId: null })

  const state = loadState(id)
  assert.equal(state!.parentId, null, 'explicit null parentId round-trips as null')
})

test('missing parentId (legacy ensure/rotate state file) omits the key; consumers see null', () => {
  // Simulate a state file written before FLOW-117 (no parentId field at all) — exactly what
  // ensure/rotate's saveState calls produce, since neither sets parentId.
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'prd', openItemIds: [] })
  )

  const state = loadState(id)
  // Pin the backward-compat shape: the key is omitted entirely (not defaulted to null), so a
  // legacy on-disk state file written before parentId existed still deep-equals exactly on load.
  assert.ok(
    !('parentId' in state!),
    'parentId key is omitted, not defaulted to null, when absent from the file'
  )
  // ...while runLeave-style consumers (`state?.parentId ?? null`) still see null either way.
  assert.equal(
    state?.parentId ?? null,
    null,
    'missing parentId reads as null for `?? null` consumers'
  )
})

// ---------------------------------------------------------------------------
// stateFileIsCorrupt (FLOW-250)
// ---------------------------------------------------------------------------

test('stateFileIsCorrupt is false when no state file exists', () => {
  assert.equal(stateFileIsCorrupt(id), false)
})

test('stateFileIsCorrupt is false for a valid state file', () => {
  saveState(id, { registered: true, phase: 'impl', openItemIds: [] })
  assert.equal(stateFileIsCorrupt(id), false)
})

test('stateFileIsCorrupt is true for a present, unparseable state file — the case loadState collapses to null the same as absent', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(stateFilePath(id), '{not json')

  assert.equal(
    loadState(id),
    null,
    'precondition: loadState collapses this to null, same as absent'
  )
  assert.equal(stateFileIsCorrupt(id), true, 'stateFileIsCorrupt tells the two apart')
})

test('stateFileIsCorrupt is true for a present but unreadable state file, not false as for absent', () => {
  // A directory at the file's path rather than a chmod: root bypasses permission bits, so a
  // mode-000 file stays readable under a root test runner and the fixture never reaches the branch
  // under test. EISDIR comes back to every uid.
  mkdirSync(stateFilePath(id), { recursive: true })
  assert.throws(
    () => readFileSync(stateFilePath(id), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or this test observes nothing'
  )

  assert.equal(loadState(id), null, 'loadState collapses it to null, exactly as it does for absent')
  assert.equal(stateFileIsCorrupt(id), true, 'the classifier is what tells the two apart')
})

test('corruptStateDiagnosis names an unreadable file rather than reporting a parse failure', () => {
  mkdirSync(stateFilePath(id), { recursive: true })

  const diagnosis = corruptStateDiagnosis(id)
  assert.equal(
    diagnosis,
    'exists but could not be read (EISDIR)',
    'a directory sitting at the path is not an ownership problem, so EISDIR gets no such advice'
  )
})

test('corruptStateDiagnosis names a wrong-shaped load-bearing field rather than reporting a parse failure', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(stateFilePath(id), JSON.stringify({ registered: 'yes', openItemIds: [] }))

  assert.equal(stateFileIsCorrupt(id), true, 'precondition: this is a file the classifier refuses')
  assert.equal(
    corruptStateDiagnosis(id),
    'parses, but its registered or openItemIds field holds something other than a boolean and an array of strings',
    'the arm that fired is the arm reported'
  )
})

// ---------------------------------------------------------------------------
// deferredQuestions queue (FLOW-250)
// ---------------------------------------------------------------------------

const makeDeferredQuestion = (id: string): DeferredQuestion => ({
  id,
  lede: `lede for ${id}`,
  body: '',
  recommend: 'do it',
  whyMine: 'scope',
  deferredAtPhase: 'impl',
})

test('a state file without deferredQuestions loads as an empty queue', () => {
  // No key at all — the legacy/pre-field shape.
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [] })
  )
  assert.deepEqual(
    deferredQuestionsOf(loadState(id)),
    [],
    'a state file with no deferredQuestions key reads as an empty queue'
  )

  // A file that DOES carry the key round-trips both entries — proves the read is not a hardcoded [].
  const entries = [makeDeferredQuestion('q1'), makeDeferredQuestion('q2')]
  saveState(id, { registered: true, phase: 'impl', openItemIds: [], deferredQuestions: entries })
  assert.deepEqual(
    deferredQuestionsOf(loadState(id)),
    entries,
    'a state file carrying deferredQuestions round-trips every entry'
  )
})

test('loadState removes an entry carrying a legacy dropped record instead of resurrecting it as pending', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({
      registered: true,
      phase: 'implementation',
      openItemIds: [],
      deferredQuestions: [
        {
          id: 'q1',
          lede: 'Keep me',
          body: '',
          recommend: 'Ship it',
          whyMine: 'scope',
          deferredAtPhase: 'implementation',
        },
        {
          id: 'q2',
          lede: 'Drop me',
          body: '',
          recommend: 'Ship it',
          whyMine: 'scope',
          deferredAtPhase: 'implementation',
          dropped: { reason: 'answered', atPhase: 'implementation' },
        },
      ],
      deferredIdCounter: 2,
    })
  )
  assert.deepEqual(
    loadState(id)?.deferredQuestions?.map((entry) => entry.id),
    ['q1'],
    'the legacy dropped entry is gone; the pending one survives'
  )
  assert.equal(stateFileIsCorrupt(id), false, 'a legacy dropped record is not corruption')
})

// A hand-repaired or hand-written file can carry a deferredQuestions field of the wrong shape and
// still parse as valid JSON. A PRESENT, invalid deferredQuestions is corrupt state, exactly like
// unparseable JSON: without this, a non-array reaches deferredQuestionsOf's .filter/.map unguarded
// (an unhandled TypeError, a raw stack trace to the caller).
test('a non-array deferredQuestions makes loadState collapse to null and stateFileIsCorrupt report true', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredQuestions: 'oops' })
  )

  assert.equal(
    loadState(id),
    null,
    'a malformed (non-array) deferredQuestions is corrupt, not a droppable field'
  )
  assert.equal(stateFileIsCorrupt(id), true, 'the classifier reports the same file as corrupt')
})

// Same class, for an array whose entries carry the wrong shape. A well-formed array of malformed
// entries reaching a caller that composes each entry's fields directly (e.g. a board prompt) would
// print literal "undefined" text as if it were real question content — and, before this fix, the
// array was dropped in full and the file read as a genuinely empty queue, which let an approval post
// past a queue that actually still held a (malformed) entry and then overwrote the file, empty, on
// the next save. Pins the refusal, not the silent drop.
test('a deferredQuestions array containing a malformed entry makes loadState collapse to null and stateFileIsCorrupt report true', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({
      registered: true,
      phase: 'impl',
      openItemIds: [],
      deferredQuestions: [{ id: 'q1' }],
    })
  )

  assert.equal(
    loadState(id),
    null,
    'one malformed entry makes the whole file read as corrupt, not a droppable-in-full array'
  )
  assert.equal(stateFileIsCorrupt(id), true, 'the classifier reports the same file as corrupt')
})

// Regression for FLOW-250: loadState's own typeof guard would otherwise silently drop a
// wrong-typed deferredIdCounter rather than treating it as corrupt, letting nextDeferredId read
// the dropped field as absent (0) and reseed from the queue's own high-water mark alone —
// recycling an id already issued. Same principle as the deferredQuestions tests above: a KEY
// PRESENT with the wrong shape is not the same absence "absent === 0" covers.
test('a wrong-typed deferredIdCounter makes stateFileIsCorrupt report true, not a silently droppable field', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: 'nine' })
  )

  assert.equal(
    stateFileIsCorrupt(id),
    true,
    'a present, wrong-typed deferredIdCounter is corrupt state, not a field loadState can safely drop'
  )
  assert.equal(
    corruptStateDiagnosis(id),
    'parses, but its deferredIdCounter field holds something other than a non-negative safe integer',
    'names the actual field, not the generic "failed to parse" wording'
  )
})

// The wrong-typed case above only proves the type arm — a present deferredIdCounter that IS a
// number but falls outside the domain nextDeferredId actually assumes (a non-negative integer)
// would otherwise pass this check silently, corrupting every id nextDeferredId went on to mint
// from it.
test('a negative or non-integer deferredIdCounter makes stateFileIsCorrupt report true, not just a wrong type', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: -3 })
  )
  assert.equal(
    stateFileIsCorrupt(id),
    true,
    'a negative counter is out of the domain nextDeferredId assumes'
  )

  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: 2.5 })
  )
  assert.equal(stateFileIsCorrupt(id), true, 'a non-integer counter is out of the same domain')
})

// Positive control for the test above: a genuinely valid non-negative integer counter — including
// the boundary value 0 — must still read as NOT corrupt, proving the domain check does not
// overreach into values nextDeferredId actually accepts.
test('a valid non-negative integer deferredIdCounter, 0 included, still reads as not corrupt', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: 0 })
  )
  assert.equal(stateFileIsCorrupt(id), false, '0 is a valid counter value, not corrupt')

  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: 7 })
  )
  assert.equal(stateFileIsCorrupt(id), false, 'an ordinary positive integer counter is not corrupt')
})

// isDeferredQuestion must not accept any string for whyMine, only a member of the WhyMine union
// — otherwise an out-of-union value round-trips through loadState as if it were a genuine
// escalation-contract reason.
test('a deferredQuestions entry with a whyMine value outside the WhyMine union is corrupt, not a droppable field', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({
      registered: true,
      phase: 'impl',
      openItemIds: [],
      deferredQuestions: [
        {
          id: 'q1',
          lede: 'lede',
          body: '',
          recommend: 'do it',
          whyMine: 'because-i-said-so',
          deferredAtPhase: 'impl',
        },
      ],
    })
  )

  assert.equal(
    loadState(id),
    null,
    'an out-of-union whyMine is corrupt, same as a wrong-typed field'
  )
  assert.equal(stateFileIsCorrupt(id), true, 'the classifier reports the same file as corrupt')
})

const makeState = (fields: Partial<DashboardSessionState>): DashboardSessionState => ({
  registered: true,
  phase: 'impl',
  openItemIds: [],
  ...fields,
})

test('nextDeferredId seeds from the queue when there is no persisted counter (null or legacy state)', () => {
  assert.equal(nextDeferredId(null).id, 'q1', 'no state at all starts at q1')
  assert.equal(
    nextDeferredId(
      makeState({ deferredQuestions: [makeDeferredQuestion('q1'), makeDeferredQuestion('q3')] })
    ).id,
    'q4',
    'a legacy state with no deferredIdCounter seeds from the queue’s own highest suffix, not its length'
  )
})

test('nextDeferredId reads the persisted counter, not just the queue, once every queued entry it issued has been flushed off', () => {
  // Simulates a FLOW-250 defect: a flush drained the queue to empty
  // while q1..q9 had already been issued. A counter-less read would restart from the queue's own
  // (now-empty) highest suffix and reissue q1 — recycling an id a concurrent caller might still be
  // holding from before the drain.
  assert.equal(
    nextDeferredId(makeState({ deferredQuestions: [], deferredIdCounter: 9 })).id,
    'q10',
    'the counter persists past the queue draining to empty, so the next id continues past it'
  )
})

test('nextDeferredId takes whichever of the persisted counter and the queue’s own highest suffix is larger', () => {
  // The counter is the source of truth once present, but a queue entry can still outrun it —
  // e.g. a state file hand-edited, or written by a build that queued without bumping the counter.
  // Taking the max, never the counter alone, is what keeps a live queued id from ever being reissued.
  assert.equal(
    nextDeferredId(
      makeState({ deferredQuestions: [makeDeferredQuestion('q12')], deferredIdCounter: 3 })
    ).id,
    'q13',
    'a queued suffix ahead of the counter still wins'
  )
  assert.equal(
    nextDeferredId(
      makeState({ deferredQuestions: [makeDeferredQuestion('q2')], deferredIdCounter: 12 })
    ).id,
    'q13',
    'a counter ahead of every queued suffix still wins'
  )
})

test('nextDeferredId returns the counter value to persist alongside the id', () => {
  const result = nextDeferredId(makeState({ deferredQuestions: [], deferredIdCounter: 4 }))
  assert.equal(result.id, 'q5')
  assert.equal(
    result.counter,
    5,
    'the returned counter is what the caller must save back onto state'
  )
})

test('nextDeferredId treats a queued id that does not match "q<n>" as contributing 0, not a crash', () => {
  assert.equal(
    nextDeferredId(makeState({ deferredQuestions: [makeDeferredQuestion('legacy-entry')] })).id,
    'q1',
    'a non-numeric-suffix id is not read as a suffix at all'
  )
})

// deferredIdCounterIsCorrupt's own prescribed guard must use Number.isSafeInteger, not
// Number.isInteger: Number.isInteger(1e300) is true while Number.isSafeInteger(1e300) is false,
// so an unsafe-integer counter would pass as "not corrupt" and reach nextDeferredId, where it
// collapses under float precision (Math.max(1e300, 0) + 1 === 1e300) and never advances — a dead
// seed minting the same id on every deferral.
test('an unsafe-integer deferredIdCounter (above Number.MAX_SAFE_INTEGER) is corrupt, not silently accepted', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: 1e300 })
  )
  assert.equal(
    stateFileIsCorrupt(id),
    true,
    'an unsafe integer is out of the domain nextDeferredId can mint fresh ids from'
  )
  assert.equal(
    corruptStateDiagnosis(id),
    'parses, but its deferredIdCounter field holds something other than a non-negative safe integer',
    'names the actual field, not the generic "failed to parse" wording'
  )
})

// Negative control for the test above: a fractional counter — the case 777b86c's narrowing was
// actually written for — must still be refused, with the diagnosis wording intact, proving the hole
// was specific to unsafe integers rather than the guard itself being broken.
test('a fractional deferredIdCounter is still corrupt after the isSafeInteger fix, full diagnosis intact', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredIdCounter: 2.5 })
  )
  assert.equal(stateFileIsCorrupt(id), true, 'a non-integer counter is still refused')
  assert.equal(
    corruptStateDiagnosis(id),
    'parses, but its deferredIdCounter field holds something other than a non-negative safe integer',
    'the diagnosis text stays intact for the pre-existing fractional case'
  )
})

// Positive control: an ordinary, unedited counter sequence must keep minting q1, then q2, entirely
// unaffected by the isSafeInteger narrowing — proving the fix does not overreach into values
// nextDeferredId actually accepts day to day.
test('nextDeferredId mints q1 then q2 for an ordinary unedited state, unaffected by the isSafeInteger fix', () => {
  const first = nextDeferredId(makeState({ deferredQuestions: [] }))
  assert.equal(first.id, 'q1')
  const second = nextDeferredId(
    makeState({ deferredQuestions: [], deferredIdCounter: first.counter })
  )
  assert.equal(second.id, 'q2')
})

// A queue entry's "q<n>" suffix beyond Number.MAX_SAFE_INTEGER collapses under float precision the
// same way an unsafe persisted counter would. Two consecutive mints, not one: the collapse only
// shows up as the SAME id minted twice, not as a single wrong value.
test('nextDeferredId ignores a queued suffix beyond Number.MAX_SAFE_INTEGER, minting q1 then q2 instead of recycling', () => {
  const hugeSuffixId = `q${'9'.repeat(300)}`
  const first = nextDeferredId(
    makeState({ deferredQuestions: [makeDeferredQuestion(hugeSuffixId)] })
  )
  assert.equal(first.id, 'q1', 'the unsafe suffix contributes nothing to the seed')

  const second = nextDeferredId(
    makeState({
      deferredQuestions: [makeDeferredQuestion(hugeSuffixId)],
      deferredIdCounter: first.counter,
    })
  )
  assert.equal(second.id, 'q2', 'the second mint still advances instead of recycling the first id')
})

test('deferredQuestionsOf(null) is the empty queue', () => {
  assert.deepEqual(deferredQuestionsOf(null), [])
})

test('refuseCorruptState writes the shared refusal and sets the error exit code', () => {
  // refuseCorruptState is only ever called once stateFileIsCorrupt has already found a real,
  // present-but-broken file — write one, rather than calling it against a file that was never
  // written (that precondition-violating case is corruptStateDiagnosis's "no longer exists" test
  // below).
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(stateFilePath(id), '{not json')

  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk))
    return true
  }
  try {
    refuseCorruptState(id, 'do the thing')
  } finally {
    process.stderr.write = orig
  }
  const stderrOut = chunks.join('')

  assert.ok(stderrOut.includes('failed to parse'), 'names the failure')
  assert.ok(stderrOut.includes('refusing to do the thing'), 'names the caller-supplied verb')
  assert.equal(getRequestedExitCode(), 1, 'the error exit code is set')
})

// A shape-invalid deferredQuestions file parses as valid JSON — "failed to parse" is simply false
// for it. Pins that refuseCorruptState re-derives the arm instead of repeating the JSON-arm wording
// unconditionally (FLOW-250).
test('refuseCorruptState names the deferredQuestions field, not "failed to parse", for a shape-invalid file', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredQuestions: 'oops' })
  )

  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk))
    return true
  }
  try {
    refuseCorruptState(id, 'do the thing')
  } finally {
    process.stderr.write = orig
  }
  const stderrOut = chunks.join('')

  assert.ok(stderrOut.includes('deferredQuestions'), 'names the field that is the wrong shape')
  assert.equal(
    stderrOut.includes('failed to parse'),
    false,
    'the file parsed fine — this would be false'
  )
  assert.ok(stderrOut.includes('refusing to do the thing'), 'names the caller-supplied verb')
  assert.equal(getRequestedExitCode(), 1, 'the error exit code is set')
})

test('corruptStateDiagnosis: unparseable JSON vs. shape-invalid deferredQuestions read as two distinct diagnoses', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })

  writeFileSync(stateFilePath(id), '{not json')
  const unparseable = corruptStateDiagnosis(id)
  assert.ok(unparseable.includes('failed to parse'), 'unparseable JSON keeps the JSON-arm wording')

  writeFileSync(
    stateFilePath(id),
    JSON.stringify({ registered: true, phase: 'impl', openItemIds: [], deferredQuestions: 'oops' })
  )
  const shapeInvalid = corruptStateDiagnosis(id)
  assert.ok(shapeInvalid.includes('deferredQuestions'), 'shape-invalid names the field')
  assert.notEqual(shapeInvalid, unparseable, 'the two arms read as different diagnoses')
})

// A TOCTOU window — stateFileIsCorrupt reads the file as corrupt, then the file is removed before
// corruptStateDiagnosis re-derives why — must not fall through to "exists but failed to parse",
// which is false for a file that no longer exists.
test('corruptStateDiagnosis: an absent file reads as "no longer exists", not the false "exists but failed to parse"', () => {
  assert.equal(
    corruptStateDiagnosis(id),
    'no longer exists',
    'no file was ever written for this id — the wording must not claim it exists'
  )
})

// --- Load-bearing field validation (FLOW-226) ---

const writeRawState = (raw: unknown): void => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(stateFilePath(id), JSON.stringify(raw))
}

test('loadState refuses a numeric openItemIds instead of reading it as no open items', () => {
  writeRawState({ registered: true, phase: 'prd', openItemIds: 3 })

  assert.equal(loadState(id), null, 'a corrupt ledger must not load as a usable state')
  assert.equal(stateFileIsCorrupt(id), true, 'and callers gating on corruption must see it')
})

test('loadState refuses an openItemIds array holding a non-string entry', () => {
  writeRawState({ registered: true, phase: 'prd', openItemIds: ['q1', 7] })

  assert.equal(loadState(id), null)
  assert.equal(stateFileIsCorrupt(id), true)
})

test('loadState refuses a string registered, which would otherwise read as truthy', () => {
  // `?? false` passes any non-null value straight through, so the string "no" loads as registered.
  writeRawState({ registered: 'no', phase: 'prd', openItemIds: ['q1'] })

  assert.equal(loadState(id), null)
  assert.equal(stateFileIsCorrupt(id), true)
})

test('loadState still loads a well-formed state — the control for the three refusals above', () => {
  writeRawState({ registered: true, phase: 'prd', openItemIds: ['q1', 'q2'] })

  const state = loadState(id)
  assert.deepEqual(state, { registered: true, phase: 'prd', openItemIds: ['q1', 'q2'] })
  assert.equal(stateFileIsCorrupt(id), false)
})

test('loadState coerces a numeric phase rather than refusing — phase is display-only', () => {
  writeRawState({ registered: true, phase: 7, openItemIds: [] })

  const state = loadState(id)
  assert.equal(state!.phase, '7', 'a display-only field is coerced, not failed closed on')
  assert.equal(stateFileIsCorrupt(id), false)
})

test('loadState coerces a numeric parentId rather than refusing — parentId is display-only', () => {
  writeRawState({ registered: true, phase: 'prd', openItemIds: [], parentId: 7 })

  assert.equal(loadState(id)!.parentId, '7')
})

test('a deferredQuestions entry whose references are malformed is corrupt', () => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(
    stateFilePath(id),
    JSON.stringify({
      registered: true,
      phase: 'impl',
      openItemIds: [],
      deferredQuestions: [
        {
          id: 'q1',
          lede: 'lede',
          body: '',
          recommend: 'do it',
          whyMine: 'scope',
          deferredAtPhase: 'impl',
          references: [{ kind: 'cites', itemId: 'i1' }],
        },
      ],
    })
  )

  assert.equal(loadState(id), null, 'an unknown reference kind is corrupt, same as a bad whyMine')
  assert.equal(stateFileIsCorrupt(id), true)
})
