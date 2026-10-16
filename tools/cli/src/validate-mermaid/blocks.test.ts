import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractFencedBlocks, extractMermaidBlocks } from './blocks.ts'

test('extractMermaidBlocks: returns empty for a doc with no mermaid blocks', () => {
  assert.deepEqual(extractMermaidBlocks('# Title\n\nsome text\n\n```ts\nconst a = 1\n```\n'), [])
})

test('extractMermaidBlocks: captures one block with its opening-fence line and code', () => {
  const md = '# Doc\n\n```mermaid\ngraph TD\n  A --> B\n```\n'
  const blocks = extractMermaidBlocks(md)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.index, 0)
  assert.equal(blocks[0]?.startLine, 3)
  assert.equal(blocks[0]?.code, 'graph TD\n  A --> B')
})

test('extractMermaidBlocks: captures multiple blocks with correct indices and start lines', () => {
  const md =
    '```mermaid\ngraph TD\n  A --> B\n```\n\ntext\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n'
  const blocks = extractMermaidBlocks(md)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]?.startLine, 1)
  assert.equal(blocks[1]?.startLine, 8)
})

test('extractMermaidBlocks: supports tilde fences', () => {
  const md = '~~~mermaid\ngraph TD\n  A --> B\n~~~\n'
  assert.equal(extractMermaidBlocks(md).length, 1)
})

test('extractMermaidBlocks: handles a fence indented inside a list item', () => {
  const md = '- item\n   ```mermaid\n   graph TD\n     A --> B\n   ```\n'
  const blocks = extractMermaidBlocks(md)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.startLine, 2)
  assert.equal(blocks[0]?.code, '   graph TD\n     A --> B')
})

test('extractMermaidBlocks: flags a fence with no closing fence before end of file', () => {
  const md = '# Doc\n\n```mermaid\ngraph TD\n  A --> B\n'
  const blocks = extractMermaidBlocks(md)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.startLine, 3)
  assert.equal(blocks[0]?.unterminated, true)
  assert.equal(blocks[0]?.closeLine, undefined)
})

// --- CommonMark line endings: \n, \r, and \r\n all resolve the same block ---

test('extractMermaidBlocks: captures a block correctly with CR-only line endings', () => {
  const md = '# Doc\r\r```mermaid\rgraph TD\r  A --> B\r```\r'
  const blocks = extractMermaidBlocks(md)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.startLine, 3)
  assert.equal(blocks[0]?.code, 'graph TD\n  A --> B')
  assert.equal(blocks[0]?.closeLine, 6)
})

// The code is normalized to `\n`-joined regardless of the source file's own line endings — a
// CRLF source must not leave a stray `\r` inside the captured code.
test('extractMermaidBlocks: captures a block correctly with CRLF line endings, no stray \\r in the code', () => {
  const md = '# Doc\r\n\r\n```mermaid\r\ngraph TD\r\n  A --> B\r\n```\r\n'
  const blocks = extractMermaidBlocks(md)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.startLine, 3)
  assert.equal(blocks[0]?.code, 'graph TD\n  A --> B')
  assert.equal(blocks[0]?.closeLine, 6)
})

test('extractFencedBlocks: captures only the blocks of the language asked for', () => {
  const md = '```mermaid\ngraph TD\n```\n\n```d2\na -> b\n```\n'
  const blocks = extractFencedBlocks(md, 'd2')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.startLine, 5)
  assert.equal(blocks[0]?.code, 'a -> b')
})
