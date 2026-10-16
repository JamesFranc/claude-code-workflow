import { buildCommand } from '@stricli/core'
import { runCheckTools } from '../check-tools/main.ts'

const parseTools = (raw: string): readonly string[] =>
  Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    )
  )

export const checkToolsCommand = buildCommand({
  docs: {
    brief: 'Report intended workflow tools from environment configuration',
    fullDescription:
      'Classifies each requested workflow tool as `configured`, `unconfigured`, or `failed` ' +
      'by inspecting environment variables only. It does not probe MCP servers. A configured ' +
      'tool should be attempted directly; if that attempt fails, stop and report the broken tool.',
  },
  parameters: {
    flags: {
      require: {
        kind: 'parsed',
        parse: parseTools,
        brief: 'Comma-separated list of required tools to report (e.g., jira,notion)',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func: (flags: { require: readonly string[] }) => runCheckTools(flags.require),
})
