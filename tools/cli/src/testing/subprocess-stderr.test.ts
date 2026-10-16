import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stderrBeyondNodeWarnings } from './subprocess-stderr.ts'

test('a bracketed Node warning is stripped and real CLI output survives', () => {
  const stderr = [
    '(node:34069) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true',
    '(Use `node --trace-warnings ...` to show where the warning was created)',
    '(node:34069) ExperimentalWarning: Transform Types is an experimental feature',
    'dashboard: no such item',
  ].join('\n')

  assert.equal(stderrBeyondNodeWarnings(stderr), 'dashboard: no such item')
})
