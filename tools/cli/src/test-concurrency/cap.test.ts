import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CONCURRENCY_CEILING, capFor } from './cap.ts'

test('an 18-core host is bounded to the ceiling', () => {
  assert.equal(capFor(18), 4)
})

test('a 5-core host is bounded to the ceiling, the smallest host it binds on', () => {
  assert.equal(capFor(5), 4)
})

test('a 4-core host keeps Node default of three workers, below the ceiling', () => {
  assert.equal(capFor(4), 3)
})

test('a 2-core runner keeps one worker, the case a flat cap of four broke', () => {
  assert.equal(capFor(2), 1)
})

test('a single-core host gets one worker, never zero', () => {
  assert.equal(capFor(1), 1)
})

test('the ceiling is declared as four', () => {
  assert.equal(CONCURRENCY_CEILING, 4)
})
