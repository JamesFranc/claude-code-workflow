import { buildCommand } from '@stricli/core'
import { runPublishCheck } from '../publish-check/main.ts'

export const publishCheckCommand = buildCommand({
  docs: {
    brief: 'Refuse to publish a commit whose export set holds anything private',
    fullDescription:
      'Reads what `git archive` emits for a commit (default HEAD) and reports credentials, ' +
      'personal handles, home-directory names, private links, private repo names, personal ' +
      'wording, a missing licence or notice, and excluded paths present in the export set. The ' +
      'private terms come from `.private-terms.json` at that commit, which is never exported. ' +
      'Exit 0: no findings. Exit 1: findings. Exit 2: could not run. ' +
      '--terms reads the private terms from a file instead, for a repo that does not carry one (a clone of the published snapshot).',
  },
  parameters: {
    flags: {
      commit: {
        kind: 'parsed',
        parse: String,
        brief: 'Commit to check (default HEAD)',
        default: 'HEAD',
      },
      repo: {
        kind: 'parsed',
        parse: String,
        brief: 'Repository to read (default: the current directory)',
        default: '.',
      },
      terms: {
        kind: 'parsed',
        parse: String,
        brief: 'Read the private terms from this file instead of the commit',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func: (flags: { commit: string; repo: string; terms?: string }) => runPublishCheck(flags),
})
