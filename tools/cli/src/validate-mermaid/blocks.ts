import { splitLines } from '../split-lines.ts'

export type FencedBlock = {
  index: number
  startLine: number
  code: string
} & (
  { closeLine: number; unterminated?: undefined } | { closeLine?: undefined; unterminated: true }
)

export const extractMermaidBlocks = (markdown: string): FencedBlock[] =>
  extractFencedBlocks(markdown, 'mermaid')

// `language` is matched literally after the opening fence, so it must not contain regex syntax.
export const extractFencedBlocks = (markdown: string, language: string): FencedBlock[] => {
  const lines = splitLines(markdown)
  const blocks: FencedBlock[] = []
  const openFence = new RegExp(`^(\\s*)(\`{3,}|~{3,})\\s*${language}\\s*$`)
  let inBlock = false
  let fence = ''
  let startLine = 0
  let buffer: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!inBlock) {
      const open = openFence.exec(line)
      if (open) {
        inBlock = true
        fence = open[2] ?? ''
        startLine = i + 1
        buffer = []
      }
      continue
    }
    const close = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).exec(line)
    if (close) {
      blocks.push({ index: blocks.length, startLine, code: buffer.join('\n'), closeLine: i + 1 })
      inBlock = false
      continue
    }
    buffer.push(line)
  }
  if (inBlock) {
    blocks.push({ index: blocks.length, startLine, code: buffer.join('\n'), unterminated: true })
  }
  return blocks
}
