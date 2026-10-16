// Bash's `exit N` becomes a throw of this, caught by the command entry point.
export class MonitorExit extends Error {
  readonly code: number

  constructor(code: number) {
    super(`renovate-pr-monitor exiting ${code}`)
    this.code = code
  }
}

// Thrown the moment a shutdown signal is observed: from the shared gh-call path (gh.ts's runGh),
// from mergeThrottle's sleep (routines.ts), from tick.ts's two checks (once per PR in its
// pr-processing loop, and once at the end of a tick — the latter is what actually stops
// emitMajorsEvent from firing on a signal that arrived mid-tick), and from monitor.ts's own two
// throws (its poll-sleep catch, and the throw after the loop exits because the signal fired between
// ticks). Caught once, centrally, in monitor.ts's outer catch.
export class ShutdownAbort extends Error {}
