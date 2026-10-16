import { buildCommand } from '@stricli/core'
import { runRenderDiagrams } from '../render-diagrams/main.ts'

export const renderDiagramsCommand = buildCommand({
  docs: {
    brief: 'Render every fenced d2 block in a markdown file to SVG and WebP in the house style',
    fullDescription:
      'Compiles every fenced ```d2 block in the given markdown file with the palette named by its ' +
      '`diagram-palette` frontmatter key (default classic), and writes diagram-<n>.svg, ' +
      'diagram-<n>.webp and hosted.md (the doc with each d2 block replaced by its image and ' +
      'frontmatter removed) to the output directory. Prints a line per failing block to stderr and ' +
      'a JSON summary to stdout. Exits non-zero, writing nothing, if any block fails; a file with ' +
      'no d2 blocks still gets its hosted.md.',
  },
  parameters: {
    flags: {
      file: {
        kind: 'parsed',
        parse: String,
        brief: 'Path to the markdown file to render',
        optional: false,
      },
      'out-dir': {
        kind: 'parsed',
        parse: String,
        brief: 'Output directory (default: <doc-basename>.assets/ beside the file)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: { file: string; 'out-dir'?: string }) {
    await runRenderDiagrams(flags.file, { outDir: flags['out-dir'] })
  },
})
