import { buildCommand } from '@stricli/core'
import { runCheckRefs } from '../check-refs/main.ts'

export const checkRefsCommand = buildCommand({
  docs: {
    brief: 'Flag non-canonical self-references in skills/agents/commands Markdown',
    fullDescription:
      'Scans skills/, agents/, and commands/ Markdown for bundled-tool references that are not ' +
      'the bare-command form (the only form that resolves in an agent Bash tool, since the plugin ' +
      'bin/ is on PATH). Flags relative `bin/<tool>`, `${CLAUDE_PLUGIN_ROOT}/bin/<tool>`, and ' +
      'absolute plugin-cache paths. Exits non-zero on any finding.',
  },
  parameters: {
    flags: {
      root: {
        kind: 'parsed',
        parse: String,
        brief: 'Repo root to scan (defaults to cwd)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func: (flags: { root?: string }) => runCheckRefs(flags.root ?? process.cwd()),
})
