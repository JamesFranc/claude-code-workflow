import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { ensureState, getBoardItem, loadState } from './state.ts'

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'renovate-state-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a 0-byte state file loads as {"prs":{}}', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, '')
    assert.deepEqual(loadState(stateFile), { prs: {} })
  })
})

test('a whitespace-only state file loads as {"prs":{}} rather than crashing', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, '\n')
    assert.deepEqual(loadState(stateFile), { prs: {} })
  })
})

test('migrating a state file preserves top-level keys other than prs, e.g. boardItems', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } }, boardItems: ['x'] })
    )

    ensureState(stateFile, false)

    const migrated = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.deepEqual(migrated.boardItems, ['x'])
    assert.equal(migrated.prs['owner/repo#1'].headSha, 'abc')
  })
})

test('with the variable unset, a legacy state file is adopted onto the new path in camelCase, unchanged itself', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const legacyStateFile = join(dir, 'legacy.json')
    const legacyRaw = JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } } })
    writeFileSync(legacyStateFile, legacyRaw)

    ensureState(stateFile, false, legacyStateFile)

    assert.equal(readFileSync(legacyStateFile, 'utf-8'), legacyRaw)
    const adopted = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(adopted.prs['owner/repo#1'].headSha, 'abc')
  })
})

test('adoption does not run when the new path already exists', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const legacyStateFile = join(dir, 'legacy.json')
    writeFileSync(stateFile, '{"prs":{}}\n')
    writeFileSync(legacyStateFile, JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } } }))

    ensureState(stateFile, false, legacyStateFile)

    assert.deepEqual(loadState(stateFile), { prs: {} })
  })
})

test('adoption runs at most once, even if the state file is later reset', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const legacyStateFile = join(dir, 'legacy.json')
    writeFileSync(legacyStateFile, JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } } }))

    ensureState(stateFile, false, legacyStateFile)
    assert.equal(loadState(stateFile).prs['owner/repo#1'].headSha, 'abc')

    // The runbook's "reset the state file" recipe: delete stateFile and let it be recreated.
    rmSync(stateFile)
    ensureState(stateFile, false, legacyStateFile)

    assert.deepEqual(loadState(stateFile), { prs: {} })
  })
})

test('a dry run after a state-file reset does not re-adopt stale legacy data', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const legacyStateFile = join(dir, 'legacy.json')
    writeFileSync(legacyStateFile, JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } } }))

    ensureState(stateFile, false, legacyStateFile)
    rmSync(stateFile)

    assert.deepEqual(loadState(stateFile, legacyStateFile), { prs: {} })
  })
})

test('a dry run adopts the legacy file in memory only', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const legacyStateFile = join(dir, 'legacy.json')
    writeFileSync(legacyStateFile, JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } } }))

    ensureState(stateFile, true, legacyStateFile)
    assert.equal(existsSync(stateFile), false)

    const loaded = loadState(stateFile, legacyStateFile)
    assert.equal(loaded.prs['owner/repo#1'].headSha, 'abc')
    assert.equal(existsSync(stateFile), false)
  })
})

test('getBoardItem sees a legacy boardItems record before adoption, same as getPrState', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const legacyStateFile = join(dir, 'legacy.json')
    writeFileSync(
      legacyStateFile,
      JSON.stringify({ prs: {}, boardItems: { 'owner/repo#1': { outcome: 'leave' } } })
    )

    const boardItem = getBoardItem(stateFile, 'owner/repo#1', legacyStateFile)

    assert.equal(boardItem?.outcome, 'leave')
  })
})

test('with RENOVATE_MONITOR_STATE_FILE set, loadConfig yields no legacy path and no adoption happens even though a legacy file exists at the default location', () => {
  withTempDir((dir) => {
    const stateFile = join(dir, 'state.json')
    const originalCwd = process.cwd()
    process.chdir(dir)
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true })
      writeFileSync(
        join(dir, '.claude', 'renovate-pr-monitor-state.json'),
        JSON.stringify({ prs: { 'owner/repo#1': { head_sha: 'abc' } } })
      )

      const config = loadConfig({
        RENOVATE_MONITOR_AUTHOR: 'app/renovate',
        RENOVATE_MONITOR_SCOPE: 'owner/*',
        RENOVATE_MONITOR_STATE_FILE: stateFile,
      })
      assert.equal(config.legacyStateFile, null)

      ensureState(config.stateFile, false, config.legacyStateFile)

      assert.deepEqual(loadState(config.stateFile), { prs: {} })
    } finally {
      process.chdir(originalCwd)
    }
  })
})
