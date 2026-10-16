import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const runCli = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    {
      encoding: 'utf8',
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

// FLOW-374: --require-diagram is gone (no doc type requires a diagram). These two real-binary
// invocations are what the removed flag's own CLI tests used to cover, restated for the new
// behaviour: a diagram-less file is always a no-op, and the old flag is now unregistered.
test('CLI: a diagram-less file is a no-op on the real binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-mermaid-cli-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, '# no diagram\n\nprose only\n')
  try {
    const { stdout, stderr, status } = runCli(['validate-mermaid', '--file', file])
    assert.equal(status, 0)
    assert.equal(stderrBeyondNodeWarnings(stderr), '')
    assert.equal(stdout, JSON.stringify({ file, blocks: 0, failures: [], ok: true }) + '\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: --require-diagram is no longer a registered flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-mermaid-cli-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, '# no diagram\n\nprose only\n')
  try {
    const { stdout, stderr, status } = runCli([
      'validate-mermaid',
      '--file',
      file,
      '--require-diagram',
    ])
    assert.notEqual(status, 0)
    assert.equal(stdout, '')
    assert.match(stderr, /No flag registered for --require-diagram/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
