import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  CODERABBIT_PAUSED_MARKER,
  CODERABBIT_RATE_LIMITED_MARKER,
  detectCoderabbitStatus,
  extractBotComments,
  extractMainComments,
  fetchCiChecks,
  fetchReviews,
  fetchUnresolvedThreads,
  MAX_PAGES,
  paginateConnection,
  parseCooloffMinutes,
  resolvePrState,
  toPersistedReview,
  toReviewThreads,
} from './gh.ts'
import type { ConnectionPage } from './gh.ts'
import { cleanBaseline, compareStates, type PrState } from './state.ts'

test('parseCooloffMinutes reads minutes from the banner', () => {
  const body = `${CODERABBIT_RATE_LIMITED_MARKER}\n> **Next review available in:** **34 minutes**`
  assert.equal(parseCooloffMinutes(body), 34)
})

test('parseCooloffMinutes converts hours to minutes', () => {
  assert.equal(parseCooloffMinutes('Next review available in: **2 hours**'), 120)
})

test('parseCooloffMinutes reads the included-review banner wording', () => {
  const body = `${CODERABBIT_RATE_LIMITED_MARKER}\n> ## Review limit reached\n> \n> **Next included review available in 55 minutes.**`
  assert.equal(parseCooloffMinutes(body), 55)
})

test('parseCooloffMinutes returns null when unparseable', () => {
  assert.equal(parseCooloffMinutes('some other comment'), null)
})

test('detectCoderabbitStatus finds rate-limited with cooloff', () => {
  const comments = [
    {
      id: 'c1',
      author: { login: 'coderabbitai' },
      body: `${CODERABBIT_RATE_LIMITED_MARKER}\n> **Next review available in:** **13 minutes**`,
    },
  ]
  assert.deepEqual(detectCoderabbitStatus(comments), {
    status: 'rate-limited',
    cooloffMinutes: 13,
  })
})

test('detectCoderabbitStatus finds paused', () => {
  const comments = [{ id: 'c1', author: { login: 'coderabbitai' }, body: CODERABBIT_PAUSED_MARKER }]
  assert.deepEqual(detectCoderabbitStatus(comments), { status: 'paused', cooloffMinutes: null })
})

test('detectCoderabbitStatus prefers rate-limited over paused', () => {
  const comments = [
    { id: 'c1', author: { login: 'coderabbitai' }, body: CODERABBIT_PAUSED_MARKER },
    {
      id: 'c2',
      author: { login: 'coderabbitai' },
      body: `${CODERABBIT_RATE_LIMITED_MARKER} **5 minutes**`,
    },
  ]
  assert.equal(detectCoderabbitStatus(comments).status, 'rate-limited')
})

test('detectCoderabbitStatus returns none for an ordinary comment', () => {
  const comments = [{ id: 'c1', author: { login: 'someone' }, body: 'looks good' }]
  assert.deepEqual(detectCoderabbitStatus(comments), { status: 'none', cooloffMinutes: null })
})

test('extractBotComments suppresses a CodeRabbit rate-limit status comment', () => {
  const comments = [
    {
      id: 'c1',
      author: { login: 'coderabbitai' },
      body: `${CODERABBIT_RATE_LIMITED_MARKER} **5 minutes**`,
    },
    { id: 'c2', author: { login: 'coderabbitai' }, body: 'Actionable comments posted: 2' },
  ]
  assert.deepEqual(
    extractBotComments(comments).map(({ id, author }) => ({ id, author })),
    [{ id: 'c2', author: 'coderabbitai' }]
  )
})

test('extractBotComments keeps non-coderabbit bot comments', () => {
  const comments = [{ id: 'c1', author: { login: 'renovate[bot]' }, body: 'dependency update' }]
  assert.deepEqual(
    extractBotComments(comments).map(({ id, author }) => ({ id, author })),
    [{ id: 'c1', author: 'renovate[bot]' }]
  )
})

test('extractBotComments hashes the body so an in-place edit changes the hash (FLOW-373)', () => {
  const at = (body: string) =>
    extractBotComments([{ id: 'c1', author: { login: 'coderabbitai' }, body }])[0]?.bodyHash
  assert.equal(at('Actionable comments posted: 2'), at('Actionable comments posted: 2'))
  assert.notEqual(
    at('Actionable comments posted: 2'),
    at('No actionable comments were generated in the recent review. 🎉')
  )
})

test('extractMainComments takes non-empty review bodies and non-bot conversation comments', () => {
  const comments = [
    { id: 'IC_human', author: { login: 'octo-reviewer' }, body: 'please rename this' },
    { id: 'IC_bot', author: { login: 'coderabbitai' }, body: 'Actionable comments posted: 2' },
  ]
  const reviews = [
    {
      id: 'PRR_body',
      author: 'coderabbitai',
      authorType: 'Bot',
      state: 'CHANGES_REQUESTED',
      body: 'summary of findings',
    },
    {
      id: 'PRR_commented',
      author: 'octo-reviewer',
      authorType: 'User',
      state: 'COMMENTED',
      body: 'a few thoughts, nothing blocking',
    },
    { id: 'PRR_empty', author: 'octo-reviewer', authorType: 'User', state: 'COMMENTED', body: '' },
  ]
  assert.deepEqual(extractMainComments(comments, reviews), [
    { id: 'PRR_body', author: 'coderabbitai' },
    { id: 'PRR_commented', author: 'octo-reviewer' },
    { id: 'IC_human', author: 'octo-reviewer' },
  ])
})

test('extractMainComments skips a PENDING review body', () => {
  const reviews = [
    {
      id: 'PRR_pending',
      author: 'octo-reviewer',
      authorType: 'User',
      state: 'PENDING',
      body: 'draft not yet submitted',
    },
  ]
  assert.deepEqual(extractMainComments([], reviews), [])
})

test('toPersistedReview strips id and body, keeping author/authorType/state', () => {
  const review = {
    id: 'PRR_1',
    author: 'coderabbitai',
    authorType: 'Bot',
    state: 'CHANGES_REQUESTED',
    body: 'a multi-kb review summary',
  }
  assert.deepEqual(toPersistedReview(review), {
    author: 'coderabbitai',
    authorType: 'Bot',
    state: 'CHANGES_REQUESTED',
  })
})

test('toReviewThreads includes an unresolved thread authored by the current user (FLOW-163)', () => {
  const nodes = [
    {
      isResolved: false,
      path: 'src/app.ts',
      line: 42,
      comments: { nodes: [{ author: { login: 'reviewer' }, body: 'please rename this' }] },
    },
  ]
  assert.deepEqual(toReviewThreads(nodes), [
    {
      path: 'src/app.ts',
      line: 42,
      isResolved: false,
      firstCommentBody: 'please rename this',
      firstCommentId: '',
    },
  ])
})

test('toReviewThreads drops resolved threads', () => {
  const nodes = [
    {
      isResolved: true,
      path: 'src/app.ts',
      line: 1,
      comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'nit' }] },
    },
  ]
  assert.deepEqual(toReviewThreads(nodes), [])
})

test('toReviewThreads defaults firstCommentBody to empty when a thread has no comments', () => {
  const nodes = [{ isResolved: false, path: 'src/app.ts', line: null, comments: { nodes: [] } }]
  assert.deepEqual(toReviewThreads(nodes), [
    { path: 'src/app.ts', line: null, isResolved: false, firstCommentBody: '', firstCommentId: '' },
  ])
})

test('toReviewThreads carries the first comment node id and still does not filter by author', () => {
  const threads = toReviewThreads([
    {
      isResolved: false,
      path: 'src/a.ts',
      line: 1,
      comments: { nodes: [{ id: 'PRRC_1', author: { login: 'octo-reviewer' }, body: 'x' }] },
    },
  ])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].firstCommentId, 'PRRC_1')
})

// fetchReviews and fetchUnresolvedThreads are independent GraphQL calls, and a healthy
// fetchPrView alone must not paper over either one's failure — prState is the only signal
// poll.ts's transient-failure guard reads before it compares or saves. This covers the signal
// fetchPrState produces.
test("resolvePrState reports UNKNOWN when either fetch failed, not the view's own state", () => {
  const prView = {
    state: 'open',
    isDraft: false,
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    headRefOid: 'abc123',
    comments: [],
  }
  assert.equal(resolvePrState(prView, true, false), 'UNKNOWN')
  assert.equal(resolvePrState(prView, false, true), 'UNKNOWN')
  assert.equal(resolvePrState(prView, false, false), 'OPEN')
})

// Surfaces exit code, stdout, and stderr to the caller instead of picking a pass/fail verdict
// itself, mirroring lock.test.ts's runLockRaceChild. Listens on 'close', not 'exit', for the same
// reason: stdio can still be open when 'exit' fires, and stderr content is load-bearing here.
const runFetchFailureChild = (
  env: NodeJS.ProcessEnv,
  deadlineMs?: number
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        join(import.meta.dirname, 'test', 'gh-fetch-failure.child.ts'),
        '304',
        'owner/repo',
        ...(deadlineMs === undefined ? [] : [String(deadlineMs)]),
      ],
      { env }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }))
  })

const FAKE_GH_DIR = join(import.meta.dirname, 'test', 'fake-gh')

// Positive control for the two failure-signal tests below: without it, a fixture that fails toward
// clean (e.g. an arm silently missing) would make both tests pass without ever exercising the
// success path they claim to be independent of. Also the control for the fake gh's own `pr view` /
// `pr checks` arms and both GraphQL query-match arms, since none of them is stubbed here.
test('fetchReviews and fetchUnresolvedThreads both report OPEN when neither fetch fails', async () => {
  const { code, stdout, stderr } = await runFetchFailureChild({
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
  })
  assert.equal(code, 0, `child must exit cleanly, got stderr: ${stderr}`)
  assert.equal(stdout, 'OPEN')
  assert.doesNotMatch(stderr, /PR Monitor: fetch(Reviews|UnresolvedThreads) failed/)
})

test('fetchReviews reports its failure on stderr, independent of fetchUnresolvedThreads', async () => {
  const { code, stdout, stderr } = await runFetchFailureChild({
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAIL_REVIEWS: '1',
  })
  assert.equal(code, 0, `child must exit cleanly even when a fetch fails, got stderr: ${stderr}`)
  assert.equal(stdout, 'UNKNOWN', 'resolvePrState must report UNKNOWN when fetchReviews fails')
  assert.match(stderr, /PR Monitor: fetchReviews failed/)
  assert.doesNotMatch(stderr, /PR Monitor: fetchUnresolvedThreads failed/)
})

test('fetchUnresolvedThreads reports its failure on stderr, independent of fetchReviews', async () => {
  const { code, stdout, stderr } = await runFetchFailureChild({
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAIL_THREADS: '1',
  })
  assert.equal(code, 0, `child must exit cleanly even when a fetch fails, got stderr: ${stderr}`)
  assert.equal(
    stdout,
    'UNKNOWN',
    'resolvePrState must report UNKNOWN when fetchUnresolvedThreads fails'
  )
  assert.match(stderr, /PR Monitor: fetchUnresolvedThreads failed/)
  assert.doesNotMatch(stderr, /PR Monitor: fetchReviews failed/)
})

// --- Pagination (FLOW-226) ---

const page = <T>(
  nodes: T[],
  hasNextPage: boolean,
  endCursor: string | null
): ConnectionPage<T> => ({
  pageInfo: { hasNextPage, endCursor },
  nodes,
})

test('paginateConnection accumulates nodes across every page', () => {
  const pages = [page(['a', 'b'], true, 'c1'), page(['c'], true, 'c2'), page(['d'], false, null)]
  const seenCursors: Array<string | null> = []
  const nodes = paginateConnection<string>((cursor) => {
    seenCursors.push(cursor)
    return pages[seenCursors.length - 1]
  })
  assert.deepEqual(nodes, ['a', 'b', 'c', 'd'])
  assert.deepEqual(seenCursors, [null, 'c1', 'c2'])
})

test('paginateConnection throws when the cursor does not advance', () => {
  assert.throws(
    () => paginateConnection<string>(() => page(['a'], true, null)),
    /cursor did not advance/
  )
})

test('paginateConnection throws when a page repeats the previous cursor', () => {
  assert.throws(
    () => paginateConnection<string>(() => page(['a'], true, 'c1')),
    /cursor did not advance/
  )
})

test('paginateConnection throws on a non-array nodes field', () => {
  assert.throws(
    () =>
      paginateConnection<string>(
        () => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes: 'abc' }) as never
      ),
    /non-array nodes field/
  )
})

test('paginateConnection throws on a page missing pageInfo', () => {
  assert.throws(
    () => paginateConnection<string>(() => ({ nodes: ['a'] }) as never),
    /missing pageInfo.hasNextPage/
  )
})

test('paginateConnection refuses to run past MAX_PAGES', () => {
  let call = 0
  assert.throws(
    () => paginateConnection<string>(() => page(['a'], true, `c${call++}`)),
    /refusing to loop forever/
  )
  assert.equal(call, MAX_PAGES)
})

test('fetchReviews follows pageInfo across pages, keeping each review its id and body', () => {
  const responses = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
              nodes: [
                {
                  id: 'PRR_1',
                  state: 'COMMENTED',
                  body: 'first pass',
                  author: { __typename: 'User', login: 'alice' },
                },
              ],
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'PRR_2',
                  state: 'APPROVED',
                  body: '',
                  author: { __typename: 'User', login: 'bob' },
                },
              ],
            },
          },
        },
      },
    }),
  ]
  const calls: string[][] = []
  const result = fetchReviews('7', 'acme/app', (args) => {
    calls.push(args)
    return responses[calls.length - 1]
  })
  assert.equal(result.fetchFailed, false)
  assert.deepEqual(result.reviews, [
    { id: 'PRR_1', author: 'alice', authorType: 'User', state: 'COMMENTED', body: 'first pass' },
    { id: 'PRR_2', author: 'bob', authorType: 'User', state: 'APPROVED', body: '' },
  ])
})

test('fetchReviews reports fetchFailed when the query throws', () => {
  const result = fetchReviews('7', 'acme/app', () => {
    throw new Error('gh: API rate limit exceeded')
  })
  assert.equal(result.fetchFailed, true)
  assert.deepEqual(result.reviews, [])
})

test('fetchReviews sends endCursor only after the first page', () => {
  const responses = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [] },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    }),
  ]
  const calls: string[][] = []
  fetchReviews('7', 'acme/app', (args) => {
    calls.push(args)
    return responses[calls.length - 1]
  })
  assert.equal(calls.length, 2)
  assert.equal(
    calls[0].some((a) => a.startsWith('endCursor=')),
    false
  )
  assert.deepEqual(
    calls[1].filter((a) => a.startsWith('endCursor=')),
    ['endCursor=c1']
  )
})

const threadsResponse = (
  hasNextPage: boolean,
  endCursor: string | null,
  path: string,
  body: string
): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes: [
              {
                isResolved: false,
                path,
                line: 1,
                comments: { nodes: [{ id: `PRRC_${path}`, author: { login: 'x' }, body }] },
              },
            ],
          },
        },
      },
    },
  })

test('fetchUnresolvedThreads follows pageInfo across pages', () => {
  const responses = [
    threadsResponse(true, 'c1', 'a.ts', 'first'),
    threadsResponse(false, null, 'b.ts', 'second'),
  ]
  const calls: string[][] = []
  const result = fetchUnresolvedThreads('7', 'acme/app', (args) => {
    calls.push(args)
    return responses[calls.length - 1]
  })
  assert.deepEqual(
    result.threads.map((t) => t.path),
    ['a.ts', 'b.ts']
  )
  assert.equal(calls.length, 2)
  assert.equal(result.fetchFailed, false)
})

test('fetchUnresolvedThreads reports fetchFailed when the query throws (FLOW-226)', () => {
  const result = fetchUnresolvedThreads('7', 'acme/app', () => {
    throw new Error('gh: API rate limit exceeded')
  })
  assert.equal(result.fetchFailed, true)
  assert.deepEqual(result.threads, [])
})

// A mid-pagination failure is the case paginateConnection's own comment names: "a partial result is
// a failed query, not a shorter answer". The first page's thread must NOT come back as the answer.
test('fetchUnresolvedThreads reports fetchFailed when pagination breaks mid-run (FLOW-226)', () => {
  let calls = 0
  const result = fetchUnresolvedThreads('7', 'acme/app', () => {
    calls++
    if (calls === 1) return threadsResponse(true, 'c1', 'a.ts', 'first')
    throw new Error('gh: connection reset')
  })
  assert.equal(result.fetchFailed, true)
  assert.deepEqual(result.threads, [])
})

test('fetchUnresolvedThreads reports a genuine zero-thread read as not failed (FLOW-226)', () => {
  const result = fetchUnresolvedThreads('7', 'acme/app', () =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    })
  )
  assert.equal(result.fetchFailed, false)
  assert.deepEqual(result.threads, [])
})

// --- FLOW-226: a degraded checks read must not reach the merge decision as a green run ---

// fetchCiChecks accumulated into `result` inside the try while the catch sat outside the loop, so
// a throw on entry k returned entries 0..k-1 as the complete set. A truncated all-green prefix
// satisfies `length > 0 && every(green)`, which is a fully green CI run to isMergeReady.
const mergeReadyWith = (ci: { checks: Record<string, string>; fetchFailed: boolean }): PrState => ({
  ...cleanBaseline(),
  isDraft: false,
  ciChecks: ci.checks,
  ciChecksFetchFailed: ci.fetchFailed,
  reviews: [{ author: 'alice', authorType: 'User', state: 'APPROVED' }],
  mergeStateStatus: 'CLEAN',
  headSha: 'sha1',
})

const emitsMergeReady = (state: PrState): boolean =>
  compareStates({ ...state, isDraft: true }, state).some((c) => c.type === 'MERGE_READY')

test('a truncated all-green checks read is told apart from a complete one (FLOW-226)', () => {
  // Identical prefix in both: the only difference is that the second read stopped early. `null`
  // throws on `check.state` inside the loop, which is what truncation looks like from in here.
  const complete = fetchCiChecks('1', 'owner/repo', () =>
    JSON.stringify([
      { name: 'build', state: 'SUCCESS' },
      { name: 'lint', state: 'SUCCESS' },
    ])
  )
  const truncated = fetchCiChecks('1', 'owner/repo', () =>
    JSON.stringify([{ name: 'build', state: 'SUCCESS' }, null])
  )

  assert.equal(complete.fetchFailed, false)
  assert.equal(truncated.fetchFailed, true, 'a read that stopped early reported itself as complete')

  // Asserted at the merge decision, not on the returned map: a truncated all-green prefix and a
  // complete all-green set produce the same `every(green)` answer, so the map cannot separate them.
  assert.equal(emitsMergeReady(mergeReadyWith(complete)), true, 'a complete green run must merge')
  assert.equal(
    emitsMergeReady(mergeReadyWith(truncated)),
    false,
    'a truncated check set was reported as every check green'
  )
})

test('a repeated check name keeps the worse status, not the last one (FLOW-226)', () => {
  const result = fetchCiChecks('1', 'owner/repo', () =>
    JSON.stringify([
      { name: 'build', state: 'FAILURE' },
      { name: 'build', state: 'SUCCESS' },
    ])
  )

  assert.equal(result.fetchFailed, false, 'this read succeeded — the collision is the subject')
  assert.equal(result.checks.build, 'failure', 'a later success overwrote an earlier failure')
  assert.equal(
    emitsMergeReady(mergeReadyWith(result)),
    false,
    'a failing check was reported as green because a duplicate name came after it'
  )
})

test('a checks payload that was never interpreted is a failed read, not a clean one (FLOW-226)', () => {
  // Two shapes that parse but are not an array of named checks. A bare JSON string iterates as its
  // own characters; an array of unnamed entries indexes `result` with a missing name. Both used to
  // return { checks: { undefined: 'pending' }, fetchFailed: false } — clean, off a payload no part
  // of which was read as a check.
  const notAnArray = fetchCiChecks('1', 'owner/repo', () => JSON.stringify('build: passed'))
  const unnamed = fetchCiChecks('1', 'owner/repo', () => JSON.stringify([{ state: 'SUCCESS' }]))

  assert.equal(
    notAnArray.fetchFailed,
    true,
    `a checks payload that is not an array reported itself as a clean read, returning ${JSON.stringify(notAnArray)}`
  )
  assert.equal(
    unnamed.fetchFailed,
    true,
    `a check with no name reported itself as a clean read, returning ${JSON.stringify(unnamed)}`
  )
  // The exact contract value, not emptiness: the defect's signature is a key that is the string
  // "undefined", which an emptiness check would pass right over.
  assert.deepEqual(
    notAnArray.checks,
    {},
    'a non-array payload contributed entries to the check map'
  )
  assert.deepEqual(unnamed.checks, {}, 'an unnamed check contributed an entry to the check map')
})

test('a PR with no CI polls as OPEN when gh pr checks exits 1 with no checks reported', async () => {
  const { code, stdout, stderr } = await runFetchFailureChild({
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    NO_CHECKS: '1',
  })

  assert.equal(code, 0, stderr)
  assert.equal(stdout, 'OPEN', 'a failed checks fetch alone must not make the poll UNKNOWN')
})

test('a gh that hangs past the check deadline reports UNKNOWN with its reason, and returns near the deadline', async () => {
  const started = Date.now()
  const { code, stdout, stderr } = await runFetchFailureChild(
    {
      ...process.env,
      PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
      GH_SLEEP_SECS: '60',
    },
    1_500.5
  )

  assert.equal(code, 0, stderr)
  const [prState, reason] = stdout.split('\n')
  assert.equal(prState, 'UNKNOWN')
  assert.match(reason ?? '', /^fetchPrView: .*(ETIMEDOUT|SIGTERM|timed out)/)
  assert.match(reason ?? '', /fetchReviews: .*deadline/)
  assert.ok(Date.now() - started < 15_000, 'the fetch stopped at the deadline, not after retries')
})
