import type { Alignment } from './tts.ts'

// A walkthrough with no voice is read rather than heard (FLOW-423): its timing comes from a reading
// pace instead of a spoken alignment, and its narration is shown as captions.

export interface Caption {
  text: string
  // When the caption appears and disappears, relative to the scene's start.
  at: number
  until: number
}

// Characters read per second, a little slower than the voice speaks, since reading competes with
// watching the diagram.
export const READING_PACE = 15
// Extra time after a sentence ends, before the next one starts.
export const SENTENCE_PAUSE = 0.4
// The most characters a caption holds: two lines of the caption band.
export const CAPTION_LENGTH = 140

interface Span {
  // Code-point indices into the narration; `end` is exclusive.
  start: number
  end: number
}

// An alignment in the shape a voice returns, one entry per code point, that reads `text` at
// READING_PACE and pauses after each sentence.
export const readingAlignment = (text: string): Alignment => {
  const characters = [...text]
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  characters.forEach((_, i) => {
    starts.push(at)
    at += 1 / READING_PACE
    ends.push(at)
    if (endsSentence(characters, i)) {
      at += SENTENCE_PAUSE
    }
  })
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }
}

// The narration's captions, each shown from its first character until the next caption starts; the
// last stays up until the scene ends.
export const captionsOf = (text: string, alignment: Alignment, duration: number): Caption[] => {
  const characters = [...text]
  const spans = captionSpans(characters)
  const startOf = (span: Span | undefined): number | undefined =>
    span === undefined ? undefined : alignment.character_start_times_seconds[span.start]
  return spans.map((span, i) => ({
    text: characters.slice(span.start, span.end).join(''),
    at: startOf(span) ?? 0,
    until: startOf(spans[i + 1]) ?? duration,
  }))
}

// Cuts the narration into captions of at most CAPTION_LENGTH characters. A sentence end closes a
// caption; a caption that would overflow is cut after its last clause punctuation, or else
// between words.
const captionSpans = (characters: string[]): Span[] => {
  const spans: Span[] = []
  let words: Span[] = []
  const close = (count: number) => {
    const first = words[0]
    const last = words[count - 1]
    if (first !== undefined && last !== undefined) {
      spans.push({ start: first.start, end: last.end })
    }
    words = words.slice(count)
  }
  for (const word of wordsOf(characters)) {
    while (words.length > 0 && spanLength([...words, word]) > CAPTION_LENGTH) {
      close(clauseBreak(words, characters) ?? words.length)
    }
    words.push(word)
    if (endsSentence(characters, word.end - 1)) {
      close(words.length)
    }
  }
  close(words.length)
  return spans
}

// Each run of non-whitespace, a run longer than CAPTION_LENGTH split into pieces that fit.
const wordsOf = (characters: string[]): Span[] => {
  const words: Span[] = []
  let start: number | undefined
  characters.forEach((character, i) => {
    if (/\s/.test(character)) {
      if (start !== undefined) {
        words.push({ start, end: i })
      }
      start = undefined
    } else {
      start ??= i
    }
  })
  if (start !== undefined) {
    words.push({ start, end: characters.length })
  }
  return words.flatMap(fitting)
}

const fitting = (word: Span): Span[] =>
  Array.from({ length: Math.ceil((word.end - word.start) / CAPTION_LENGTH) }, (_, i) => ({
    start: word.start + i * CAPTION_LENGTH,
    end: Math.min(word.end, word.start + (i + 1) * CAPTION_LENGTH),
  }))

const spanLength = (words: Span[]): number => (words.at(-1)?.end ?? 0) - (words[0]?.start ?? 0)

// How many of `words` to keep in the caption so that it ends at clause punctuation, or undefined
// when none of them ends one.
const clauseBreak = (words: Span[], characters: string[]): number | undefined => {
  for (let count = words.length; count > 0; count--) {
    const word = words[count - 1]
    if (word !== undefined && /[,;:]/.test(characters[word.end - 1] ?? '')) {
      return count
    }
  }
  return undefined
}

const endsSentence = (characters: string[], i: number): boolean =>
  /[.!?]/.test(characters[i] ?? '') &&
  (i + 1 === characters.length || /\s/.test(characters[i + 1] ?? ''))
