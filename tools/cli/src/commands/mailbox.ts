import { buildCommand, buildRouteMap } from '@stricli/core'
import { runCheck } from '../mailbox/check.ts'
import { runStopGate } from '../mailbox/stop-gate.ts'
import { runTeammates } from '../mailbox/teammate-deaths.ts'

const sessionFlag = {
  kind: 'parsed' as const,
  parse: String,
  brief: 'Session id (defaults to CLAUDE_CODE_SESSION_ID)',
  optional: true as const,
}

const checkCommand = buildCommand({
  docs: {
    brief:
      'Run every wake source once — released board answers, dead monitors, dead teammates — print what to wake for, and exit (called by the wake mod)',
  },
  parameters: { flags: { session: sessionFlag }, positional: { kind: 'tuple', parameters: [] } },
  func(flags: { session?: string }) {
    runCheck(flags.session)
  },
})

const stopGateCommand = buildCommand({
  docs: {
    brief: 'Print allow/block: bounded gate the Stop hook calls (does not loop forever)',
  },
  parameters: {
    flags: {
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string }) {
    runStopGate(flags.session)
  },
})

const teammatesCommand = buildCommand({
  docs: {
    brief:
      "Print this session's teammates as JSON — pid null means no process (dead) — plus orphan teammate processes that left the roster; after the harness removes the team, the roster last seen, with dissolved: true",
  },
  parameters: { flags: { session: sessionFlag }, positional: { kind: 'tuple', parameters: [] } },
  func(flags: { session?: string }) {
    runTeammates(flags.session)
  },
})

export const mailboxRoutes = buildRouteMap({
  routes: {
    check: checkCommand,
    'stop-gate': stopGateCommand,
    teammates: teammatesCommand,
  },
  docs: {
    brief: 'Wake-source check for the wake mod, the Stop hook gate, and the teammate roster',
  },
})
