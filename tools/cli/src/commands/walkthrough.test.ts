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
import { classifyTool } from '../check-tools/main.ts'
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
    for (const env of [{}, { ELEVEN_LABS_API_KEY: '' }, { WALKTHROUGH_VOICE: '' }]) {
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
            'walkthrough: none of WALKTHROUGH_VOICE=kokoro, ELEVEN_LABS_API_KEY or ' +
              'WALKTHROUGH_MAC_VOICE is set, so the ' +
              'walkthrough is rendered without a voice, with the narration as subtitles.',
          ],
        ]
      )
      const summary: unknown = JSON.parse(stdout.join(''))
      assert.ok(typeof summary === 'object' && summary !== null)
      assert.equal('narrated' in summary && summary.narrated, false)
      assert.equal('synthesizedScenes' in summary && summary.synthesizedScenes, 0)
      assert.ok('voice' in summary && summary.voice === null)
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
        'walkthrough: none of WALKTHROUGH_VOICE=kokoro, ELEVEN_LABS_API_KEY or ' +
          'WALKTHROUGH_MAC_VOICE is set, so the walkthrough is rendered without a voice, with the narration as subtitles.'
      )
      assert.equal(
        result.stdout,
        JSON.stringify({
          output: join(dir, 'o.mp4'),
          narrated: false,
          voice: null,
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

test('walkthrough render: WALKTHROUGH_MAC_VOICE voices the walkthrough with a macOS voice', async () => {
  setRequestedExitCode(0)
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  writeRenderStubs(dir)
  macVoiceStubs(dir)
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
    const render = async (): Promise<unknown> => {
      stdout.length = 0
      await runWalkthroughRender(script, join(dir, 'o.mp4'), {
        env: { WALKTHROUGH_MAC_VOICE: 'Tester' },
        stdout: (chunk) => stdout.push(chunk),
      })
      return JSON.parse(stdout.join(''))
    }
    // The ffprobe stand-in reports one second per narrated character; the ffmpeg stand-in writes
    // an empty file.
    const summary = {
      output: join(dir, 'o.mp4'),
      narrated: true,
      voice: 'mac',
      durationSeconds: 'Read this. Then that.'.length + SCENE_TAIL,
      bytes: 0,
      scenes: 1,
      synthesizedScenes: 1,
      cachedScenes: 0,
      ttsCharacters: 0,
      overNotionLimit: false,
    }

    assert.deepEqual(await render(), summary)
    assert.equal(getRequestedExitCode(), 0)
    assert.deepEqual(stderr.mock.calls, [])
    assert.equal(stdout.length, 1)
    const composed = readFileSync(join(dir, 'composed.html'), 'utf-8')
    assert.match(composed, /<audio [^>]*src="audio\/scene-0\.m4a"/)
    assert.doesNotMatch(composed, /data-caption=/)
    const args = readFileSync(join(dir, 'ffmpeg-args'), 'utf-8').split('\n')
    assert.ok(args.includes('-c:a'))
    assert.ok(!args.includes('-an'))

    stderr.mock.resetCalls()
    assert.deepEqual(await render(), { ...summary, synthesizedScenes: 0, cachedScenes: 1 })
    assert.equal(getRequestedExitCode(), 0)
    assert.deepEqual(stderr.mock.calls, [])
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: an uninstalled macOS voice exits 1 before anything renders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  writeRenderStubs(dir)
  macVoiceStubs(dir)
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\necho call >> "${dir}/npx-calls"\nexit 0\n`)
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
      env: { WALKTHROUGH_MAC_VOICE: 'Nobody' },
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [
        [
          'walkthrough: WALKTHROUGH_MAC_VOICE names "Nobody", which is not an installed voice; ' +
            "say -v '?' lists them.",
        ],
      ]
    )
    assert.deepEqual(stdout, [])
    assert.throws(() => readFileSync(join(dir, 'npx-calls')), { code: 'ENOENT' })
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: walkthrough render: a macOS voice without say exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  try {
    writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'ffmpeg'), 0o755)
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({
        title: 'T',
        palette: 'classic',
        scenes: [{ heading: 'A', narration: 'Hello.', visual: { kind: 'title' } }],
      })
    )
    const result = runCli({ PATH: dir, WALKTHROUGH_MAC_VOICE: 'Tester' }, dir)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(
      stderrBeyondNodeWarnings(result.stderr),
      'walkthrough: WALKTHROUGH_MAC_VOICE is set, but say cannot be run; macOS voices need macOS.'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: an ElevenLabs key wins over WALKTHROUGH_MAC_VOICE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  const urls: string[] = []
  const server = createServer((req, res) => {
    urls.push(req.url ?? '')
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  writeRenderStubs(dir)
  macVoiceStubs(dir)
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
      env: { ELEVEN_LABS_API_KEY: 'k', WALKTHROUGH_MAC_VOICE: 'Tester' },
      apiBase: `http://127.0.0.1:${port}`,
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(urls, [`/v1/voices/${DEFAULT_VOICE_ID}/settings`])
    assert.throws(() => readFileSync(join(dir, 'say-calls')), { code: 'ENOENT' })
    assert.deepEqual(stdout, [])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [
        [
          'walkthrough: ELEVEN_LABS_API_KEY is set, so ElevenLabs voices the walkthrough and ' +
            'WALKTHROUGH_MAC_VOICE is ignored.',
        ],
        [`${script}: ElevenLabs returned 500 for the voice's settings: `],
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

test('walkthrough render: a WALKTHROUGH_VOICE other than kokoro exits 1 before any tool runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  writeFileSync(join(dir, 'ffmpeg'), `#!/bin/sh\necho ran > "${dir}/ffmpeg-ran"\nexit 0\n`)
  chmodSync(join(dir, 'ffmpeg'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    await runWalkthroughRender(join(dir, 's.json'), join(dir, 'o.mp4'), {
      env: { WALKTHROUGH_VOICE: 'elevenlabs', ELEVEN_LABS_API_KEY: 'k' },
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(stdout, [])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [['walkthrough: WALKTHROUGH_VOICE is "elevenlabs"; the only voice it can name is kokoro.']]
    )
    assert.throws(() => readFileSync(join(dir, 'ffmpeg-ran')))
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: WALKTHROUGH_VOICE=kokoro without uv exits 2 before Chrome or narration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(dir, 'npx'), `#!/bin/sh\necho ran > "${dir}/npx-ran"\nexit 0\n`)
  for (const stub of ['ffmpeg', 'npx']) {
    chmodSync(join(dir, stub), 0o755)
  }
  const path = process.env.PATH
  process.env.PATH = dir
  const script = join(dir, 's.json')
  writeFileSync(
    script,
    JSON.stringify({
      title: 'T',
      palette: 'classic',
      scenes: [{ heading: 'A', narration: 'Hi.', visual: { kind: 'title' } }],
    })
  )
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    await runWalkthroughRender(script, join(dir, 'o.mp4'), {
      env: { WALKTHROUGH_VOICE: 'kokoro' },
      stdout: () => undefined,
    })
    assert.equal(getRequestedExitCode(), 2)
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [['walkthrough: WALKTHROUGH_VOICE=kokoro needs uv on PATH; install it (brew install uv).']]
    )
    assert.throws(() => readFileSync(join(dir, 'npx-ran')))
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: WALKTHROUGH_VOICE=kokoro narrates with Kokoro even when an ElevenLabs key is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-cli-test-'))
  let requests = 0
  const server = createServer((_, res) => {
    requests++
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  writeFileSync(
    join(dir, 'npx'),
    `#!/bin/sh\n[ "$3" = render ] && /bin/cp "$4/index.html" "${dir}/composed.html"\nexit 0\n`
  )
  writeFileSync(
    join(dir, 'ffmpeg'),
    `#!/bin/sh\n[ "$1" = -version ] && exit 0\nprintf '%s\\n' "$@" > "${dir}/ffmpeg-args"\nfor last; do :; done\nprintf mp3 > "$last"\n`
  )
  writeFileSync(
    join(dir, 'uv'),
    [
      '#!/bin/sh',
      '[ "$1" = --version ] && exit 0',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --audio) audio="$2"; shift ;;',
      '    --words) words="$2"; shift ;;',
      '  esac',
      '  shift',
      'done',
      `cat > "${dir}/uv-stdin"`,
      ': > "$audio"',
      `printf '%s' '[{"text":"The","start":0,"end":0.2},{"text":"client","start":0.2,"end":0.6},{"text":"calls","start":0.6,"end":1},{"text":".","start":1,"end":1.1}]' > "$words"`,
      '',
    ].join('\n')
  )
  for (const stub of ['ffmpeg', 'npx', 'uv']) {
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
      scenes: [
        {
          heading: 'B',
          narration: 'The client calls.',
          visual: { kind: 'diagram', d2: '*: {class: tool}\nclient -> server' },
          steps: [{ cue: 'client calls', show: ['server'] }],
        },
      ],
    })
  )
  const stdout: string[] = []
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    setRequestedExitCode(0)
    await runWalkthroughRender(script, join(dir, 'o.mp4'), {
      env: { WALKTHROUGH_VOICE: 'kokoro', ELEVEN_LABS_API_KEY: 'k' },
      apiBase: `http://127.0.0.1:${port}`,
      stdout: (chunk) => stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 0)
    assert.equal(requests, 0)
    assert.deepEqual(stderr.mock.calls, [])
    assert.equal(readFileSync(join(dir, 'uv-stdin'), 'utf-8'), 'The client calls.')
    const summary: unknown = JSON.parse(stdout.join(''))
    assert.ok(typeof summary === 'object' && summary !== null)
    assert.equal('narrated' in summary && summary.narrated, true)
    assert.equal('voice' in summary && summary.voice, 'kokoro')
    assert.equal('synthesizedScenes' in summary && summary.synthesizedScenes, 1)
    assert.match(readFileSync(join(dir, 'composed.html'), 'utf-8'), /<audio/)
    assert.ok(readFileSync(join(dir, 'ffmpeg-args'), 'utf-8').split('\n').includes('-c:a'))
  } finally {
    stderr.mock.restore()
    process.env.PATH = path
    setRequestedExitCode(0)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('walkthrough render: a WALKTHROUGH_VOICE that render rejects is failed by check-tools, never configured', async () => {
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    for (const value of ['Kokoro', ' ']) {
      setRequestedExitCode(0)
      await runWalkthroughRender('s.json', 'o.mp4', {
        env: { WALKTHROUGH_VOICE: value },
        stdout: () => undefined,
      })
      assert.equal(getRequestedExitCode(), 1)
      const checked = classifyTool('kokoro', { WALKTHROUGH_VOICE: value })
      assert.equal(checked.state, 'failed')
      assert.deepEqual(stderr.mock.calls.at(-1)?.arguments, [
        `walkthrough: ${checked.reason ?? ''}`,
      ])
    }
    assert.equal(classifyTool('kokoro', { WALKTHROUGH_VOICE: 'kokoro' }).state, 'configured')
    assert.equal(classifyTool('kokoro', { WALKTHROUGH_VOICE: '' }).state, 'unconfigured')
  } finally {
    stderr.mock.restore()
    setRequestedExitCode(0)
  }
})

// HyperFrames keeps the composition it was asked to render; ffmpeg records its arguments and
// writes the output file.
const writeRenderStubs = (dir: string): void => {
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
}

// Stand-ins for `say` (lists one voice, otherwise copies stdin to its -o file) and `ffprobe`
// (one second per byte).
const macVoiceStubs = (dir: string): void => {
  writeFileSync(
    join(dir, 'say'),
    `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' 'Tester              en_US    # Hello! My name is Tester.'; exit 0; }
echo call >> "${dir}/say-calls"
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > "$out"
`
  )
  writeFileSync(
    join(dir, 'ffprobe'),
    `#!/bin/sh
[ "$1" = -version ] && exit 0
for last; do :; done
wc -c < "$last" | tr -d ' '
`
  )
  for (const stub of ['say', 'ffprobe']) {
    chmodSync(join(dir, stub), 0o755)
  }
}
