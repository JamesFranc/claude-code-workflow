import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SPEED,
  VoiceError,
  readCached,
  writeCacheEntry,
  type Alignment,
  type Narration,
  type Voice,
} from './voice.ts'

export interface SpokenWord {
  text: string
  start: number
  end: number
}

export interface KokoroOptions {
  voice: string
  cacheDir: string
}

export const DEFAULT_KOKORO_VOICE = 'af_heart'
export const KOKORO_PACKAGES = ['kokoro==0.9.4', 'soundfile==0.14.0']
const PYTHON = '3.12'
const SPEAK_SCRIPT = fileURLToPath(new URL('./kokoro-speak.py', import.meta.url))
// Child processes write to our stderr, so stdout carries only the JSON summary.
const STDERR = 2
const MISSING_TOOL_EXIT = 2

export const narrateWithKokoro = (text: string, options: KokoroOptions): Narration => {
  const key = createHash('sha256')
    .update(['kokoro', ...KOKORO_PACKAGES, options.voice, SPEED, text].join('\n'))
    .digest('hex')
  const audioFile = join(options.cacheDir, `${key}.mp3`)
  const entryFile = join(options.cacheDir, `${key}.json`)
  const cached = readCached(entryFile, audioFile)
  if (cached !== undefined) {
    return { audioFile, alignment: cached, cached: true }
  }

  const words = speak(text, options.voice, (mp3) => {
    mkdirSync(options.cacheDir, { recursive: true })
    copyFileSync(mp3, audioFile)
  })
  const alignment = wordAlignment(text, words)
  writeCacheEntry(entryFile, key, alignment)
  return { audioFile, alignment, cached: false }
}

// A token that is not found verbatim in the text is skipped; every character outside a found word
// holds the time the last found word ended, so cues still resolve.
export const wordAlignment = (text: string, words: SpokenWord[]): Alignment => {
  const characters = [...text]
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  let from = 0
  const holdUntil = (index: number): void => {
    while (starts.length < index) {
      starts.push(at)
      ends.push(at)
    }
  }
  for (const word of words) {
    const spelled = [...word.text]
    const index = spelled.length === 0 ? undefined : indexOf(characters, spelled, from)
    if (index !== undefined) {
      holdUntil(index)
      const start = Math.max(word.start, at)
      const step = (Math.max(word.end, start) - start) / spelled.length
      spelled.forEach((_, i) => {
        starts.push(start + step * i)
        ends.push(start + step * (i + 1))
      })
      at = start + step * spelled.length
      from = index + spelled.length
    }
  }
  holdUntil(characters.length)
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }
}

// Runs in a scratch directory, so a failed run leaves nothing in the cache.
const speak = (text: string, voice: string, keep: (mp3: string) => void): SpokenWord[] => {
  const workDir = mkdtempSync(join(tmpdir(), 'walkthrough-kokoro-'))
  try {
    const wav = join(workDir, 'speech.wav')
    const mp3 = join(workDir, 'speech.mp3')
    const wordsFile = join(workDir, 'words.json')
    run(
      'Kokoro',
      'uv',
      [
        'run',
        '--no-project',
        '--python',
        PYTHON,
        ...KOKORO_PACKAGES.flatMap((pin) => ['--with', pin]),
        'python',
        SPEAK_SCRIPT,
        '--voice',
        voice,
        '--speed',
        String(SPEED),
        '--audio',
        wav,
        '--words',
        wordsFile,
      ],
      text
    )
    run('ffmpeg', 'ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-q:a', '4', mp3])
    const words = readWords(wordsFile)
    if (words.length === 0 && text.trim() !== '') {
      throw new VoiceError(
        `Kokoro voice "${voice}" returned no word timings; only American or British English ` +
          'voices (prefix a or b) give word timings'
      )
    }
    keep(mp3)
    return words
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

const run = (name: string, command: string, args: string[], input?: string): void => {
  const result = spawnSync(command, args, { input, stdio: ['pipe', STDERR, STDERR] })
  if (result.status !== 0) {
    const why = result.error?.message ?? result.signal ?? `exit ${String(result.status)}`
    throw new VoiceError(`${name} failed to voice the narration (${why})`)
  }
}

const readWords = (file: string): SpokenWord[] => {
  let words: unknown
  try {
    words = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err
    }
    throw new VoiceError('Kokoro wrote word timings that are not JSON')
  }
  if (!isSpokenWords(words)) {
    throw new VoiceError('Kokoro wrote word timings that are not a list of {text, start, end}')
  }
  return words
}

const indexOf = (characters: string[], word: string[], from: number): number | undefined => {
  for (let start = from; start + word.length <= characters.length; start++) {
    if (word.every((character, i) => characters[start + i] === character)) {
      return start
    }
  }
  return undefined
}

const isSpokenWords = (value: unknown): value is SpokenWord[] =>
  Array.isArray(value) && value.every(isSpokenWord)

const isSpokenWord = (value: unknown): value is SpokenWord =>
  typeof value === 'object' &&
  value !== null &&
  'text' in value &&
  typeof value.text === 'string' &&
  'start' in value &&
  typeof value.start === 'number' &&
  Number.isFinite(value.start) &&
  'end' in value &&
  typeof value.end === 'number' &&
  Number.isFinite(value.end)

const uvRuns = (): boolean => spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0

export const kokoro: Voice = {
  name: 'kokoro',
  chargedPerCharacter: false,
  envProblem: () => undefined,
  preflight: () =>
    uvRuns()
      ? undefined
      : {
          message:
            'walkthrough: WALKTHROUGH_VOICE=kokoro needs uv on PATH; install it (brew install uv).',
          exitCode: MISSING_TOOL_EXIT,
        },
  narrator: (env) => {
    const voice = env.KOKORO_VOICE || DEFAULT_KOKORO_VOICE
    return async (text, _cues, cacheDir) => narrateWithKokoro(text, { voice, cacheDir })
  },
}
