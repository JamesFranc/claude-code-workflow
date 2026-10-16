import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_ID, SPEED, TtsError, narrate } from './tts.ts'

const alignment = {
  characters: ['H', 'i'],
  character_start_times_seconds: [0, 0.1],
  character_end_times_seconds: [0.1, 0.2],
}

const storedSettings = {
  stability: 0.3,
  similarity_boost: 0.9,
  style: 0.2,
  use_speaker_boost: false,
  speed: 1,
}

// A stand-in ElevenLabs that answers a text-to-speech request with `status`, a settings request
// with `settings`, and records what it was sent.
const withServer = async (
  status: number,
  run: (
    apiBase: string,
    requests: { url?: string; key?: string; body: unknown }[]
  ) => Promise<void>,
  settings: { status: number; body: string } = { status: 200, body: JSON.stringify(storedSettings) }
): Promise<void> => {
  const requests: { url?: string; key?: string; body: unknown }[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      requests.push({
        url: req.url,
        key: req.headers['xi-api-key']?.toString(),
        body: body === '' ? undefined : JSON.parse(body),
      })
      if (req.method === 'GET') {
        res.writeHead(settings.status, { 'content-type': 'application/json' }).end(settings.body)
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(
        status === 200
          ? JSON.stringify({ audio_base64: Buffer.from('mp3').toString('base64'), alignment })
          : '{"detail":"quota exceeded"}'
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}`, requests)
  } finally {
    server.close()
  }
}

test('narrate: synthesizes once, then serves the same voice, model and text from the cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'walkthrough-tts-test-'))
  try {
    await withServer(200, async (apiBase, requests) => {
      const options = { apiKey: 'k', voiceId: 'v', cacheDir, apiBase }
      const first = await narrate('Hi', options)
      const second = await narrate('Hi', options)
      assert.equal(first.cached, false)
      assert.equal(second.cached, true)
      assert.deepEqual(second.alignment, alignment)
      assert.equal(readFileSync(second.audioFile, 'utf-8'), 'mp3')
      assert.deepEqual(requests, [
        { url: '/v1/voices/v/settings', key: 'k', body: undefined },
        {
          url: '/v1/text-to-speech/v/with-timestamps',
          key: 'k',
          body: {
            text: 'Hi',
            model_id: MODEL_ID,
            voice_settings: { ...storedSettings, speed: SPEED },
          },
        },
      ])
    })
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('narrate: a non-2xx answer throws with the status and body and caches nothing', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'walkthrough-tts-test-'))
  try {
    await withServer(429, async (apiBase) => {
      await assert.rejects(
        narrate('Hi', { apiKey: 'k', voiceId: 'v', cacheDir, apiBase }),
        (err) =>
          err instanceof TtsError &&
          err.message === 'ElevenLabs returned 429: {"detail":"quota exceeded"}'
      )
    })
    assert.deepEqual(readdirSync(cacheDir), [])
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('narrate: re-voices an entry whose JSON is truncated or whose audio is missing', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'walkthrough-tts-test-'))
  try {
    await withServer(200, async (apiBase, requests) => {
      const options = { apiKey: 'k', voiceId: 'v', cacheDir, apiBase }
      const first = await narrate('Hi', options)
      const entryFile = first.audioFile.replace(/\.mp3$/, '.json')

      writeFileSync(entryFile, '{"audioFile":"x.mp3","alignm')
      const afterTruncation = await narrate('Hi', options)
      assert.equal(afterTruncation.cached, false)
      assert.deepEqual(afterTruncation.alignment, alignment)

      unlinkSync(first.audioFile)
      const afterLostAudio = await narrate('Hi', options)
      assert.equal(afterLostAudio.cached, false)
      assert.equal(readFileSync(afterLostAudio.audioFile, 'utf-8'), 'mp3')
      assert.equal(requests.filter(({ url }) => url?.endsWith('/with-timestamps')).length, 3)
      assert.equal((await narrate('Hi', options)).cached, true)
    })
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('narrate: a reply cut off mid-body propagates the read failure, not a not-JSON TtsError', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'walkthrough-tts-test-'))
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
    res.write('{"audio_base64"')
    setTimeout(() => res.destroy(), 50)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await assert.rejects(
      narrate('Hi', { apiKey: 'k', voiceId: 'v', cacheDir, apiBase: `http://127.0.0.1:${port}` }),
      (err) => err instanceof TypeError && !(err instanceof TtsError)
    )
    assert.deepEqual(readdirSync(cacheDir), [])
  } finally {
    server.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('narrate: audio cached before the speed was part of the key is re-voiced', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'walkthrough-tts-test-'))
  try {
    const oldKey = createHash('sha256')
      .update('v' + MODEL_ID + 'Hi')
      .digest('hex')
    writeFileSync(join(cacheDir, `${oldKey}.mp3`), 'old')
    writeFileSync(join(cacheDir, `${oldKey}.json`), JSON.stringify({ alignment }))
    await withServer(200, async (apiBase) => {
      const result = await narrate('Hi', { apiKey: 'k', voiceId: 'v', cacheDir, apiBase })
      assert.equal(result.cached, false)
      assert.equal(readFileSync(result.audioFile, 'utf-8'), 'mp3')
      assert.notEqual(result.audioFile, join(cacheDir, `${oldKey}.mp3`))
    })
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('narrate: a settings reply that is a failure or not an object stops before any speech request', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'walkthrough-tts-test-'))
  try {
    for (const [settings, message] of [
      [
        { status: 404, body: '{"detail":"no such voice"}' },
        `ElevenLabs returned 404 for the voice's settings: {"detail":"no such voice"}`,
      ],
      [{ status: 200, body: '[1]' }, 'ElevenLabs returned voice settings that are not an object'],
    ] as const) {
      await withServer(
        200,
        async (apiBase, requests) => {
          await assert.rejects(
            narrate('Hi', { apiKey: 'k', voiceId: 'v', cacheDir, apiBase }),
            new TtsError(message)
          )
          assert.deepEqual(
            requests.map(({ url }) => url),
            ['/v1/voices/v/settings']
          )
          assert.deepEqual(readdirSync(cacheDir), [])
        },
        settings
      )
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})
