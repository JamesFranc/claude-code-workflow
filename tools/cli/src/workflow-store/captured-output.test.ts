import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeCapturedOutput, TAIL_BYTES } from './captured-output.ts'
import { storePath, ticketScope } from './store.ts'

// writeCapturedOutput resolves through the durable store, which is homedir()-relative — override
// HOME so this test never touches the real ~/.claude/workflow-state (mirrors store.test.ts's
// isolation scheme).
let homeDir: string
let origHome: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'captured-output-test-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(homeDir, { recursive: true, force: true })
})

test('the tail never starts mid-character when the TAIL_BYTES cut lands inside a multi-byte UTF-8 sequence', () => {
  // '€' is 3 bytes in UTF-8 (0xe2 0x82 0xac). Placed so the cut at (totalBytes - TAIL_BYTES) lands
  // on its second byte, one byte into the sequence.
  const output = 'a'.repeat(500) + '€' + 'b'.repeat(TAIL_BYTES - 2)
  const result = writeCapturedOutput('FLOW-TEST', 'captures', 'label', 'sha123', output)
  assert.equal(
    result.tail.includes('�'),
    false,
    'a tail cut mid-sequence must advance to the next real character, not decode a stray ' +
      'replacement character'
  )
  assert.ok(
    result.tail.startsWith('b'),
    'the tail must begin with the first fully-intact character at or after the cut'
  )
})

test('writeCapturedOutput returns the sha256 of the output body, pinned to a known value — extraction preservation', () => {
  const result = writeCapturedOutput('FLOW-TEST', 'captures', 'label', 'sha123', 'hello world')
  assert.equal(
    result.outputSha256,
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  )
})

test('writeCapturedOutput counts outputBytes in UTF-8 bytes, not UTF-16 code units — extraction preservation', () => {
  // '€' is 1 UTF-16 code unit (String.length) but 3 UTF-8 bytes, so byte length and String.length
  // diverge for this input: length 6, byte length 8.
  const output = 'aaa' + '€' + 'bb'
  const result = writeCapturedOutput('FLOW-TEST', 'captures', 'label', 'sha123', output)
  assert.equal(
    output.length,
    6,
    'the input must diverge from its own byte length to prove anything'
  )
  assert.equal(result.outputBytes, 8)
})

test('writeCapturedOutput.truncated is exact at the TAIL_BYTES boundary — extraction preservation', () => {
  const atBoundary = writeCapturedOutput(
    'FLOW-TEST',
    'captures',
    'label',
    'sha123',
    'a'.repeat(TAIL_BYTES)
  )
  assert.equal(
    atBoundary.truncated,
    false,
    'exactly TAIL_BYTES bytes must not be reported as truncated'
  )
  const overBoundary = writeCapturedOutput(
    'FLOW-TEST',
    'captures',
    'label',
    'sha123',
    'a'.repeat(TAIL_BYTES + 1)
  )
  assert.equal(
    overBoundary.truncated,
    true,
    'one byte over TAIL_BYTES must be reported as truncated'
  )
})

test('writeCapturedOutput sanitizes the label into the output path exactly, `.` surviving and `/` not — extraction preservation', () => {
  const output = 'x'
  const outputSha256 = createHash('sha256').update(output).digest('hex')
  const expectedPath = storePath(
    ticketScope('FLOW-TEST'),
    `captures/my_label_v1.2__test_-sha123-${outputSha256}.out`
  )
  const result = writeCapturedOutput(
    'FLOW-TEST',
    'captures',
    'my/label:v1.2 (test)',
    'sha123',
    output
  )
  assert.equal(result.outputPath, expectedPath)
})
