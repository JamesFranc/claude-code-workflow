import { ExitCode, buildApplication, buildRouteMap, run } from '@stricli/core'
import { checkRefsCommand } from './commands/check-refs.ts'
import { checkToolsCommand } from './commands/check-tools.ts'
import { claudeUsageCommand } from './commands/claude-usage.ts'
import { dashboardRoutes } from './commands/dashboard.ts'
import { gateLedgerRoutes } from './commands/gate-ledger.ts'
import { mailboxRoutes } from './commands/mailbox.ts'
import { prMonitorCommand } from './commands/pr-monitor.ts'
import { proofLedgerRoutes } from './commands/proof-ledger.ts'
import { proseAdjacencyCommand } from './commands/prose-adjacency.ts'
import { publishCheckCommand } from './commands/publish-check.ts'
import { publishSnapshotCommand } from './commands/publish-snapshot.ts'
import { renderDiagramsCommand } from './commands/render-diagrams.ts'
import { renovatePrMonitorCommand } from './commands/renovate-pr-monitor.ts'
import { reviewLedgerRoutes } from './commands/review-ledger.ts'
import { validateMermaidCommand } from './commands/validate-mermaid.ts'
import { walkthroughRoutes } from './commands/walkthrough.ts'
import { workflowStateRoutes } from './commands/workflow-state.ts'
import { workspaceTrustRoutes } from './commands/workspace-trust.ts'
import { getRequestedExitCode } from './runtime-exit-code.ts'
import { STORE_UNREADABLE_EXIT, StoreUnreadableError } from './workflow-store/store.ts'

const routes = buildRouteMap({
  routes: {
    'check-refs': checkRefsCommand,
    'check-tools': checkToolsCommand,
    'claude-usage': claudeUsageCommand,
    dashboard: dashboardRoutes,
    'gate-ledger': gateLedgerRoutes,
    mailbox: mailboxRoutes,
    'pr-monitor': prMonitorCommand,
    'proof-ledger': proofLedgerRoutes,
    'prose-adjacency': proseAdjacencyCommand,
    'publish-check': publishCheckCommand,
    'publish-snapshot': publishSnapshotCommand,
    'render-diagrams': renderDiagramsCommand,
    'renovate-pr-monitor': renovatePrMonitorCommand,
    'review-ledger': reviewLedgerRoutes,
    'validate-mermaid': validateMermaidCommand,
    walkthrough: walkthroughRoutes,
    'workflow-state': workflowStateRoutes,
    'workspace-trust': workspaceTrustRoutes,
  },
  docs: {
    brief: 'Claude workflow CLI tools',
  },
})

// gate-ledger, proof-ledger and review-ledger already map StoreUnreadableError to this same exit from
// inside their own runGuarded — this is the fallback for a command that doesn't. Mapping it here
// too means a ledger command added later cannot forget to opt in, which is the failure shape this
// ticket exists to remove. It only guarantees the exit code, though: a command that opts in this
// way gets the code with an EMPTY stdout, since the error never reaches a JSON-writing catch of its
// own — a different contract from the ledgers' own runGuarded, which write the error as JSON before
// this is ever reached.
const app = buildApplication(routes, {
  name: 'claude-workflow',
  determineExitCode: (exc) =>
    exc instanceof StoreUnreadableError ? STORE_UNREADABLE_EXIT : ExitCode.CommandRunError,
})

await run(app, process.argv.slice(2), { process })

const requestedExitCode = getRequestedExitCode()
if (requestedExitCode !== undefined) {
  process.exitCode = requestedExitCode
}
