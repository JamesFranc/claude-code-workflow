import { buildCommand } from '@stricli/core'
import { runPublishSnapshot } from '../publish-snapshot/main.ts'

export const publishSnapshotCommand = buildCommand({
  docs: {
    brief: 'Publish a tagged release to the snapshot repo as one commit',
    fullDescription:
      'Run by the maintainer from the released commit: HEAD must be the tip of origin/main, clean, and ' +
      "named by its version's claude-workflow-v<version> tag. Runs publish-check first and stops on any " +
      "finding. Replaces the target repo's whole tree with the export set, commits it as " +
      'release: v<version>, and pushes it with a v<version> tag. An unchanged tree is a no-op. Never ' +
      "changes the target repo's visibility. Exit 0: published or unchanged. Exit 1: publish-check " +
      'findings. Exit 2: refused or could not run.',
  },
  parameters: {
    flags: {
      to: { kind: 'parsed', parse: String, brief: 'Snapshot repo, owner/name' },
      repo: {
        kind: 'parsed',
        parse: String,
        brief: 'Source repository (default: the current directory)',
        default: '.',
      },
      url: {
        kind: 'parsed',
        parse: String,
        brief: "Clone URL for the snapshot repo (default: GitHub, in origin's scheme)",
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func: (flags: { to: string; repo: string; url?: string }) => runPublishSnapshot(flags),
})
