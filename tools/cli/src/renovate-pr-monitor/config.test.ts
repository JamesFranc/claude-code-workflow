import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, legacyStateFilePath, loadConfig } from './config.ts'

// bash's ${VAR:-default} treats an explicitly-set-but-empty env var the same as unset. loadConfig
// must match: an empty string for any of these must fall back to its default, not survive as ''.
test('an empty-string env var falls back to its default, same as unset', () => {
  const config = loadConfig({
    RENOVATE_MONITOR_AUTHOR: '',
    RENOVATE_MONITOR_SCOPE: 'owner/*',
    RENOVATE_MONITOR_POLL_SECONDS: '',
    RENOVATE_MONITOR_MAX_CI_RETRIES: '',
    RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '',
    RENOVATE_MONITOR_STATE_FILE: '',
  })

  assert.equal(config.author, 'app/renovate')
  assert.equal(config.pollIntervalSeconds, 900)
  assert.equal(config.maxCiRetries, 2)
  assert.equal(config.mergeDelaySeconds, 120)
  assert.notEqual(config.stateFile, '')
  // An empty RENOVATE_MONITOR_STATE_FILE is falsy, same as unset, so it still falls back to
  // the default path and legacy adoption still applies.
  assert.equal(config.legacyStateFile, legacyStateFilePath())
})

// These three env vars must be whole, non-negative integers. Anything else is rejected at
// startup rather than accepted and misinterpreted.
test('rejects a non-integer RENOVATE_MONITOR_POLL_SECONDS', () => {
  for (const bad of ['15m', '2x', '1.5']) {
    assert.throws(
      () => loadConfig({ RENOVATE_MONITOR_SCOPE: 'owner/*', RENOVATE_MONITOR_POLL_SECONDS: bad }),
      ConfigError
    )
  }
})

test('rejects a non-integer RENOVATE_MONITOR_MAX_CI_RETRIES', () => {
  for (const bad of ['15m', '2x', '1.5']) {
    assert.throws(
      () => loadConfig({ RENOVATE_MONITOR_SCOPE: 'owner/*', RENOVATE_MONITOR_MAX_CI_RETRIES: bad }),
      ConfigError
    )
  }
})

test('rejects a non-integer RENOVATE_MONITOR_MERGE_DELAY_SECONDS', () => {
  for (const bad of ['15m', '2x', '1.5']) {
    assert.throws(
      () =>
        loadConfig({
          RENOVATE_MONITOR_SCOPE: 'owner/*',
          RENOVATE_MONITOR_MERGE_DELAY_SECONDS: bad,
        }),
      ConfigError
    )
  }
})
