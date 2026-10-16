import { buildCommand, buildRouteMap } from '@stricli/core'
import { parseNonBlankString } from '../parse.ts'
import { runRecordEntry, runCheck, runBypass, runBanner } from '../workflow-state/run.ts'

const sessionFlag = {
  kind: 'parsed' as const,
  parse: String,
  brief: 'Session id (defaults to CLAUDE_CODE_SESSION_ID)',
  optional: true as const,
}

const recordEntryCommand = buildCommand({
  docs: {
    brief:
      'Record a workflow-entry marker for this session — does not enter a workflow or mint a board node (for spawned teammates/subagents; the lead already registered the board node)',
  },
  parameters: {
    flags: {
      phase: {
        kind: 'parsed',
        parse: parseNonBlankString('--phase'),
        brief: 'Phase name (e.g. implementation)',
        optional: false,
      },
      key: {
        kind: 'parsed',
        parse: String,
        brief: 'Ticket/epic key this session is working under',
        optional: true,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { phase: string; key?: string; session?: string }) {
    runRecordEntry(flags.phase, flags.key, flags.session)
  },
})

const checkCommand = buildCommand({
  docs: {
    brief:
      'Exit 0 if a workflow or bypass is recorded for this session; exit 3 otherwise (used by the edit gate)',
  },
  parameters: {
    flags: { session: sessionFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string }) {
    runCheck(flags.session)
  },
})

const bypassCommand = buildCommand({
  docs: { brief: 'Record a logged, session-scoped exception to the workflow-entry gate' },
  parameters: {
    flags: {
      reason: {
        kind: 'parsed',
        parse: String,
        brief: 'Why the gate is being bypassed',
        optional: false,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { reason: string; session?: string }) {
    runBypass(flags.reason, flags.session)
  },
})

const bannerCommand = buildCommand({
  docs: { brief: 'Print the one-line per-prompt workflow status banner' },
  parameters: {
    flags: { session: sessionFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string }) {
    runBanner(flags.session)
  },
})

export const workflowStateRoutes = buildRouteMap({
  routes: {
    'record-entry': recordEntryCommand,
    check: checkCommand,
    bypass: bypassCommand,
    banner: bannerCommand,
  },
  docs: {
    brief: 'Workflow-entry enforcement: record-entry/check/bypass/banner for the edit gate',
  },
})
