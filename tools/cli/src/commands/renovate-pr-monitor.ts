import { buildCommand } from '@stricli/core'
import { ConfigError, loadConfig } from '../renovate-pr-monitor/config.ts'
import { MonitorExit } from '../renovate-pr-monitor/monitor-exit.ts'
import { runMonitor } from '../renovate-pr-monitor/monitor.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

export const renovatePrMonitorCommand = buildCommand({
  docs: {
    brief: 'Watch open Renovate PRs and handle routine work automatically',
    fullDescription:
      'Watches open Renovate PRs across the orgs/repos named in RENOVATE_MONITOR_SCOPE, ' +
      'handles routine work silently (rebase, CI retry, approve + merge green PRs), and ' +
      'emits a JSON event on stdout when a PR needs human/agent attention. Major version ' +
      'bumps are never auto-merged — they escalate as "majors-for-review". See ' +
      'skills/renovate-prs/references/monitor-runbook.md for the event runbook.',
  },
  parameters: {
    flags: {
      once: {
        kind: 'boolean',
        brief:
          'Run a single tick and exit. Without this flag the monitor loops forever, sleeping ' +
          'RENOVATE_MONITOR_POLL_SECONDS between ticks.',
        default: false,
      },
      verbose: {
        kind: 'boolean',
        brief: 'Print classification decisions for every PR, not just actions.',
        default: false,
      },
      'dry-run': {
        kind: 'boolean',
        brief:
          'Classify every PR and log what would happen, but skip all state-changing calls ' +
          '(no rebase, no retry, no approve/merge, no event emission, no agentBusy marker).',
        default: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: { once: boolean; verbose: boolean; 'dry-run': boolean }) {
    let config
    try {
      config = loadConfig(process.env)
    } catch (err) {
      if (!(err instanceof ConfigError)) {
        throw err
      }
      console.error(err.message)
      setRequestedExitCode(1)
      return
    }

    try {
      await runMonitor(config, {
        once: flags.once,
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
      })
    } catch (err) {
      if (!(err instanceof MonitorExit)) {
        throw err
      }
      if (err.code !== 0) {
        setRequestedExitCode(err.code)
      }
    }
  },
})
