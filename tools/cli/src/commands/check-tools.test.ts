import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const use = 'ElevenLabs narration for walkthrough videos'
const onFailure =
  'STOP and tell the user ElevenLabs is configured but walkthrough render cannot voice the narration. Do NOT fall back.'

const checkElevenlabs = (key: string) =>
  spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'check-tools', '--require', 'elevenlabs'],
    { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, ELEVEN_LABS_API_KEY: key } }
  )

test('CLI: check-tools reports elevenlabs configured when ELEVEN_LABS_API_KEY is set', () => {
  const result = checkElevenlabs('k')
  assert.equal(result.status, 0)
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    '✓ elevenlabs: configured — ElevenLabs narration for walkthrough videos'
  )
  assert.equal(
    result.stdout,
    JSON.stringify({
      results: [
        {
          tool: 'elevenlabs',
          state: 'configured',
          use,
          onFailure,
          env: { present: ['ELEVEN_LABS_API_KEY'], missing: [], accepted: ['ELEVEN_LABS_API_KEY'] },
        },
      ],
      anyFailed: false,
    }) + '\n'
  )
})

test('CLI: check-tools reports elevenlabs unconfigured when ELEVEN_LABS_API_KEY is empty', () => {
  const result = checkElevenlabs('')
  assert.equal(result.status, 0)
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    '· elevenlabs: unconfigured — env vars not set: ELEVEN_LABS_API_KEY'
  )
  assert.equal(
    result.stdout,
    JSON.stringify({
      results: [
        {
          tool: 'elevenlabs',
          state: 'unconfigured',
          use,
          onFailure,
          env: { present: [], missing: ['ELEVEN_LABS_API_KEY'], accepted: ['ELEVEN_LABS_API_KEY'] },
          reason: 'env vars not set: ELEVEN_LABS_API_KEY',
        },
      ],
      anyFailed: false,
    }) + '\n'
  )
})
