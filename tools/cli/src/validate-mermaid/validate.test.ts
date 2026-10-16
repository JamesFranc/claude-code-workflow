import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateMermaid } from './validate.ts'

test('validateMermaid: accepts a valid flowchart', async () => {
  const result = await validateMermaid('graph TD\n  A[Start] --> B[End]')
  assert.equal(result.valid, true)
})

test('validateMermaid: rejects a flowchart with a dangling arrow', async () => {
  const result = await validateMermaid('graph TD\n  A[Start] -->')
  assert.equal(result.valid, false)
  assert.ok((result.error ?? '').length > 0)
})

// A global `window` sends @terrastruct/d2 down its browser path, and its renderer never starts.
test('validateMermaid: leaves no window or document on globalThis', async () => {
  await validateMermaid('graph TD\n  A --> B')
  assert.equal('window' in globalThis, false)
  assert.equal('document' in globalThis, false)
})
