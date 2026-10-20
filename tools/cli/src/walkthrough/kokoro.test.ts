import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { narrateWithKokoro, wordAlignment, type SpokenWord } from './kokoro.ts'
import { TtsError } from './tts.ts'

const close = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${String(actual)} is not ${expected}`
  )

const closeAll = (actual: number[], expected: number[]) => {
  assert.equal(actual.length, expected.length)
  expected.forEach((value, i) => {
    close(actual[i], value)
  })
}

const fixture: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/kokoro-words.json', import.meta.url), 'utf-8')
)

const realRun = (): { narration: string; words: SpokenWord[] } => {
  assert.ok(typeof fixture === 'object' && fixture !== null)
  assert.ok('narration' in fixture && typeof fixture.narration === 'string')
  assert.ok('words' in fixture && Array.isArray(fixture.words))
  const words: SpokenWord[] = fixture.words.map((word: unknown) => {
    assert.ok(typeof word === 'object' && word !== null)
    assert.ok('text' in word && typeof word.text === 'string')
    assert.ok('start' in word && typeof word.start === 'number')
    assert.ok('end' in word && typeof word.end === 'number')
    return { text: word.text, start: word.start, end: word.end }
  })
  return { narration: fixture.narration, words }
}

test('wordAlignment: a real Kokoro run times every code point, never going backwards', () => {
  const { narration, words } = realRun()
  const alignment = wordAlignment(narration, words)
  assert.deepEqual(alignment.characters, [...narration])
  const starts = alignment.character_start_times_seconds
  const ends = alignment.character_end_times_seconds
  assert.equal(starts.length, alignment.characters.length)
  assert.equal(ends.length, alignment.characters.length)
  starts.forEach((start, i) => {
    const end = ends[i]
    assert.ok(end !== undefined && Number.isFinite(start) && Number.isFinite(end))
    assert.ok(start <= end, `entry ${i} ends before it starts`)
    assert.ok(i === 0 || start >= (ends[i - 1] ?? 0), `entry ${i} starts before entry ${i - 1}`)
  })
  close(ends.at(-1), Math.max(...words.map(({ end }) => end)))
})

test('wordAlignment: a word is spread over its own characters, gaps hold the last end, and the lead-in is 0', () => {
  const alignment = wordAlignment('  Hi, you', [
    { text: 'Hi', start: 0.2, end: 0.6 },
    { text: ',', start: 0.6, end: 0.7 },
    { text: 'you', start: 0.9, end: 1.2 },
  ])
  closeAll(alignment.character_start_times_seconds.slice(0, 3), [0, 0, 0.2])
  closeAll(alignment.character_end_times_seconds.slice(2, 4), [0.4, 0.6])
  close(alignment.character_start_times_seconds[5], 0.7)
  close(alignment.character_start_times_seconds[6], 0.9)
  close(alignment.character_end_times_seconds.at(-1), 1.2)
})

test('wordAlignment: a token not found in the text is skipped without losing the place of the next', () => {
  const alignment = wordAlignment('Call 3 workers', [
    { text: 'Call', start: 0, end: 0.4 },
    { text: 'three', start: 0.4, end: 0.8 },
    { text: 'workers', start: 0.8, end: 1.5 },
  ])
  close(alignment.character_start_times_seconds[5], 0.4)
  close(alignment.character_start_times_seconds[7], 0.8)
  close(alignment.character_end_times_seconds.at(-1), 1.5)
})

test('wordAlignment: an overlapping or empty word never moves time backwards', () => {
  const alignment = wordAlignment('ab cd', [
    { text: 'ab', start: 0, end: 1 },
    { text: '', start: 0.2, end: 0.3 },
    { text: 'cd', start: 0.5, end: 0.9 },
  ])
  assert.deepEqual(alignment.character_start_times_seconds, [0, 0.5, 1, 1, 1])
  assert.deepEqual(alignment.character_end_times_seconds.slice(3), [1, 1])
})

// Stand-ins for uv and ffmpeg on PATH: uv records its stdin and writes the audio and the word
// timings it is asked for; ffmpeg writes its last argument.
const withStubs = (
  words: string,
  uvExit: number,
  run: (dir: string, cacheDir: string) => void
): void => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-kokoro-test-'))
  const cacheDir = join(dir, 'cache')
  writeFileSync(
    join(dir, 'uv'),
    [
      '#!/bin/sh',
      `echo run >> "${dir}/uv-calls"`,
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --audio) audio="$2"; shift ;;',
      '    --words) words="$2"; shift ;;',
      '  esac',
      '  shift',
      'done',
      `cat > "${dir}/uv-stdin"`,
      `[ ${uvExit} -ne 0 ] && exit ${uvExit}`,
      ': > "$audio"',
      `printf '%s' '${words}' > "$words"`,
      '',
    ].join('\n')
  )
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nfor last; do :; done\nprintf mp3 > "$last"\n')
  chmodSync(join(dir, 'uv'), 0o755)
  chmodSync(join(dir, 'ffmpeg'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  try {
    run(dir, cacheDir)
  } finally {
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  }
}

const calls = (dir: string): number => {
  try {
    return readFileSync(join(dir, 'uv-calls'), 'utf-8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

test('narrateWithKokoro: speaks once with the text on stdin, then serves the same voice and text from the cache', () => {
  withStubs('[{"text":"Hi","start":0.1,"end":0.4}]', 0, (dir, cacheDir) => {
    const first = narrateWithKokoro('Hi', { voice: 'af_heart', cacheDir })
    const second = narrateWithKokoro('Hi', { voice: 'af_heart', cacheDir })
    const otherVoice = narrateWithKokoro('Hi', { voice: 'bf_emma', cacheDir })
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.equal(otherVoice.cached, false)
    assert.equal(calls(dir), 2)
    assert.equal(readFileSync(join(dir, 'uv-stdin'), 'utf-8'), 'Hi')
    assert.equal(readFileSync(second.audioFile, 'utf-8'), 'mp3')
    assert.deepEqual(second.alignment.characters, ['H', 'i'])
    closeAll(second.alignment.character_start_times_seconds, [0.1, 0.25])
    closeAll(second.alignment.character_end_times_seconds, [0.25, 0.4])
  })
})

test('narrateWithKokoro: a failed Kokoro run throws a TtsError and caches nothing', () => {
  withStubs('[]', 3, (_, cacheDir) => {
    assert.throws(
      () => narrateWithKokoro('Hi', { voice: 'af_heart', cacheDir }),
      new TtsError('Kokoro failed to voice the narration (exit 3)')
    )
    assert.deepEqual(readdirSync(join(cacheDir, '..')).includes('cache'), false)
  })
})

test('narrateWithKokoro: word timings that are not JSON, or not words, throw a TtsError and cache nothing', () => {
  for (const [words, message] of [
    ['[{"text":', 'Kokoro wrote word timings that are not JSON'],
    ['[{"text":"Hi"}]', 'Kokoro wrote word timings that are not a list of {text, start, end}'],
  ] as const) {
    withStubs(words, 0, (_, cacheDir) => {
      assert.throws(
        () => narrateWithKokoro('Hi', { voice: 'af_heart', cacheDir }),
        new TtsError(message)
      )
      assert.deepEqual(readdirSync(join(cacheDir, '..')).includes('cache'), false)
    })
  }
})

test('narrateWithKokoro: a run that returns no word timings throws a TtsError naming the voice and caches nothing', () => {
  withStubs('[]', 0, (_, cacheDir) => {
    assert.throws(
      () => narrateWithKokoro('Hola', { voice: 'ef_dora', cacheDir }),
      new TtsError(
        'Kokoro voice "ef_dora" returned no word timings; only American or British English ' +
          'voices (prefix a or b) give word timings'
      )
    )
    assert.deepEqual(readdirSync(join(cacheDir, '..')).includes('cache'), false)
  })
})
