import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitLines } from './split-lines.ts'

test('splits on LF', () => {
  assert.deepEqual(splitLines('a\nb\nc'), ['a', 'b', 'c'])
})

test('splits on CRLF as one delimiter, not as separate \\r and \\n delimiters', () => {
  assert.deepEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c'])
})

test('splits on bare CR', () => {
  assert.deepEqual(splitLines('a\rb\rc'), ['a', 'b', 'c'])
})

test('a file mixing all three line endings splits correctly throughout', () => {
  assert.deepEqual(splitLines('a\nb\r\nc\rd'), ['a', 'b', 'c', 'd'])
})

// A trailing line terminator produces a trailing empty element — the split is not popped or
// collapsed to the physical line count. fence-shape.ts's blank-line boundary check depends on this:
// a fenced region's last body line being '' requires this element to be present.
test('a trailing newline produces a trailing empty element, not a collapsed line count', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', ''])
})

test('no trailing newline produces no extra trailing empty element', () => {
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
})
