import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MacVoiceError,
  alignmentOf,
  macVoiceProblem,
  narrateWithMacVoice,
  voicesOf,
} from './mac-voice.ts'

const TESTER_LINE = 'Tester              en_US    # Hello! My name is Tester.'

test('alignmentOf spreads each segment evenly', () => {
  assert.deepEqual(alignmentOf('abcd', [{ index: 2, at: 1 }], 3), {
    characters: ['a', 'b', 'c', 'd'],
    character_start_times_seconds: [0, 0.5, 1, 2],
    character_end_times_seconds: [0.5, 1, 2, 3],
  })
})

test('alignmentOf never runs time backwards', () => {
  const result = alignmentOf(
    'abc',
    [
      { index: 1, at: 2 },
      { index: 2, at: 1 },
    ],
    1.5
  )
  assert.deepEqual(result.character_start_times_seconds, [0, 1.5, 1.5])
  assert.deepEqual(result.character_end_times_seconds, [1.5, 1.5, 1.5])
})

test('alignmentOf with a cue at the start', () => {
  const result = alignmentOf('ab', [{ index: 0, at: 0 }], 2)
  assert.deepEqual(result.character_start_times_seconds, [0, 1])
  assert.deepEqual(result.character_end_times_seconds, [1, 2])
})

test('voicesOf reads names with spaces and parentheses', () => {
  const listing = [
    'Bad News            en_US    # Hello! My name is Bad News.',
    'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    '',
  ].join('\n')
  assert.deepEqual(voicesOf(listing), ['Bad News', 'Eddy (English (UK))', 'Samantha'])
})

test('voicesOf reads a voice whose locale has subdivision subtags', () => {
  const listing = [
    'Fiona               en_GB-u-sd-gbsct # Hello! My name is Fiona.',
    'Majed               ar_001   # Hello! My name is Majed.',
    '',
  ].join('\n')
  assert.deepEqual(voicesOf(listing), ['Fiona', 'Majed'])
})

test('narrateWithMacVoice times each cue by its prefix and caches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-voice-test-'))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, 'bin')
    stubs(bin, dir, true)
    process.env.PATH = `${bin}:${savedPath}`
    const cacheDir = join(dir, 'cache')
    const sayCalls = (): number =>
      readFileSync(join(dir, 'say-calls'), 'utf-8').trim().split('\n').length

    const text = 'Hello. The client calls.'
    const first = narrateWithMacVoice(text, ['The client'], { voice: 'Tester', cacheDir })
    assert.equal(first.cached, false)
    assert.equal(first.alignment.character_start_times_seconds[7], 7)
    assert.equal(first.alignment.character_end_times_seconds.at(-1), 24)
    assert.equal(sayCalls(), 2)
    assert.equal(readFileSync(first.audioFile, 'utf-8'), text)
    assert.ok(readdirSync(cacheDir).some((f) => f.endsWith('.m4a')))

    const second = narrateWithMacVoice(text, ['The client'], { voice: 'Tester', cacheDir })
    assert.equal(second.cached, true)
    assert.deepEqual(second.alignment, first.alignment)
    assert.equal(sayCalls(), 2)

    const third = narrateWithMacVoice(text, [], { voice: 'Tester', cacheDir })
    assert.equal(third.cached, false)
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('narrateWithMacVoice reports a say or ffprobe that cannot be run as a MacVoiceError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-voice-test-'))
  const savedPath = process.env.PATH
  try {
    const text = 'Hello. The client calls.'

    const noProbe = join(dir, 'no-probe')
    stubs(noProbe, dir, false)
    process.env.PATH = noProbe
    assert.throws(
      () =>
        narrateWithMacVoice(text, ['The client'], { voice: 'Tester', cacheDir: join(dir, 'c1') }),
      (err: unknown) =>
        err instanceof MacVoiceError && err.message.startsWith('ffprobe could not be run')
    )

    const noSay = join(dir, 'no-say')
    stubs(noSay, dir, true, false)
    process.env.PATH = noSay
    assert.throws(
      () =>
        narrateWithMacVoice(text, ['The client'], { voice: 'Tester', cacheDir: join(dir, 'c2') }),
      (err: unknown) =>
        err instanceof MacVoiceError && err.message.startsWith('say could not be run')
    )
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('macVoiceProblem names what is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-voice-test-'))
  const savedPath = process.env.PATH
  try {
    const full = join(dir, 'full')
    stubs(full, dir, true)
    process.env.PATH = full
    assert.equal(macVoiceProblem('Tester'), undefined)
    assert.deepEqual(macVoiceProblem('Nobody'), {
      exitCode: 1,
      message:
        'walkthrough: WALKTHROUGH_MAC_VOICE names "Nobody", which is not an installed voice; ' +
        "say -v '?' lists them.",
    })

    const empty = join(dir, 'empty')
    mkdirSync(empty)
    process.env.PATH = empty
    assert.deepEqual(macVoiceProblem('Tester'), {
      exitCode: 2,
      message:
        'walkthrough: WALKTHROUGH_MAC_VOICE is set, but say cannot be run; macOS voices need macOS.',
    })

    const noProbe = join(dir, 'no-probe')
    stubs(noProbe, dir, false)
    process.env.PATH = noProbe
    assert.deepEqual(macVoiceProblem('Tester'), {
      exitCode: 2,
      message: 'walkthrough: ffprobe cannot be run; it comes with ffmpeg (brew install ffmpeg).',
    })
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('macVoiceProblem reports a say that exits nonzero by its status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-voice-test-'))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, 'bin')
    stubs(bin, dir, true)
    writeFileSync(join(bin, 'say'), '#!/bin/sh\nexit 3\n')
    process.env.PATH = bin
    assert.deepEqual(macVoiceProblem('Tester'), {
      exitCode: 2,
      message: "walkthrough: say -v '?' exited with status 3.",
    })
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('macVoiceProblem reports an ffprobe that exits nonzero by its status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-voice-test-'))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, 'bin')
    stubs(bin, dir, true)
    writeFileSync(join(bin, 'ffprobe'), '#!/bin/sh\nexit 4\n')
    process.env.PATH = bin
    assert.deepEqual(macVoiceProblem('Tester'), {
      exitCode: 2,
      message: 'walkthrough: ffprobe -version exited with status 4.',
    })
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('macVoiceProblem reports a say that cannot be spawned by its error code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-voice-test-'))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, 'bin')
    mkdirSync(join(bin, 'say'), { recursive: true })
    process.env.PATH = bin
    assert.deepEqual(macVoiceProblem('Tester'), {
      exitCode: 2,
      message: "walkthrough: say -v '?' could not be run (EACCES).",
    })
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

// Stand-ins for `say` (copies stdin to its -o file) and `ffprobe` (one second per byte), each
// optional.
const stubs = (bin: string, dir: string, withFfprobe: boolean, withSay = true): void => {
  mkdirSync(bin, { recursive: true })

  if (withSay) {
    writeFileSync(
      join(bin, 'say'),
      `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' '${TESTER_LINE}'; exit 0; }
echo call >> "${dir}/say-calls"
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
/bin/cat > "$out"
`
    )
    chmodSync(join(bin, 'say'), 0o755)
  }

  if (withFfprobe) {
    writeFileSync(
      join(bin, 'ffprobe'),
      `#!/bin/sh
[ "$1" = -version ] && exit 0
for last; do :; done
wc -c < "$last" | tr -d ' '
`
    )
    chmodSync(join(bin, 'ffprobe'), 0o755)
  }
}
