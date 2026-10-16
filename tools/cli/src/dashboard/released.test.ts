import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatReleasedEntry, formatReleasedItem, parseReleasedItems } from './released.ts'

test('formatReleasedItem: decision + response → "decision — response"', () => {
  const out = formatReleasedItem({
    id: 'i1',
    type: 'approval',
    decision: 'rejected',
    response: 'nope',
  })
  assert.equal(out, '[dashboard] item i1 (approval): rejected — nope')
})

test('formatReleasedItem: decision + response (approved) → "decision — response"', () => {
  const out = formatReleasedItem({
    id: 'i2',
    type: 'approval',
    decision: 'approved',
    response: 'ship it',
  })
  assert.equal(out, '[dashboard] item i2 (approval): approved — ship it')
})

test('formatReleasedItem: decision, no response → bare decision', () => {
  const out = formatReleasedItem({
    id: 'i3',
    type: 'approval',
    decision: 'approved',
  })
  assert.equal(out, '[dashboard] item i3 (approval): approved')
})

test('formatReleasedItem: no decision (question) → response is the whole detail', () => {
  const out = formatReleasedItem({
    id: 'i4',
    type: 'question',
    response: 'the answer',
  })
  assert.equal(out, '[dashboard] item i4 (question): the answer')
})

// ---------------------------------------------------------------------------
// parseReleasedItems
// ---------------------------------------------------------------------------

test('parseReleasedItems: valid array → the parsed items', () => {
  const items = parseReleasedItems('[{"id":"i1","type":"question","response":"yes"}]')
  assert.deepEqual(items, [{ id: 'i1', type: 'question', response: 'yes' }])
})

test('parseReleasedItems: empty array → []', () => {
  const items = parseReleasedItems('[]')
  assert.deepEqual(items, [])
})

test('parseReleasedItems: non-array JSON value → null', () => {
  const items = parseReleasedItems('{"error":"x"}')
  assert.equal(items, null)
})

test('parseReleasedItems: malformed/truncated JSON → null', () => {
  const items = parseReleasedItems('[{"id":"i1"')
  assert.equal(items, null)
})

// ---------------------------------------------------------------------------
// FLOW-406: outgoing references render as indented ↳ lines
// ---------------------------------------------------------------------------

test('formatReleasedItem: each outgoing reference follows as a ↳ line naming the other item', () => {
  const out = formatReleasedItem({
    id: 'c1',
    type: 'comment',
    response: 'why this order?',
    references: [
      {
        kind: 'related',
        item: { id: 'a1', type: 'approval', prompt: 'Ship it?\nDetail.', response: null },
      },
      { kind: 'answers', item: { id: 'q1', type: 'question', prompt: null, response: 'the ask' } },
      {
        kind: 'replaces',
        item: { id: 'w1', type: 'approval', prompt: 'Old plan', response: null },
      },
    ],
  })
  assert.equal(
    out,
    [
      '[dashboard] item c1 (comment): why this order?',
      '  ↳ related to item a1 (approval): Ship it?',
      '  ↳ answers item q1 (question): the ask',
      '  ↳ replaces item w1 (approval): Old plan',
    ].join('\n')
  )
})

test('formatReleasedItem: a reference preview stops at 120 characters', () => {
  const out = formatReleasedItem({
    id: 'c1',
    type: 'comment',
    response: 'x',
    references: [{ kind: 'related', item: { id: 'a1', type: 'info', prompt: 'é'.repeat(130) } }],
  })
  assert.equal(out.split('\n')[1], `  ↳ related to item a1 (info): ${'é'.repeat(120)}…`)
})

test('formatReleasedItem: a reference to a deleted item says it no longer exists', () => {
  const out = formatReleasedItem({
    id: 'c1',
    type: 'comment',
    response: 'x',
    references: [{ kind: 'related', item: null }],
  })
  assert.equal(out.split('\n')[1], '  ↳ related to an item that no longer exists')
})

test('formatReleasedEntry: a question ends with a line naming its consume command', () => {
  const out = formatReleasedEntry({ id: 'q1', type: 'question', response: 'yes' }, 'node-1')
  assert.equal(
    out,
    '[dashboard] item q1 (question): yes\n' +
      '  → act on it, then consume it: `dashboard item consume --item q1 --session node-1`'
  )
})

test('formatReleasedEntry: a comment names the board reply, then the consume', () => {
  const out = formatReleasedEntry({ id: 'c1', type: 'comment', response: 'hi' }, 'node-1')
  assert.equal(
    out,
    '[dashboard] item c1 (comment): hi\n' +
      '  → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      '`dashboard item add --type info --answers c1 --session node-1 --prompt "$(cat "<tmpfile>")"`' +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ' then consume it: `dashboard item consume --item c1 --session node-1`'
  )
})

test('formatReleasedEntry: the instruction follows the reference lines, so the first line is unchanged', () => {
  const out = formatReleasedEntry(
    {
      id: 'a1',
      type: 'approval',
      decision: 'rejected',
      response: 'no thanks',
      references: [{ kind: 'related', item: { id: 'q1', type: 'question', prompt: 'Ship?' } }],
    },
    'node-1'
  )
  assert.deepEqual(out.split('\n'), [
    '[dashboard] item a1 (approval): rejected — no thanks',
    '  ↳ related to item q1 (question): Ship?',
    '  → act on it, then consume it: `dashboard item consume --item a1 --session node-1`',
  ])
})
