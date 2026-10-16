import { buildCommand } from '@stricli/core'
import { runValidateMermaid } from '../validate-mermaid/main.ts'

export const validateMermaidCommand = buildCommand({
  docs: {
    brief: 'Parse-validate every fenced mermaid block in a markdown file; non-zero exit on failure',
    fullDescription:
      'Extracts every fenced ```mermaid block from the given markdown file and parses each with ' +
      "mermaid's headless parser. Prints a line per failing block (file, block number, opening-fence " +
      'line, parser error) to stderr and a JSON summary to stdout. Exits non-zero if any block fails ' +
      'to parse; a file with no mermaid blocks is a no-op (exit 0).',
  },
  parameters: {
    flags: {
      file: {
        kind: 'parsed',
        parse: String,
        brief: 'Path to the markdown file to validate',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: { file: string }) {
    await runValidateMermaid(flags.file)
  },
})
