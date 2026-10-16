import { test, expect, mock } from 'claude-code/testing'

// A test hook answering a `$` call returns `{ value }`, though the typings name the bare result.
const answer = <T>(value: T) => ({ value }) as never

const CHECK_MS = 180_000
const BEAT_MS = 300_000

test('wakes once per released answer, and only once a check reports it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let stdout = ''
  const argvs: string[][] = []
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    return answer({ exitCode: 0, stdout, stderr: '' })
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual([])
  expect(argvs[0]?.slice(1)).toEqual(['check', '--session', 'sess-1'])

  stdout = '[dashboard] item q1 (question): ship it\n'
  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[dashboard] item q1 (question): ship it'])

  await clock.advance(CHECK_MS)
  expect(submitted.length).toBe(1)
})

test('does not check while a main-loop turn runs; a subagent turn ending does not end it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let checks = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', ($, e) => {
    if (e.argv[1] === 'check') {
      checks += 1
    }

    return answer({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(CHECK_MS)
  expect(checks).toBe(0)

  await $.turn.complete({
    reason: 'answer',
    answer: '',
    durationMs: 0,
    isAborted: false,
    turnId: 't2',
    agentId: 'sub-1',
  })
  await clock.advance(CHECK_MS)
  expect(checks).toBe(0)

  await $.turn.complete({
    reason: 'answer',
    answer: '',
    durationMs: 0,
    isAborted: false,
    turnId: 't1',
  })
  await clock.advance(CHECK_MS)
  expect(checks).toBe(1)
})

test('drops a delivered answer whole, even when its text runs over several lines', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'delivered-board-items:sess-1': ['q1'] })
  const submitted: string[] = []
  const stdout =
    '[dashboard] item q1 (question): line one\nline two\n[x] a bracketed third line\n' +
    '[team] dead-teammate impl — no process is running\n'
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () => answer({ exitCode: 0, stdout, stderr: '' }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[team] dead-teammate impl — no process is running'])
})

test('a failing check holds its answers back but still delivers its death line', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let exitCode = 1
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () =>
    answer({
      exitCode,
      stdout: '[dashboard] item q1 (question): yes\n[team] dead-teammate impl — gone\n',
      stderr: '',
    })
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[team] dead-teammate impl — gone'])

  exitCode = 0
  await clock.advance(CHECK_MS)
  expect(submitted[1]).toBe('[dashboard] item q1 (question): yes\n[team] dead-teammate impl — gone')
})

test('a death line is delivered when a turn runs during the check; its answers wait', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let isFirst = true
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('process.run', async () => {
    if (isFirst) {
      isFirst = false
      await $.turn.start({ text: 'hi', turnId: 't1' })
      await $.turn.complete({
        reason: 'answer',
        answer: '',
        durationMs: 0,
        isAborted: false,
        turnId: 't1',
      })
    }
    return answer({
      exitCode: 0,
      stdout:
        '[dashboard] item q1 (question): yes\n[renovate-pr-monitor] dead-monitor o/r — gone\n',
      stderr: '',
    })
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[renovate-pr-monitor] dead-monitor o/r — gone'])

  await clock.advance(CHECK_MS)
  expect(submitted[1]).toBe(
    '[dashboard] item q1 (question): yes\n[renovate-pr-monitor] dead-monitor o/r — gone'
  )
})

test('a PR change after a delivered answer is its own entry and is submitted', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'delivered-board-items:sess-1': ['q1'] })
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () =>
    answer({
      exitCode: 0,
      stdout:
        '[dashboard] item q1 (question): yes\n[pr-monitor] changes detected on o/r#1\n  [CLOSED] closed\n',
      stderr: '',
    })
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[pr-monitor] changes detected on o/r#1\n  [CLOSED] closed'])
})

test('a partial check does not prune the delivered list', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'delivered-board-items:sess-1': ['q1'] })
  let exitCode = 3
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () =>
    answer({
      exitCode,
      stdout: exitCode === 3 ? '' : '[dashboard] item q1 (question): a\n',
      stderr: '',
    })
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  exitCode = 0
  await clock.advance(CHECK_MS)
  expect(submitted).toEqual([])
})

test('a multi-line answer, continuation lines indented by check, is one entry', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () =>
    answer({
      exitCode: 0,
      stdout: '[dashboard] item q1 (question): see below\n  [team] keep it\n',
      stderr: '',
    })
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  await clock.advance(CHECK_MS)
  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[dashboard] item q1 (question): see below\n  [team] keep it'])
})

test('a partial check records what it delivered, so the next complete check stays quiet', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let exitCode = 3
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () =>
    answer({ exitCode, stdout: '[dashboard] item q2 (question): b\n', stderr: '' })
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  exitCode = 0
  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[dashboard] item q2 (question): b'])
})

test('a submit that rejects leaves the answer to be delivered by the next check', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const submitted: string[] = []
  let attempts = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () =>
    answer({ exitCode: 0, stdout: '[dashboard] item q1 (question): ship it\n', stderr: '' })
  )
  on('prompt.submit', ($, e) => {
    attempts += 1
    if (attempts === 1) {
      throw new Error('refused')
    }

    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS).catch(() => undefined)
  expect(attempts).toBe(1)
  expect(submitted).toEqual([])

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[dashboard] item q1 (question): ship it'])
})

test('a session with nobody at the prompt never checks', async ($, on) => {
  const clock = mock.clock(on)
  let checks = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', () => {
    checks += 1
    return answer({ exitCode: 0, stdout: '', stderr: '' })
  })
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  await clock.advance(CHECK_MS)
  expect(checks).toBe(0)
})

test('follows the session id after the process moves to another session', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let sessionId = 'sess-1'
  const argvs: string[][] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer(sessionId))
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    return answer({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('tool.call', () => ({ deny: 'stubbed' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(argvs.map((argv) => argv.slice(1))).toContainEqual(['check', '--session', 'sess-1'])

  const runsBeforeSwitch = argvs.length
  sessionId = 'sess-2'
  await $.tool.call({ tool: 'Bash', command: 'true' })
  await clock.advance(CHECK_MS)
  const runsAfterSwitch = argvs.slice(runsBeforeSwitch).map((argv) => argv.slice(1))
  expect(runsAfterSwitch).toContainEqual(['check', '--session', 'sess-2'])
  expect(runsAfterSwitch).toContainEqual(['session', 'heartbeat', '--session', 'sess-2'])
  expect(runsAfterSwitch.flat()).not.toContain('sess-1')
})

test('keeps delivered answers per session, so a switch reads the new session record', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'delivered-board-items:sess-1': ['q1'] })
  let sessionId = 'sess-1'
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer(sessionId))
  on('process.run', () =>
    answer({ exitCode: 0, stdout: '[dashboard] item q1 (question): yes\n', stderr: '' })
  )
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(CHECK_MS)
  expect(submitted).toEqual([])

  sessionId = 'sess-2'
  await clock.advance(CHECK_MS)
  expect(submitted).toEqual(['[dashboard] item q1 (question): yes'])
})

// A process.run stub that tells beats from checks by argv[1] and answers a check with no output.
const stubRuns = (on: Parameters<typeof mock.clock>[0]) => {
  const beats: string[][] = []
  const checks: string[][] = []
  const state = { isBeatRejected: false }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => answer('sess-1'))
  on('process.run', ($, e) => {
    if (e.argv[1] === 'session') {
      beats.push([...e.argv])
      if (state.isBeatRejected) {
        throw new Error('timed out')
      }
    } else {
      checks.push([...e.argv])
    }

    return answer({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('tool.call', () => ({ deny: 'stubbed' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { beats, checks, state }
}

test('beats after a tool call, once per interval', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const { beats } = stubRuns(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Bash', command: 'true' })
  await clock.advance(60_000)
  expect(beats.length).toBe(1)
  expect(beats[0]?.slice(1)).toEqual(['session', 'heartbeat', '--session', 'sess-1'])

  await $.tool.call({ tool: 'Bash', command: 'true' })
  await clock.advance(60_000)
  expect(beats.length).toBe(1)

  await clock.advance(BEAT_MS)
  expect(beats.length).toBe(2)
})

test('never beats without activity', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const { beats, checks } = stubRuns(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await clock.advance(3 * BEAT_MS)
  expect(beats.length).toBe(0)
  expect(checks.length).toBeGreaterThan(0)
})

test('beats while a main-loop turn runs', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const { beats, checks } = stubRuns(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'true' })
  await clock.advance(60_000)
  expect(beats.length).toBe(1)
  expect(checks.length).toBe(0)
})

test('a turn end counts as activity', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const { beats } = stubRuns(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({
    reason: 'answer',
    answer: '',
    durationMs: 0,
    isAborted: false,
    turnId: 't1',
  })
  await clock.advance(60_000)
  expect(beats.length).toBe(1)
})

test('a rejected beat does not cost the tick its check', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const { beats, checks, state } = stubRuns(on)
  state.isBeatRejected = true
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Bash', command: 'true' })
  await clock.advance(CHECK_MS)
  expect(beats.length).toBe(1)
  expect(checks.length).toBe(1)
})

test('a session with nobody at the prompt never beats', async ($, on) => {
  const clock = mock.clock(on)
  const { beats } = stubRuns(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  await $.turn.complete({
    reason: 'answer',
    answer: '',
    durationMs: 0,
    isAborted: false,
    turnId: 't1',
  })
  await clock.advance(BEAT_MS)
  expect(beats.length).toBe(0)
})
