import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { returnUrl, runRefreshReturn } from './return-link.ts'
import { upsertRegistryNode } from './registry.ts'
import { sessionGlobalScope, storePath } from '../workflow-store/store.ts'
import { hashId } from './state.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

let tmpDir: string
let homeDir: string
let rawId: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['AI_WORKFLOW_APP_BIN', 'CLAUDE_CODE_SESSION_ID', 'HOME', 'ITERM_SESSION_ID']

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }
  tmpDir = mkdtempSync(join(tmpdir(), 'return-link-test-'))
  homeDir = mkdtempSync(join(tmpdir(), 'return-link-home-'))
  rawId = `test-return-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-24)}`
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.ITERM_SESSION_ID = 'w3t4p0:FE3D8603-AAAA'
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(tmpDir)
  setRequestedExitCode(0)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = saved[k]
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

const writeLoggingStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\nexit 0\n`
  )
  chmodSync(path, 0o755)
  return path
}

const readCalls = (): string[] => {
  const log = join(tmpDir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []
}

const seedRoot = (): void =>
  upsertRegistryNode(rawId, {
    internalId: 'root-internal',
    externalId: `${rawId}_x`,
    key: null,
    parentId: null,
  })

test('returnUrl: takes the uuid after the first colon and encodes the query', () => {
  assert.equal(
    returnUrl('w3t4p0:FE3D', 'sess-1', '/a/b'),
    'agent-session://iterm/FE3D?claude=sess-1&cwd=%2Fa%2Fb'
  )
  assert.equal(returnUrl(undefined, 'sess-1', '/a'), null)
  assert.equal(returnUrl('w3t4p0', 'sess-1', '/a'), null)
})

test('runRefreshReturn: links the root with the return URL, and a later call reuses the recorded dir', () => {
  seedRoot()
  runRefreshReturn('/launch/dir')
  runRefreshReturn()
  const url = `agent-session://iterm/FE3D8603-AAAA?claude=${rawId}&cwd=%2Flaunch%2Fdir`
  const expected = `link add --session root-internal --kind return --label iTerm --url ${url}`
  assert.deepEqual(readCalls(), [expected, expected])
})

test('runRefreshReturn: makes no call with an empty registry or without ITERM_SESSION_ID', () => {
  runRefreshReturn('/d')
  assert.deepEqual(readCalls(), [])

  seedRoot()
  delete process.env.ITERM_SESSION_ID
  runRefreshReturn('/d')
  assert.deepEqual(readCalls(), [])

  process.env.ITERM_SESSION_ID = 'w3t4p0:FE3D8603-AAAA'
  runRefreshReturn('/d')
  assert.equal(readCalls().length, 1, 'same setup with both inputs present does call the board')
})

test('runRefreshReturn: an absent launch record falls back to the process cwd, an unreadable or malformed one makes no call', () => {
  seedRoot()
  runRefreshReturn()
  const fallback = `agent-session://iterm/FE3D8603-AAAA?${new URLSearchParams({ claude: rawId, cwd: process.cwd() }).toString()}`
  assert.deepEqual(readCalls(), [
    `link add --session root-internal --kind return --label iTerm --url ${fallback}`,
  ])

  const recordPath = storePath(sessionGlobalScope(rawId), `dashboard-return-${hashId(rawId)}.json`)
  mkdirSync(recordPath, { recursive: true })
  runRefreshReturn()
  assert.equal(readCalls().length, 1, 'a record that cannot be read is unknown: no call')

  rmSync(recordPath, { recursive: true })
  writeFileSync(recordPath, '{not json')
  runRefreshReturn()
  assert.equal(readCalls().length, 1, 'a malformed record is unknown: no call')

  writeFileSync(recordPath, JSON.stringify({ cwd: 7 }))
  runRefreshReturn()
  assert.equal(readCalls().length, 1, 'a record without a string cwd is unknown: no call')

  runRefreshReturn('/launch/dir')
  assert.equal(readCalls().length, 2, 'recording a launch dir again repairs it')
})

test('runRefreshReturn: a failing board call leaves the exit code alone', () => {
  seedRoot()
  writeFileSync(join(tmpDir, 'ai-workflow-app'), '#!/usr/bin/env bash\nexit 3\n')
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (): boolean => true
  try {
    runRefreshReturn('/d')
  } finally {
    process.stderr.write = origWrite
  }
  assert.ok(!getRequestedExitCode())
})
