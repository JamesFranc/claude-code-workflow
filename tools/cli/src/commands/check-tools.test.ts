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

test('CLI: check-tools reports mac-voice configured when WALKTHROUGH_MAC_VOICE is set, and unconfigured when empty', () => {
  const checkMacVoice = (voice: string) =>
    spawnSync(
      process.execPath,
      ['--experimental-transform-types', mainTsPath, 'check-tools', '--require', 'mac-voice'],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH, WALKTHROUGH_MAC_VOICE: voice },
      }
    )
  const macUse = 'A macOS voice narrating walkthrough videos'
  const macOnFailure =
    'STOP and tell the user a macOS voice is configured but walkthrough render cannot voice the narration with it. Do NOT fall back.'

  const configured = checkMacVoice('Samantha')
  assert.equal(configured.status, 0)
  assert.equal(
    stderrBeyondNodeWarnings(configured.stderr),
    '✓ mac-voice: configured — A macOS voice narrating walkthrough videos'
  )
  assert.equal(
    configured.stdout,
    JSON.stringify({
      results: [
        {
          tool: 'mac-voice',
          state: 'configured',
          use: macUse,
          onFailure: macOnFailure,
          env: {
            present: ['WALKTHROUGH_MAC_VOICE'],
            missing: [],
            accepted: ['WALKTHROUGH_MAC_VOICE'],
          },
        },
      ],
      anyFailed: false,
    }) + '\n'
  )

  const unconfigured = checkMacVoice('')
  assert.equal(unconfigured.status, 0)
  assert.equal(
    stderrBeyondNodeWarnings(unconfigured.stderr),
    '· mac-voice: unconfigured — env vars not set: WALKTHROUGH_MAC_VOICE'
  )
  assert.equal(
    unconfigured.stdout,
    JSON.stringify({
      results: [
        {
          tool: 'mac-voice',
          state: 'unconfigured',
          use: macUse,
          onFailure: macOnFailure,
          env: {
            present: [],
            missing: ['WALKTHROUGH_MAC_VOICE'],
            accepted: ['WALKTHROUGH_MAC_VOICE'],
          },
          reason: 'env vars not set: WALKTHROUGH_MAC_VOICE',
        },
      ],
      anyFailed: false,
    }) + '\n'
  )
})
