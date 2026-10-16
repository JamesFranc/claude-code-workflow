import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

// Every spawn below pins an explicit cwd rather than inheriting the caller's (FLOW-233): a
// long-lived process can be launched from a worktree that is later removed out from under it,
// and a child that reads cwd at startup (as ai-workflow-app does) then crashes before running.
// homedir() is a directory that cannot be removed out from under a session, and is already
// storeRoot()'s own anchor, so it introduces no new concept.

// Resolve the external ai-workflow-app binary: explicit env var, else PATH. null = unavailable.
export const resolveDashboardBin = (): string | null => {
  const explicit = process.env.AI_WORKFLOW_APP_BIN
  if (explicit) return existsSync(explicit) ? explicit : null
  const probe = spawnSync('command', ['-v', 'ai-workflow-app'], {
    encoding: 'utf8',
    shell: true,
    timeout: 2000,
    cwd: homedir(),
  })
  const found = probe.stdout?.trim()
  return found ? found : null
}

// Availability-gated, loud on error. Returns stdout on success, null when unavailable.
// On an available-but-failing call (including timeout): writes stderr + requests non-zero exit.
// Resolves the binary itself on every call — fine for callers that only need one outcome
// ("did it run"), but a caller that must tell "unavailable" apart from "failed" should not call
// this: two calls in the same request (e.g. an availability check followed by this) each resolve
// independently and can disagree if the binary's availability changes in between. Such a caller
// should resolve once via resolveDashboardBin() and call invokeDashboardBin directly (status.ts
// does this) — that removes the second resolve, and with it the race, entirely.
export const invokeDashboard = (args: string[]): string | null => {
  const bin = resolveDashboardBin()
  if (!bin) return null
  return invokeDashboardBin(bin, args)
}

// Invoke an already-resolved dashboard binary. Loud on error, same as invokeDashboard: writes
// stderr + requests a non-zero exit on an available-but-failing call (including timeout) — unless
// `quiet` is set, in which case it still warns on stderr but leaves the exit code alone. `quiet` is
// load-bearing for the approval guard (item.ts): that guard reads the board before a mutation it
// then still performs, so poisoning the exit code on a failed read would report a failure for an
// item that was actually posted. (No skill retries a failed dashboard post today, so this isn't
// preventing a refuse→retry→refuse loop — it's simply that a read failure must not misreport a
// mutation that succeeded.)
// Timeout defaults to 5000 ms; override via DASHBOARD_INVOKE_TIMEOUT_MS for testing. The CLI test
// harness sets 30000 in package.json's `test` script (FLOW-198) — a local stub spawn is not a
// network call, so no CLI test run by that script uses the 5000 ms production budget.
export const invokeDashboardBin = (
  bin: string,
  args: string[],
  opts?: { quiet?: boolean }
): string | null => {
  const timeout = parseInt(process.env.DASHBOARD_INVOKE_TIMEOUT_MS ?? '5000', 10)
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout, cwd: homedir() })
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`
    process.stderr.write(`dashboard: ai-workflow-app ${args.join(' ')} failed: ${detail}\n`)
    if (!opts?.quiet) setRequestedExitCode(result.status ?? 1)
    return null
  }
  return result.stdout ?? ''
}

// Distinguish "unavailable" (no-op) from "ran". Used by enter/leave/item to gate work when
// the dashboard is unavailable.
export const dashboardAvailable = (): boolean => resolveDashboardBin() !== null

// Spawn the resolved binary and hand the raw outcome back instead of reporting it. `invokeDashboard`
// decides the message itself, which is right for callers that only need "did it run"; `item show`
// must tell an ai-workflow-app build with no `show` route apart from a genuine unknown id, and the
// two need different advice. Returns null only when the binary is unavailable — the same "no-op"
// signal invokeDashboard uses, kept identical so callers can share one guard.
export interface DashboardInvocation {
  stdout: string
  status: number | null
  detail: string
}

export const invokeDashboardRaw = (args: string[]): DashboardInvocation | null => {
  const bin = resolveDashboardBin()
  if (!bin) return null
  const timeout = parseInt(process.env.DASHBOARD_INVOKE_TIMEOUT_MS ?? '5000', 10)
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout, cwd: homedir() })
  return {
    stdout: result.stdout ?? '',
    status: result.status,
    detail: result.stderr?.trim() || result.error?.message || `exit ${result.status}`,
  }
}
