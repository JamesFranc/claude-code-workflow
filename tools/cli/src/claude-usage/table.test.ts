import assert from 'node:assert/strict'
import { test } from 'node:test'

test('formatBorder and formatTableRow stay private to table.ts', async () => {
  const module = (await import('./table.ts')) as Record<string, unknown>
  assert.equal('formatBorder' in module, false)
  assert.equal('formatTableRow' in module, false)
})
