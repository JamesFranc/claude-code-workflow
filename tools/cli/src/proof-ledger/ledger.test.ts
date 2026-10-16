import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  appendProofCapture,
  capturesFor,
  captureId,
  proofLedgerPath,
  readProofLedger,
} from './ledger.ts'
import { appendLine, StoreUnreadableError } from '../workflow-store/store.ts'

let ticket: string
let homeDir: string
let origHome: string | undefined

// readProofLedger/appendProofCapture resolve through the durable store, which is homedir()-relative
// — override HOME so these tests never touch the real ~/.claude/workflow-state (mirrors
// gate-ledger/ledger.test.ts's isolation scheme).
beforeEach(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'proof-ledger-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `FLOW-TEST-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'proof-ledger-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const baseEvent = (overrides: Partial<Parameters<typeof appendProofCapture>[1]> = {}) => ({
  kind: 'proof-capture' as const,
  at: new Date().toISOString(),
  id: 'fixed-id',
  task: 'task-1',
  capture: 'evidence' as const,
  sha: 'aaa0001',
  command: 'pnpm typecheck',
  exitStatus: 0,
  outputPath: '/tmp/does-not-matter.out',
  outputSha256: 'a'.repeat(64),
  outputBytes: 100,
  tail: 'ok',
  ...overrides,
})

test('a corrupt line in the ledger is counted in skippedLines and does not throw', () => {
  appendProofCapture(ticket, baseEvent())
  appendLine(proofLedgerPath(ticket), 'not-json-at-all{{{')

  const ledger = readProofLedger(ticket)
  assert.equal(ledger.skippedLines, 1, 'the corrupt line is counted')
  assert.equal(ledger.captures.length, 1, 'the one valid capture still folds in')
})

test('captureId returns the same id for identical inputs and a different id when ONLY outputSha256 differs', () => {
  const first = captureId('task-1', 'evidence', 'aaa0001', 'pnpm typecheck', 'a'.repeat(64))
  const repeat = captureId('task-1', 'evidence', 'aaa0001', 'pnpm typecheck', 'a'.repeat(64))
  const differentOutput = captureId(
    'task-1',
    'evidence',
    'aaa0001',
    'pnpm typecheck',
    'b'.repeat(64)
  )
  assert.equal(first, repeat, 'identical inputs must produce the same id')
  assert.notEqual(first, differentOutput, 'a different outputSha256 alone must change the id')
})

test('capturesFor filters on all three of task, capture and sha — excludes a capture matching only two of the three', () => {
  appendProofCapture(
    ticket,
    baseEvent({ id: 'a', task: 'task-1', capture: 'evidence', sha: 'aaa0001' })
  )
  appendProofCapture(
    ticket,
    baseEvent({ id: 'b', task: 'task-1', capture: 'evidence', sha: 'aaa0002' })
  )
  appendProofCapture(
    ticket,
    baseEvent({ id: 'c', task: 'task-1', capture: 'sweep', sha: 'aaa0001' })
  )
  appendProofCapture(
    ticket,
    baseEvent({ id: 'd', task: 'task-2', capture: 'evidence', sha: 'aaa0001' })
  )

  const ledger = readProofLedger(ticket)
  const matches = capturesFor(ledger, 'task-1', 'evidence', 'aaa0001')
  assert.equal(matches.length, 1, 'only the capture matching all three fields must be returned')
  assert.equal(matches[0]!.id, 'a')
})

// --- An unreadable proof ledger is not an empty one (FLOW-226) ---
//
// A DIRECTORY at the ledger path: readFileSync fails with EISDIR for every uid including root, so
// this is not vacuous under a root test runner the way a chmod 000 file would be.
test('readProofLedger throws rather than reporting an unreadable ledger as zero captures', () => {
  const path = proofLedgerPath(ticket)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(path, { recursive: true })
  assert.throws(
    () => readFileSync(path, 'utf-8'),
    /EISDIR/,
    'precondition: the planted path must actually be unreadable'
  )

  assert.throws(
    () => readProofLedger(ticket),
    (error: unknown) =>
      error instanceof StoreUnreadableError &&
      error.code === 'EISDIR' &&
      error.message.includes(path),
    'an unreadable proof ledger must raise, not fold into the no-captures path'
  )
})

test('a readable proof ledger reads exactly as before: same captures, same order', () => {
  appendProofCapture(ticket, {
    kind: 'proof-capture',
    at: '2026-01-01T00:00:00.000Z',
    id: captureId('task-a', 'evidence', 'c'.repeat(40), 'cmd', 'd'.repeat(64)),
    task: 'task-a',
    capture: 'evidence',
    sha: 'c'.repeat(40),
    command: 'cmd',
    exitStatus: 0,
    outputPath: '/tmp/o.out',
    outputSha256: 'd'.repeat(64),
    outputBytes: 2,
    tail: 'ok\n',
  })

  const ledger = readProofLedger(ticket)
  assert.equal(ledger.captures.length, 1)
  assert.equal(ledger.captures[0]!.task, 'task-a')
  assert.equal(ledger.captures[0]!.capture, 'evidence')
  assert.equal(ledger.skippedLines, 0)
})
