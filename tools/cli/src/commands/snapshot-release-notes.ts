import { buildCommand } from '@stricli/core'
import { runSnapshotReleaseNotes } from '../snapshot-release-notes/main.ts'

export const snapshotReleaseNotesCommand = buildCommand({
  docs: {
    brief: "Rewrite a source release's notes for the public snapshot",
    fullDescription:
      'Reads release-please notes from --file and writes them to stdout with every link into ' +
      '--source-repo unwrapped, PR and commit references removed, and leading [KEY-N] ticket ' +
      'prefixes stripped. Refuses, printing nothing, when the result still names the source repo, ' +
      'matches a term in --terms, holds a credential or a home-directory path, or holds a #N reference or a ticket key. Notes with no entries become "No user-facing changes." ' +
      'Exit 0: notes written. Exit 2: refused or could not run.',
  },
  parameters: {
    flags: {
      file: { kind: 'parsed', parse: String, brief: 'Release notes to rewrite' },
      'source-repo': {
        kind: 'parsed',
        parse: String,
        brief: 'Source repository the notes link into, owner/name',
      },
      terms: {
        kind: 'parsed',
        parse: String,
        brief: 'Private terms file, as publish-check reads it',
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func: (flags: { file: string; 'source-repo': string; terms: string }) =>
    runSnapshotReleaseNotes({
      file: flags.file,
      sourceRepo: flags['source-repo'],
      terms: flags.terms,
    }),
})
