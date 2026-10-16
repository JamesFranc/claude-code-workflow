import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

// D2 runs in a worker thread that keeps the process alive unless it is terminated, so the real
// binary is the only place a missing teardown shows: the command would print its JSON and hang.
test('CLI: render-diagrams exits on its own after rendering a d2 block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-diagrams-cli-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, '# Title\n\n```d2\na: A {class: tool}\n```\n')
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', mainTsPath, 'render-diagrams', '--file', file],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.equal(result.signal, null, 'the command was killed by the timeout instead of exiting')
    assert.equal(result.status, 0)
    assert.equal(stderrBeyondNodeWarnings(result.stderr), '')
    const assets = join(dir, 'doc.assets')
    assert.deepEqual(JSON.parse(result.stdout), {
      file,
      blocks: 1,
      failures: [],
      hosted: join(assets, 'hosted.md'),
      ok: true,
    })
    assert.ok(existsSync(join(assets, 'diagram-1.svg')))
    assert.ok(existsSync(join(assets, 'diagram-1.webp')))
    assert.equal(
      readFileSync(join(assets, 'hosted.md'), 'utf-8'),
      '# Title\n\n![Diagram 1](doc.assets/diagram-1.webp)\n'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: render-diagrams reports a failing block as one stderr line and the failure JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-diagrams-cli-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, '# Title\n\n```d2\nb ->\n```\n')
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', mainTsPath, 'render-diagrams', '--file', file],
      { encoding: 'utf8', timeout: 60_000 }
    )
    assert.equal(result.status, 1)
    assert.equal(
      stderrBeyondNodeWarnings(result.stderr),
      `${file}: d2 block #1 (line 3): 1:1: connection missing destination`
    )
    assert.deepEqual(JSON.parse(result.stdout), {
      file,
      blocks: 1,
      failures: [{ index: 0, startLine: 3, error: '1:1: connection missing destination' }],
      hosted: null,
      ok: false,
    })
    assert.equal(existsSync(join(dir, 'doc.assets')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const runCli = (doc: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-diagrams-cli-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, doc)
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', mainTsPath, 'render-diagrams', '--file', file],
      { encoding: 'utf8', timeout: 60_000 }
    )
    return { ...result, file }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('CLI: render-diagrams reports an empty label as a problem line, not a renderer defect', () => {
  const empty = runCli('# Title\n\n```d2\na: ""\n```\n')

  const error = "'a': a box needs a label; this one is empty"
  assert.equal(empty.status, 1)
  assert.equal(
    empty.stdout,
    `${JSON.stringify({
      file: empty.file,
      blocks: 1,
      failures: [{ index: 0, startLine: 3, error }],
      hosted: null,
      ok: false,
    })}\n`
  )
  assert.equal(
    stderrBeyondNodeWarnings(empty.stderr),
    `${empty.file}: d2 block #1 (line 3): ${error}`
  )
})

test('CLI: render-diagrams leaves a bad diagram-palette without the renderer-defect marker', () => {
  const palette = runCli('---\ndiagram-palette: neon\n---\n# Title\n')

  assert.equal(palette.status, 1)
  assert.equal(palette.stdout, '')
  assert.match(palette.stderr, /unknown diagram-palette 'neon'/)
  assert.doesNotMatch(palette.stderr, /render-diagrams bug:/)
})
