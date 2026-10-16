import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRenderDiagrams } from './main.ts'
import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'

const withDoc = async (
  contents: string,
  run: (file: string, outDir: string) => Promise<void>
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'render-diagrams-test-'))
  const file = join(dir, 'doc.md')
  writeFileSync(file, contents)
  try {
    await run(file, join(dir, 'out'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const collect = async (run: (stdout: (chunk: string) => void) => Promise<void>) => {
  let captured = ''
  await run((chunk) => {
    captured += chunk
  })
  return JSON.parse(captured)
}

test('runRenderDiagrams: writes each diagram and a hosted copy with frontmatter dropped', async () => {
  const doc =
    '---\nnotion-page-id: abc\ndiagram-palette: origami\n---\n\n# Title\n\n' +
    '```d2\na: A {class: actor}\n```\n\nAfter.\n'
  await withDoc(doc, async (file, outDir) => {
    setRequestedExitCode(99)
    const output = await collect((stdout) => runRenderDiagrams(file, { outDir, stdout }))
    assert.equal(output.ok, true)
    assert.equal(output.blocks, 1)
    assert.equal(output.hosted, join(outDir, 'hosted.md'))
    assert.equal(getRequestedExitCode(), 0)
    assert.ok(existsSync(join(outDir, 'diagram-1.svg')))
    assert.ok(existsSync(join(outDir, 'diagram-1.webp')))
    assert.match(readFileSync(join(outDir, 'diagram-1.svg'), 'utf-8'), /fill="#322E2B"/)
    assert.equal(
      readFileSync(join(outDir, 'hosted.md'), 'utf-8'),
      '# Title\n\n![Diagram 1](out/diagram-1.webp)\n\nAfter.\n'
    )
  })
})

test('runRenderDiagrams: a failing block fails the doc and writes nothing', async () => {
  const doc = '# Title\n\n```d2\na: A {class: tool}\n```\n\n```d2\nb ->\n```\n'
  await withDoc(doc, async (file, outDir) => {
    setRequestedExitCode(0)
    const output = await collect((stdout) => runRenderDiagrams(file, { outDir, stdout }))
    assert.equal(output.ok, false)
    assert.equal(output.hosted, null)
    assert.deepEqual(output.failures, [
      { index: 1, startLine: 7, error: '1:1: connection missing destination' },
    ])
    assert.equal(getRequestedExitCode(), 1)
    assert.equal(existsSync(outDir), false)
  })
})

test('runRenderDiagrams: an unknown diagram-palette is refused', async () => {
  await withDoc('---\ndiagram-palette: neon\n---\n# Title\n', async (file, outDir) => {
    await assert.rejects(
      runRenderDiagrams(file, { outDir, stdout: () => undefined }),
      /unknown diagram-palette 'neon'/
    )
  })
})

test('runRenderDiagrams: reads diagram-palette whether quoted or followed by a comment', async () => {
  for (const line of [
    'diagram-palette: "origami"',
    "diagram-palette: 'origami'",
    'diagram-palette: origami # warm',
  ]) {
    await withDoc(
      `---\n${line}\n---\n\n\`\`\`d2\na: A {class: tool}\n\`\`\`\n`,
      async (file, outDir) => {
        await collect((stdout) => runRenderDiagrams(file, { outDir, stdout }))
        assert.match(readFileSync(join(outDir, 'diagram-1.svg'), 'utf-8'), /fill="#322E2B"/, line)
      }
    )
  }
})

test('runRenderDiagrams: a diagram-palette key with no value is refused, not defaulted', async () => {
  await withDoc('---\ndiagram-palette:\n---\n# Title\n', async (file, outDir) => {
    await assert.rejects(
      runRenderDiagrams(file, { outDir, stdout: () => undefined }),
      /unknown diagram-palette ''/
    )
  })
})

test('runRenderDiagrams: an empty label is reported as a block failure naming the block', async () => {
  await withDoc('# Title\n\n```d2\na: ""\n```\n', async (file, outDir) => {
    setRequestedExitCode(0)
    const output = await collect((stdout) => runRenderDiagrams(file, { outDir, stdout }))
    assert.equal(output.ok, false)
    assert.deepEqual(output.failures, [
      { index: 0, startLine: 3, error: "'a': a box needs a label; this one is empty" },
    ])
    assert.equal(getRequestedExitCode(), 1)
    assert.equal(existsSync(outDir), false)
  })
})

test('runRenderDiagrams: a renderer defect is thrown naming the block, not reported as a block failure', async () => {
  await withDoc('# Title\n\n```d2\na: A\n```\n', async (file, outDir) => {
    let stdout = ''
    await assert.rejects(
      runRenderDiagrams(file, {
        outDir,
        stdout: (chunk) => {
          stdout += chunk
        },
        createRenderer: () => ({
          render: () => Promise.reject(new Error('boom')),
          close: () => Promise.resolve(),
        }),
      }),
      /^Error: render-diagrams bug: d2 block #1 \(line 3\): boom$/
    )
    assert.equal(stdout, '')
    assert.equal(existsSync(outDir), false)
  })
})
