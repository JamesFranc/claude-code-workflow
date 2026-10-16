import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fitLine, MAX_LINE_BYTES } from './line-budget.ts'

interface Event {
  id: string
  front: string
  end: string
}

interface ContentEvent {
  id: string
  content: string
}

const hasLoneSurrogate = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

test('fitLine keeps the END of a keep:"end" field and the FRONT of a keep:"front" field once shrunk', () => {
  // Unique markers at the surviving edge, not a repeating pattern — a periodic body would make a
  // front slice and an end slice byte-identical at some shrink step, silently passing a swapped rule.
  const event: Event = {
    id: 'fixed-id',
    front: `FRONT-MARKER${'a'.repeat(9_000)}`,
    end: `${'b'.repeat(9_000)}END-MARKER`,
  }
  const { line, shrunkFields } = fitLine(
    event,
    [
      { name: 'front', keep: 'front' },
      { name: 'end', keep: 'end' },
    ],
    'test-label'
  )
  const shrunk = JSON.parse(line) as Event & { lineTruncated: true }
  assert.ok(shrunk.front.startsWith('FRONT-MARKER'), 'the front field must keep its own front')
  assert.ok(shrunk.end.endsWith('END-MARKER'), 'the end field must keep its own end')
  assert.equal(shrunk.lineTruncated, true)
  assert.deepEqual(
    [...shrunkFields].sort(),
    ['end', 'front'],
    'both shrunk fields must be reported by name — a caller cannot surface a loss it is not told about'
  )
})

test('fitLine reports only the field it actually shrank when the other free-text field never needed to move', () => {
  const event: Event = {
    id: 'fixed-id',
    front: 'short and well within budget',
    end: `${'e'.repeat(9_000)}END-MARKER`,
  }
  const { shrunkFields } = fitLine(
    event,
    [
      { name: 'front', keep: 'front' },
      { name: 'end', keep: 'end' },
    ],
    'test-label'
  )
  assert.deepEqual(shrunkFields, ['end'], 'a field that never moved must not be reported as shrunk')
})

test('fitLine never leaves a lone surrogate when the halved cut lands mid-pair, keep:"end"', () => {
  const astral = String.fromCodePoint(0x1f600)
  const value = 'a'.repeat(3999) + astral + 'b'.repeat(3999)
  const event: ContentEvent = { id: 'fixed-id', content: value }
  const { line } = fitLine(event, [{ name: 'content', keep: 'end' }], 'test-label')
  const parsed = JSON.parse(line) as ContentEvent
  assert.equal(
    hasLoneSurrogate(parsed.content),
    false,
    'a halved cut that lands between a surrogate pair must drop the whole pair, not split it'
  )
})

test('fitLine never leaves a lone surrogate when the halved cut lands mid-pair, keep:"front"', () => {
  const astral = String.fromCodePoint(0x1f600)
  const value = 'a'.repeat(3999) + astral + 'b'.repeat(3999)
  const event: ContentEvent = { id: 'fixed-id', content: value }
  const { line } = fitLine(event, [{ name: 'content', keep: 'front' }], 'test-label')
  const parsed = JSON.parse(line) as ContentEvent
  assert.equal(
    hasLoneSurrogate(parsed.content),
    false,
    'a halved cut that lands between a surrogate pair must drop the whole pair, not split it'
  )
})

test('fitLine throws naming the caller-supplied label when identifiers alone are over budget — extraction preservation', () => {
  const event: ContentEvent = { id: 'x'.repeat(5000), content: 'y'.repeat(100) }
  assert.throws(
    () => fitLine(event, [{ name: 'content', keep: 'front' }], 'gate-ledger'),
    {
      message: `gate-ledger: event cannot fit in ${MAX_LINE_BYTES} bytes even with free text removed`,
    },
    'the throw message must carry the label passed in, not a fixed string — gate-ledger used to own ' +
      'this literal before the extraction moved it behind a parameter'
  )
})
