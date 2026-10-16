// execFileSync's default maxBuffer (1 MiB) throws before run.ts's git invocations get a chance to
// read their own output or distinguish why they failed — a blob or a tracked-file listing past this
// size throws with no exit status at all (code=ENOBUFS, status=null, signal=SIGTERM on Node 24),
// indistinguishable by shape from a normal git failure unless every call site raises the ceiling
// first. Every execFileSync('git', ...) call in run.ts passes this.
export const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

// A message-worthy description of an execFileSync failure: the fields Node's own ChildProcess error
// actually carries (code, signal, status), not its stack. An ENOBUFS overflow and an ordinary git
// exit both throw a plain Error whose message says only "Command failed" — status/code/signal are
// what tells them apart, so they are what a refusal message needs to show, not the message text.
export const describeExecError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err)
  const { code, signal, status } = err as NodeJS.ErrnoException & {
    signal?: NodeJS.Signals | null
    status?: number | null
  }
  const parts = [
    code !== undefined && code !== null ? `code=${code}` : undefined,
    signal !== undefined && signal !== null ? `signal=${signal}` : undefined,
    status !== undefined && status !== null ? `status=${status}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(', ') : err.message
}
