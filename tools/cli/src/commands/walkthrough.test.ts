import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'
import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'
import { SCENE_TAIL } from '../walkthrough/compose.ts'
import { runWalkthroughRender } from '../walkthrough/main.ts'
import { readingAlignment } from '../walkthrough/silent.ts'
import { DEFAULT_VOICE_ID } from '../walkthrough/tts.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const runCli = (env: NodeJS.ProcessEnv, dir: string) =>
  spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      mainTsPath,
      'walkthrough',
      'render',
      '--script',
      join(dir, 's.json'),
      '--out',
      join(dir, 'o.mp4'),
    ],
    { encoding: 'utf8', timeout: 60_000, env }
  )

test('CLI: walkthrough render exits 2 when ffmpeg is not on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  try {
    const result = runCli({ ...process.env, ELEVEN_LABS_API_KEY: 'k', PATH: dir }, dir)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(
      stderrBeyondNodeWarnings(result.stderr),
      'walkthrough: ffmpeg is not on PATH; install it (brew install ffmpeg).'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: an invalid script is rejected before any ElevenLabs request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  let requests = 0
  const server = createServer((_, res) => {
    requests++
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  // A stand-in ffmpeg, so the check before validation passes on a host without one.
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'ffmpeg'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const script = join(dir, 's.json')
  writeFileSync(
    script,
    JSON.stringify({
      title: 'T',
      palette: 'classic',
      scenes: [
        { heading: 'A', narration: 'Voiced first.', visual: { kind: 'title' } },
        {
          heading: 'B',
          narration: 'The client calls.',
          visual: { kind: 'diagram', d2: '*: {class: tool}\nclient -> server' },
          steps: [{ cue: 'The client', show: ['database'] }],
        },
      ],
    })
  )
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    await runWalkthroughRender(script, join(dir, 'o.mp4'), {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      apiBase: `http://127.0.0.1:${port}`,
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.equal(requests, 0)
    assert.deepEqual(stdout, [])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [
        [
          `${script}: scenes[1].steps[0].show: "database" is not in the diagram ` +
            '(ids: client, server, (client -> server)[0])',
        ],
      ]
    )
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: an ElevenLabs reply that is not JSON is reported against ElevenLabs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>maintenance</html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'ffmpeg'), 0o755)
  writeFileSync(join(dir, 'npx'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'npx'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const script = join(dir, 's.json')
  writeFileSync(
    script,
    JSON.stringify({
      title: 'T',
      palette: 'classic',
      scenes: [{ heading: 'A', narration: 'Hello.', visual: { kind: 'title' } }],
    })
  )
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    await runWalkthroughRender(script, join(dir, 'o.mp4'), {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      apiBase: `http://127.0.0.1:${port}`,
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(stdout, [])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [[`${script}: ElevenLabs returned a reply that is not JSON`]]
    )
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: a script path that cannot be read is reported as an invalid script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'ffmpeg'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    await runWalkthroughRender(dir, join(dir, 'o.mp4'), {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(stdout, [])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [[`${dir}: cannot read the script: EISDIR: illegal operation on a directory, read`]]
    )
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: walkthrough render exits 2 naming the signal when ffmpeg is killed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  try {
    writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nkill -ABRT $$\n')
    chmodSync(join(dir, 'ffmpeg'), 0o755)
    const result = runCli({ ...process.env, ELEVEN_LABS_API_KEY: 'k', PATH: dir }, dir)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(
      stderrBeyondNodeWarnings(result.stderr),
      'walkthrough: ffmpeg -version was killed by SIGABRT.'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: walkthrough render exits 2 when ffmpeg cannot be run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  try {
    mkdirSync(join(dir, 'ffmpeg'))
    const result = runCli({ ...process.env, ELEVEN_LABS_API_KEY: 'k', PATH: dir }, dir)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(
      stderrBeyondNodeWarnings(result.stderr),
      'walkthrough: ffmpeg could not be run (EACCES).'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: walkthrough render exits 2 when ffmpeg starts but exits nonzero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  try {
    writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexit 3\n')
    chmodSync(join(dir, 'ffmpeg'), 0o755)
    const result = runCli({ ...process.env, ELEVEN_LABS_API_KEY: 'k', PATH: dir }, dir)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(
      stderrBeyondNodeWarnings(result.stderr),
      'walkthrough: ffmpeg -version exited with status 3.'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: Chrome that cannot be found exits 2 before any ElevenLabs request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  let requests = 0
  const server = createServer((_, res) => {
    requests++
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  for (const stub of ['ffmpeg', 'npx']) {
    writeFileSync(join(dir, stub), `#!/bin/sh\nexit ${stub === 'npx' ? 1 : 0}\n`)
    chmodSync(join(dir, stub), 0o755)
  }
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const script = join(dir, 's.json')
  writeFileSync(
    script,
    JSON.stringify({
      title: 'T',
      palette: 'classic',
      scenes: [{ heading: 'A', narration: 'Hello.', visual: { kind: 'title' } }],
    })
  )
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    await runWalkthroughRender(script, join(dir, 'o.mp4'), {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      apiBase: `http://127.0.0.1:${port}`,
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 2)
    assert.equal(requests, 0)
    assert.deepEqual(stdout, [])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [['walkthrough: hyperframes browser ensure failed']]
    )
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: ELEVEN_LABS_VOICE_ID picks the voice, and the default is used without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  const urls: string[] = []
  const server = createServer((req, res) => {
    urls.push(req.url ?? '')
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  for (const stub of ['ffmpeg', 'npx']) {
    writeFileSync(join(dir, stub), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, stub), 0o755)
  }
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const script = join(dir, 's.json')
  writeFileSync(
    script,
    JSON.stringify({
      title: 'T',
      palette: 'classic',
      scenes: [{ heading: 'A', narration: 'Hello.', visual: { kind: 'title' } }],
    })
  )
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    for (const voice of ['test-voice', undefined]) {
      await runWalkthroughRender(script, join(dir, 'o.mp4'), {
        env: { ELEVEN_LABS_API_KEY: 'k', ELEVEN_LABS_VOICE_ID: voice },
        apiBase: `http://127.0.0.1:${port}`,
        stdout: () => undefined,
      })
    }
    assert.deepEqual(urls, [
      '/v1/voices/test-voice/settings',
      `/v1/voices/${DEFAULT_VOICE_ID}/settings`,
    ])
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: with no ElevenLabs key it renders silent, subtitled and without audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  // HyperFrames keeps the composition it was asked to render; ffmpeg records its arguments and
  // writes the output file.
  writeFileSync(
    join(dir, 'npx'),
    `#!/bin/sh\n[ "$3" = render ] && /bin/cp "$4/index.html" "${dir}/composed.html"\nexit 0\n`
  )
  writeFileSync(
    join(dir, 'ffmpeg'),
    `#!/bin/sh\n[ "$1" = -version ] && exit 0\nprintf '%s\\n' "$@" > "${dir}/ffmpeg-args"\nfor last; do :; done\n: > "$last"\n`
  )
  for (const stub of ['ffmpeg', 'npx']) {
    chmodSync(join(dir, stub), 0o755)
  }
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const script = join(dir, 's.json')
  writeFileSync(
    script,
    JSON.stringify({
      title: 'T',
      palette: 'classic',
      scenes: [{ heading: 'A', narration: 'Read this. Then that.', visual: { kind: 'title' } }],
    })
  )
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    for (const env of [{}, { ELEVEN_LABS_API_KEY: '' }]) {
      setRequestedExitCode(0)
      stdout.length = 0
      stderr.mock.resetCalls()
      await runWalkthroughRender(script, join(dir, 'o.mp4'), {
        env,
        stdout: (chunk) => stdout.push(chunk),
      })
      assert.equal(getRequestedExitCode(), 0)
      assert.deepEqual(
        stderr.mock.calls.map((call) => call.arguments),
        [
          [
            'walkthrough: ELEVEN_LABS_API_KEY is not set, so the walkthrough is rendered without a ' +
              'voice, with the narration as subtitles.',
          ],
        ]
      )
      const summary: unknown = JSON.parse(stdout.join(''))
      assert.ok(typeof summary === 'object' && summary !== null)
      assert.equal('narrated' in summary && summary.narrated, false)
      assert.equal('synthesizedScenes' in summary && summary.synthesizedScenes, 0)
      const composed = readFileSync(join(dir, 'composed.html'), 'utf-8')
      assert.doesNotMatch(composed, /<audio/)
      assert.match(composed, /data-caption="0">Read this\.</)
      assert.match(composed, /data-caption="1">Then that\.</)
      const args = readFileSync(join(dir, 'ffmpeg-args'), 'utf-8').split('\n')
      assert.ok(args.includes('-an'))
      assert.ok(!args.includes('-c:a'))
      assert.ok(args.includes('+faststart'))
    }
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: walkthrough render with no ElevenLabs key exits 0 and prints the silent summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  try {
    writeFileSync(join(dir, 'npx'), '#!/bin/sh\nexit 0\n')
    writeFileSync(
      join(dir, 'ffmpeg'),
      '#!/bin/sh\n[ "$1" = -version ] && exit 0\nfor last; do :; done\n: > "$last"\n'
    )
    for (const stub of ['ffmpeg', 'npx']) {
      chmodSync(join(dir, stub), 0o755)
    }
    const narration = 'Read this. Then that.'
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({
        title: 'T',
        palette: 'classic',
        scenes: [{ heading: 'A', narration, visual: { kind: 'title' } }],
      })
    )
    const durationSeconds =
      (readingAlignment(narration).character_end_times_seconds.at(-1) ?? 0) + SCENE_TAIL

    for (const key of [undefined, '']) {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
      delete env.ELEVEN_LABS_API_KEY
      if (key !== undefined) {
        env.ELEVEN_LABS_API_KEY = key
      }
      const result = runCli(env, dir)
      assert.equal(result.status, 0)
      assert.equal(
        stderrBeyondNodeWarnings(result.stderr),
        'walkthrough: ELEVEN_LABS_API_KEY is not set, so the walkthrough is rendered without a ' +
          'voice, with the narration as subtitles.'
      )
      assert.equal(
        result.stdout,
        JSON.stringify({
          output: join(dir, 'o.mp4'),
          narrated: false,
          durationSeconds,
          bytes: 0,
          scenes: 1,
          synthesizedScenes: 0,
          cachedScenes: 0,
          ttsCharacters: 0,
          overNotionLimit: false,
        }) + '\n'
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
