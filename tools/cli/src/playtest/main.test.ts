import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listenerOwner } from './main.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

// Answers every request with the args it was started with and its PLAYTEST_PORT_API, listening on
// argv[2], else PLAYTEST_PORT. Prints the bound port so a test can launch it with port 0.
const SERVER = `require('node:http')
  .createServer((req, res) =>
    res.end(JSON.stringify({ args: process.argv.slice(2), api: process.env.PLAYTEST_PORT_API ?? null }))
  )
  .listen(Number(process.argv[2] ?? process.env.PLAYTEST_PORT), function () {
    console.log(this.address().port)
  })
`

const NODE = `"${process.execPath}"`

const fixture = (): { home: string; dir: string; cleanup: () => void } => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-home-')))
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-app-')))
  writeFileSync(join(dir, 'server.cjs'), SERVER)

  const cleanup = (): void => {
    for (const record of listPlaytests(home)) {
      runCli(['playtest', 'stop', '--name', record.name], home)
    }

    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }

  return { home, dir, cleanup }
}

const runCli = (
  args: string[],
  home: string,
  env: Record<string, string> = {}
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ...env }, timeout: 60_000 }
  )

  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

const start = (
  home: string,
  dir: string,
  command: string,
  extra: string[] = []
): { stdout: string; stderr: string; status: number | null } =>
  runCli(
    ['playtest', 'start', '--name', 'FLOW-1-demo', '--dir', dir, '--command', command, ...extra],
    home
  )

const listPlaytests = (
  home: string
): { name: string; pgid: number; groups: { pgid: number }[]; alive: boolean }[] =>
  JSON.parse(runCli(['playtest', 'list'], home).stdout)

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)

    return true
  } catch {
    return false
  }
}

const recordFile = (home: string, name: string): string =>
  join(home, '.claude', 'workflow-state', 'playtest', `${encodeURIComponent(name)}.json`)

test('playtest: start serves the app on the {port} port, and stop takes it down', async () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, `${NODE} server.cjs {port}`)
    assert.equal(started.status, 0, started.stderr)
    const out = JSON.parse(started.stdout)
    assert.equal(out.url, `http://localhost:${out.ports['']}/`)
    const body = await (await fetch(out.url)).json()
    assert.deepEqual(body.args, [String(out.ports[''])])
    const [record] = listPlaytests(home)
    assert.equal(record.alive, true)

    const stopped = runCli(['playtest', 'stop', '--name', 'FLOW-1-demo'], home)
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.deepEqual(JSON.parse(stopped.stdout), { name: 'FLOW-1-demo', stopped: true })
    assert.equal(groupAlive(record.pgid), false)
    assert.equal(existsSync(recordFile(home, 'FLOW-1-demo')), false)
    assert.equal(existsSync(out.log), true)
  } finally {
    cleanup()
  }
})

test('playtest: --path changes the link only', () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, `${NODE} server.cjs {port}`, ['--path', '/board?x=1'])
    assert.equal(started.status, 0, started.stderr)
    const out = JSON.parse(started.stdout)
    assert.equal(out.url, `http://localhost:${out.ports['']}/board?x=1`)
  } finally {
    cleanup()
  }
})

test('playtest: a {port:<label>} placeholder gets its own port, exported as PLAYTEST_PORT_<LABEL>', async () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, `${NODE} server.cjs {port} {port:api}`)
    assert.equal(started.status, 0, started.stderr)
    const out = JSON.parse(started.stdout)
    assert.notEqual(out.ports.api, out.ports[''])
    const body = await (await fetch(out.url)).json()
    assert.deepEqual(body.args, [String(out.ports['']), String(out.ports.api)])
    assert.equal(body.api, String(out.ports.api))
  } finally {
    cleanup()
  }
})

test('playtest: an app that reads PLAYTEST_PORT needs no placeholder', async () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, `${NODE} server.cjs`)
    assert.equal(started.status, 0, started.stderr)
    const body = await (await fetch(JSON.parse(started.stdout).url)).json()
    assert.deepEqual(body.args, [])
  } finally {
    cleanup()
  }
})

test('playtest: a command that never listens exits 1 and says nothing listened', () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, 'echo idle-app-output; sleep 30', ['--timeout', '2'])
    assert.equal(started.status, 1)
    assert.match(started.stderr, /nothing listened on port \d+ within 2s/)
    assert.match(started.stderr, /idle-app-output/)
    assert.deepEqual(listPlaytests(home), [])
  } finally {
    cleanup()
  }
})

test('playtest: a command that exits early exits 1 with the log tail', () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, 'echo boom-from-app; exit 3')
    assert.equal(started.status, 1)
    assert.match(started.stderr, /exited before anything listened/)
    assert.match(started.stderr, /boom-from-app/)
    assert.deepEqual(listPlaytests(home), [])
  } finally {
    cleanup()
  }
})

test('playtest: start replaces a running playtest of the same name', () => {
  const { home, dir, cleanup } = fixture()
  try {
    assert.equal(start(home, dir, `${NODE} server.cjs {port}`).status, 0)
    const [first] = listPlaytests(home)
    const again = start(home, dir, `${NODE} server.cjs {port}`)
    assert.equal(again.status, 0, again.stderr)
    const records = listPlaytests(home)
    assert.equal(records.length, 1)
    assert.notEqual(records[0].pgid, first.pgid)
    assert.equal(groupAlive(first.pgid), false)
    assert.equal(records[0].alive, true)
  } finally {
    cleanup()
  }
})

test('playtest: stop kills the whole process group, grandchildren included', async () => {
  const { home, dir, cleanup } = fixture()
  try {
    const started = start(home, dir, `${NODE} server.cjs {port} & wait`)
    assert.equal(started.status, 0, started.stderr)
    const out = JSON.parse(started.stdout)
    const [record] = listPlaytests(home)
    runCli(['playtest', 'stop', '--name', 'FLOW-1-demo'], home)
    assert.equal(groupAlive(record.pgid), false)
    await assert.rejects(fetch(out.url))
  } finally {
    cleanup()
  }
})

test('playtest: a listener in a group of its own is still the playtest, and stop reaches it', async () => {
  const { home, dir, cleanup } = fixture()
  try {
    const regrouped = `python3 -c 'import os,sys; os.setpgrp(); os.execvp(sys.argv[1], sys.argv[1:])'`
    const started = start(home, dir, `${regrouped} ${NODE} server.cjs {port} & wait`)
    assert.equal(started.status, 0, started.stderr)
    const out = JSON.parse(started.stdout)
    const [record] = listPlaytests(home)
    assert.ok(record.groups.length >= 2, 'the regrouped listener has a group of its own')
    assert.equal(record.alive, true)

    runCli(['playtest', 'stop', '--name', 'FLOW-1-demo'], home)
    for (const group of record.groups) {
      assert.equal(groupAlive(group.pgid), false)
    }

    await assert.rejects(fetch(out.url))
  } finally {
    cleanup()
  }
})

test('playtest: a listener whose parents outlive the exited leader is still owned', async () => {
  const { home, dir, cleanup } = fixture()
  try {
    const regrouped = `python3 -c 'import os,sys; os.setpgrp(); os.execvp(sys.argv[1], sys.argv[1:])'`
    const started = start(home, dir, `(${regrouped} ${NODE} server.cjs {port} & wait) &`)
    assert.equal(started.status, 0, started.stderr)
    const out = JSON.parse(started.stdout)
    const [record] = listPlaytests(home)
    assert.equal(record.alive, true)

    runCli(['playtest', 'stop', '--name', 'FLOW-1-demo'], home)

    for (const group of record.groups) {
      assert.equal(groupAlive(group.pgid), false)
    }

    await assert.rejects(fetch(out.url))
  } finally {
    cleanup()
  }
})

// A directory holding a `ps` that runs and fails, ahead of the real PATH so lsof and the rest still
// resolve.
const brokenPsPath = (script: string): { path: string; cleanup: () => void } => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-ps-')))

  writeFileSync(join(bin, 'ps'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })

  return {
    path: `${bin}:${process.env.PATH}`,
    cleanup: () => rmSync(bin, { recursive: true, force: true }),
  }
}

test('playtest: stop fails and keeps the record when ps runs and fails', () => {
  const { home, dir, cleanup } = fixture()
  const broken = brokenPsPath('exit 1')
  try {
    assert.equal(start(home, dir, `${NODE} server.cjs {port}`).status, 0)
    const [record] = listPlaytests(home)

    const blind = runCli(['playtest', 'stop', '--name', 'FLOW-1-demo'], home, {
      PATH: broken.path,
    })
    assert.notEqual(blind.status, 0)
    assert.equal(existsSync(recordFile(home, 'FLOW-1-demo')), true)
    assert.equal(groupAlive(record.pgid), true)
    assert.match(blind.stderr, /ps exited 1/)

    const stopped = runCli(['playtest', 'stop', '--name', 'FLOW-1-demo'], home)
    assert.deepEqual(JSON.parse(stopped.stdout), { name: 'FLOW-1-demo', stopped: true })
    assert.equal(groupAlive(record.pgid), false)
  } finally {
    broken.cleanup()
    cleanup()
  }
})

test('playtest: start leaves nothing running when ps fails after the launch', () => {
  const { home, dir, cleanup } = fixture()
  const pidFile = join(dir, 'leader.pid')
  const broken = brokenPsPath(`while [ ! -s "${pidFile}" ]; do sleep 0.05; done\nexit 1`)
  try {
    const started = runCli(
      [
        'playtest',
        'start',
        '--name',
        'FLOW-1-demo',
        '--dir',
        dir,
        '--command',
        `echo $$ > "${pidFile}"; exec sleep 300`,
      ],
      home,
      { PATH: broken.path }
    )
    assert.notEqual(started.status, 0)

    const leader = Number(readFileSync(pidFile, 'utf8'))
    for (let i = 0; i < 40 && groupAlive(leader); i++) {
      spawnSync('sleep', ['0.05'])
    }

    assert.equal(groupAlive(leader), false)
  } finally {
    broken.cleanup()
    cleanup()
  }
})

test('playtest: stop with no playtest under the name exits 0', () => {
  const { home, cleanup } = fixture()
  try {
    const stopped = runCli(['playtest', 'stop', '--name', 'never-started'], home)
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.deepEqual(JSON.parse(stopped.stdout), { name: 'never-started', stopped: false })
  } finally {
    cleanup()
  }
})

test('playtest: list reports alive false once the group is gone', () => {
  const { home, dir, cleanup } = fixture()
  try {
    assert.equal(start(home, dir, `${NODE} server.cjs {port}`).status, 0)
    const [record] = listPlaytests(home)
    process.kill(-record.pgid, 'SIGKILL')
    for (let i = 0; i < 40 && groupAlive(record.pgid); i++) {
      spawnSync('sleep', ['0.05'])
    }

    assert.equal(listPlaytests(home)[0].alive, false)
  } finally {
    cleanup()
  }
})

test('playtest: usage errors exit 2', () => {
  const { home, dir, cleanup } = fixture()
  try {
    const cases: [string[], RegExp][] = [
      [['--dir', join(dir, 'missing'), '--command', 'true'], /is not a directory/],
      [['--dir', dir, '--command', 'true', '--timeout', '0'], /--timeout/],
      [['--dir', dir, '--command', 'true', '--path', 'board'], /--path must start with/],
      [['--dir', dir, '--command', 'serve {port:API}'], /\{port:API\}/],
    ]
    for (const [args, message] of cases) {
      const result = runCli(['playtest', 'start', '--name', 'FLOW-1-demo', ...args], home)
      assert.equal(result.status, 2, args.join(' '))
      assert.match(result.stderr, message)
    }
  } finally {
    cleanup()
  }
})

test('playtest: listenerOwner tells our tree, another process and no listener apart', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-owner-')))
  writeFileSync(join(dir, 'server.cjs'), SERVER)
  const child = spawn(process.execPath, ['server.cjs', '0'], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const outside = createServer()
  try {
    const ours = Number(
      await new Promise<string>((done) => child.stdout.once('data', (data) => done(String(data))))
    )
    await new Promise<void>((done) => outside.listen(0, '127.0.0.1', done))
    const theirs = (outside.address() as AddressInfo).port
    const free = createServer()
    await new Promise<void>((done) => free.listen(0, '127.0.0.1', done))
    const unused = (free.address() as AddressInfo).port
    await new Promise((done) => free.close(done))

    assert.equal(
      listenerOwner(ours, () => [child.pid!]),
      'ours'
    )
    assert.equal(
      listenerOwner(theirs, () => [child.pid!]),
      'other'
    )
    assert.equal(
      listenerOwner(unused, () => [child.pid!]),
      'none'
    )
  } finally {
    process.kill(-child.pid!, 'SIGKILL')
    await new Promise((done) => outside.close(done))
    rmSync(dir, { recursive: true, force: true })
  }
})
