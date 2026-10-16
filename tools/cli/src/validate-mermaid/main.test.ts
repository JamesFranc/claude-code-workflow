import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runValidateMermaid } from './main.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

const withTempFile = (contents: string, run: (file: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-mermaid-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, contents)
  return run(file).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// Collects via runValidateMermaid's injectable stdout sink rather than monkeypatching the process
// global: node --test runs each file in a child process that serializes its own result-reporting
// protocol over that same stream, so a patched write can silently lose test results or desync the
// parser mid-run.
const captureStdout = async (
  run: (stdout: (chunk: string) => void) => Promise<void>
): Promise<string> => {
  const originalWrite = process.stdout.write
  let captured = ''
  await run((chunk) => {
    // Discriminates this sink-based capture from a global process.stdout.write monkeypatch: under a
    // monkeypatch, process.stdout.write IS the collector by the time it fires, so this equality would
    // fail. Here it fires only because runValidateMermaid called the injected sink directly.
    assert.equal(process.stdout.write, originalWrite, 'process.stdout.write must stay untouched')
    captured += chunk
  })
  return captured
}

test('runValidateMermaid: zero blocks passes', async () => {
  await withTempFile('# no diagram\n\nprose only\n', async (file) => {
    setRequestedExitCode(99)
    const stdout = await captureStdout((write) => runValidateMermaid(file, { stdout: write }))
    const output = JSON.parse(stdout)
    assert.equal(output.ok, true)
    assert.equal(output.blocks, 0)
    assert.equal(getRequestedExitCode(), 0)
  })
})

test('runValidateMermaid: a block that fails to parse fails via failures', async () => {
  await withTempFile(
    '# broken diagram\n\n```mermaid\ngraph TD\n  A[Start] -->\n```\n',
    async (file) => {
      setRequestedExitCode(0)
      const stdout = await captureStdout((write) => runValidateMermaid(file, { stdout: write }))
      const output = JSON.parse(stdout)
      assert.equal(output.ok, false)
      assert.ok(output.failures.length > 0)
      assert.equal(getRequestedExitCode(), 1)
    }
  )
})

test('runValidateMermaid: an unterminated mermaid fence fails via failures', async () => {
  await withTempFile(
    '# unterminated\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n',
    async (file) => {
      setRequestedExitCode(0)
      const stdout = await captureStdout((write) => runValidateMermaid(file, { stdout: write }))
      const output = JSON.parse(stdout)
      assert.equal(output.ok, false)
      assert.ok(
        output.failures.some((f: { error: string }) => /unterminated mermaid fence/.test(f.error))
      )
      assert.equal(getRequestedExitCode(), 1)
    }
  )
})
