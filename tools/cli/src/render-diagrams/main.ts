import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { splitLines } from '../split-lines.ts'
import { extractFencedBlocks } from '../validate-mermaid/blocks.ts'
import type { FencedBlock } from '../validate-mermaid/blocks.ts'
import {
  DiagramSourceError,
  PALETTE_NAMES,
  createDiagramRenderer,
  isPaletteName,
  type DiagramRenderer,
  type PaletteName,
  type RenderedDiagram,
} from './render.ts'

interface Failure {
  index: number
  startLine: number
  error: string
}

interface RenderDiagramsOutput {
  file: string
  blocks: number
  failures: Failure[]
  hosted: string | null
  ok: boolean
}

// A sink for stdout, matching validate-mermaid/main.ts's Writer pattern, so tests collect output
// without monkeypatching process.stdout.write.
type Writer = (chunk: string) => void

const writeToStdout: Writer = (chunk) => {
  process.stdout.write(chunk)
}

interface RenderDiagramsOptions {
  outDir?: string
  stdout?: Writer
  createRenderer?: (palette: PaletteName) => DiagramRenderer
}

// Renders every ```d2 block in a workflow doc and writes the copy that gets hosted. Nothing is
// written unless every block renders.
export const runRenderDiagrams = async (
  file: string,
  options: RenderDiagramsOptions = {}
): Promise<void> => {
  const stdout = options.stdout ?? writeToStdout
  const outDir = options.outDir ?? join(dirname(file), `${basename(file, '.md')}.assets`)
  const markdown = readFileSync(file, 'utf-8')
  const palette = readPalette(markdown)
  const blocks = extractFencedBlocks(markdown, 'd2')

  const { diagrams, failures } = await renderBlocks(
    blocks,
    palette,
    options.createRenderer ?? createDiagramRenderer
  )
  for (const failure of failures) {
    console.error(formatFailure(file, failure))
  }

  let hosted: string | null = null
  if (failures.length === 0) {
    mkdirSync(outDir, { recursive: true })
    diagrams.forEach(({ svg, webp }, i) => {
      writeFileSync(join(outDir, `diagram-${i + 1}.svg`), svg)
      writeFileSync(join(outDir, `diagram-${i + 1}.webp`), webp)
    })
    hosted = join(outDir, 'hosted.md')
    writeFileSync(hosted, hostedMarkdown(markdown, blocks, relative(dirname(file), outDir)))
  }

  const output: RenderDiagramsOutput = {
    file,
    blocks: blocks.length,
    failures,
    hosted,
    ok: failures.length === 0,
  }
  stdout(JSON.stringify(output) + '\n')
  setRequestedExitCode(failures.length > 0 ? 1 : 0)
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

const readPalette = (markdown: string): PaletteName => {
  const frontmatter = FRONTMATTER.exec(markdown)?.[0] ?? ''
  const line = /^diagram-palette:(.*)$/m.exec(frontmatter)?.[1]

  if (line === undefined) {
    return 'classic'
  }

  const value = line
    .replace(/(^|\s)#.*$/, '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')

  if (isPaletteName(value)) {
    return value
  }

  throw new Error(
    `unknown diagram-palette '${value}' (expected one of: ${PALETTE_NAMES.join(', ')})`
  )
}

const renderBlocks = async (
  blocks: FencedBlock[],
  palette: PaletteName,
  createRenderer: (palette: PaletteName) => DiagramRenderer
): Promise<{ diagrams: RenderedDiagram[]; failures: Failure[] }> => {
  const diagrams: RenderedDiagram[] = []
  const failures: Failure[] = []
  if (blocks.length === 0) {
    return { diagrams, failures }
  }
  const renderer = createRenderer(palette)
  try {
    for (const block of blocks) {
      if (block.unterminated) {
        failures.push({
          index: block.index,
          startLine: block.startLine,
          error: 'unterminated d2 fence (no closing fence before end of file)',
        })
        continue
      }
      try {
        diagrams.push(await renderer.render(block.code))
      } catch (err) {
        if (!(err instanceof DiagramSourceError)) {
          throw new Error(
            `render-diagrams bug: d2 block #${block.index + 1} (line ${block.startLine}): ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          )
        }
        failures.push({ index: block.index, startLine: block.startLine, error: err.message })
      }
    }
  } finally {
    await renderer.close()
  }
  return { diagrams, failures }
}

// The doc as it is hosted: frontmatter dropped and each d2 block replaced by its image. Every
// relative path in it, the images included, resolves against the source doc's directory.
const hostedMarkdown = (markdown: string, blocks: FencedBlock[], assetsDir: string): string => {
  const lines = splitLines(markdown)
  for (const block of [...blocks].reverse()) {
    const count = (block.closeLine ?? lines.length) - block.startLine + 1
    lines.splice(
      block.startLine - 1,
      count,
      `![Diagram ${block.index + 1}](${join(assetsDir, `diagram-${block.index + 1}.webp`)})`
    )
  }
  return lines
    .join('\n')
    .replace(FRONTMATTER, '')
    .replace(/^\s*\n/, '')
}

const formatFailure = (file: string, failure: Failure): string =>
  `${file}: d2 block #${failure.index + 1} (line ${failure.startLine}): ${failure.error}`
