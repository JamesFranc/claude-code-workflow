import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatChanges } from './format.ts'

test('MERGE_READY and CI_GREEN_ON_DRAFT each carry a line naming the approval to post', () => {
  const out = formatChanges('7', 'acme/widget', [
    { type: 'CI_GREEN_ON_DRAFT', detail: 'CI green on draft PR' },
    { type: 'MERGE_READY', detail: 'PR is ready to merge' },
  ])
  assert.equal(
    out,
    [
      '[pr-monitor] changes detected on acme/widget#7',
      '',
      '  [CI_GREEN_ON_DRAFT] CI green on draft PR',
      '    → run the PR Lifecycle CI_GREEN_ON_DRAFT handler (flush the deferred queue, check for open questions); it ends in a `dashboard item add --type approval` flip-to-ready item, never an info note. Withdraw any note already posted for it.',
      '  [MERGE_READY] PR is ready to merge',
      '    → run the PR Lifecycle MERGE_READY handler (flush the deferred queue, check for open questions, move the ticket to review, look up approvers); it ends in a `dashboard item add --type approval` merge item, never an info note. Withdraw any note already posted for it.',
    ].join('\n')
  )
})

test('a change with no approval handler prints only its own line', () => {
  const out = formatChanges('7', 'acme/widget', [{ type: 'MERGE_CONFLICT', detail: 'conflicts' }])
  assert.equal(
    out,
    '[pr-monitor] changes detected on acme/widget#7\n\n  [MERGE_CONFLICT] conflicts'
  )
})
