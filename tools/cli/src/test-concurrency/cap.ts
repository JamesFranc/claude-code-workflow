/**
 * Worker-count ceiling for `tools/cli`'s test suite.
 *
 * Node's `--test` defaults `--test-concurrency` to `availableParallelism() - 1`.
 * Several agent worktrees run this suite at once, so on a large host that
 * default sizes each session to the whole machine. The ceiling bounds it
 * without raising it on a small one: FLOW-326 first pinned a flat 4, which took
 * CI's 2-core runner from 1 worker to 4 and tipped a timing test over.
 */
export const CONCURRENCY_CEILING = 4

/** Node's own default, bounded above by the ceiling and below by one worker. */
export const capFor = (available: number): number =>
  Math.min(CONCURRENCY_CEILING, Math.max(1, available - 1))
