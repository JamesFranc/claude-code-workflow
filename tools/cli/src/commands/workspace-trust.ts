import { buildCommand, buildRouteMap } from '@stricli/core'
import { runWorkspaceTrustEnsure } from '../workspace-trust/main.ts'

const ensureCommand = buildCommand({
  docs: {
    brief:
      "Register a repo root's Claude Code trust key so a teammate never stops on the trust dialog",
    fullDescription:
      'Resolves --repo (default: the current directory) to its canonical git root — a linked ' +
      'worktree maps to its MAIN repo root — and sets projects[<root>].hasTrustDialogAccepted in ' +
      "Claude Code's global config. Exit 0: trusted (or already was). Exit 1: refused — the " +
      'resolved root is outside the directory this command was invoked from, or could not be ' +
      'resolved on disk; trust is never widened beyond the launch dir. Exit 2: failed — either ' +
      'the global config could not be read or parsed (nothing is written), or a write was ' +
      'attempted but could not be verified as landing even after a retry. Prints a JSON summary ' +
      'on stdout.',
  },
  parameters: {
    flags: {
      repo: {
        kind: 'parsed',
        parse: String,
        brief: 'Path inside the repo to trust (defaults to the current directory)',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { repo?: string }) {
    runWorkspaceTrustEnsure(flags.repo)
  },
})

export const workspaceTrustRoutes = buildRouteMap({
  routes: {
    ensure: ensureCommand,
  },
  docs: { brief: 'Register repo-root trust for Claude Code before a teammate is spawned' },
})
