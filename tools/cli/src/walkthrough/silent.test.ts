import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPTION_LENGTH,
  READING_PACE,
  SENTENCE_PAUSE,
  captionsOf,
  readingAlignment,
} from './silent.ts'

const close = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${String(actual)} is not ${expected}`
  )

test('readingAlignment: one entry per code point at the reading pace, pausing after a sentence', () => {
  const alignment = readingAlignment('Hi. 🚀 go.')
  assert.deepEqual(alignment.characters, [...'Hi. 🚀 go.'])
  close(alignment.character_start_times_seconds[3], 3 / READING_PACE + SENTENCE_PAUSE)
  close(alignment.character_end_times_seconds.at(-1), 9 / READING_PACE + SENTENCE_PAUSE)
})

test('readingAlignment: a full stop inside a word does not pause', () => {
  const alignment = readingAlignment('v1.2 ok')
  close(alignment.character_start_times_seconds[3], 3 / READING_PACE)
})

test('captionsOf: one caption per sentence, each up until the next one starts', () => {
  const text = 'First one. Then two.'
  const alignment = readingAlignment(text)
  const captions = captionsOf(text, alignment, 9)
  assert.deepEqual(
    captions.map(({ text }) => text),
    ['First one.', 'Then two.']
  )
  assert.equal(captions[0]?.at, 0)
  assert.equal(captions[0]?.until, alignment.character_start_times_seconds[11])
  assert.equal(captions[1]?.at, alignment.character_start_times_seconds[11])
  assert.equal(captions[1]?.until, 9)
})

test('captionsOf: a long sentence is cut after its last clause punctuation that fits', () => {
  const clause = 'word '.repeat(20).trim()
  const text = `${clause}, ${clause}; ${clause}.`
  const captions = captionsOf(text, readingAlignment(text), 1)
  assert.deepEqual(
    captions.map(({ text }) => text),
    [`${clause},`, `${clause};`, `${clause}.`]
  )
})

test('captionsOf: a long run with no punctuation is cut between words, none over the limit', () => {
  const text = 'word '.repeat(80).trim()
  const captions = captionsOf(text, readingAlignment(text), 1)
  assert.ok(captions.length > 1)
  for (const { text: caption } of captions) {
    assert.ok([...caption].length <= CAPTION_LENGTH, `${[...caption].length} > ${CAPTION_LENGTH}`)
    assert.doesNotMatch(caption, /^\s|\s$/)
  }
  assert.equal(captions.map(({ text }) => text).join(' '), text)
})

test('captionsOf: a run with no whitespace longer than the limit is split, losing nothing', () => {
  const text = `see ${'x'.repeat(CAPTION_LENGTH * 2 + 10)} end.`
  const captions = captionsOf(text, readingAlignment(text), 1)
  for (const { text: caption } of captions) {
    assert.ok([...caption].length <= CAPTION_LENGTH, `${[...caption].length} > ${CAPTION_LENGTH}`)
  }
  assert.equal(
    captions
      .map(({ text }) => text)
      .join('')
      .replaceAll(' ', ''),
    text.replaceAll(' ', '')
  )
})
