import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { atomicWrite, ensureDurableDir, storeRoot } from '../workflow-store/store.ts'

export interface PlaytestGroup {
  pgid: number
  // `ps -o lstart=` of the group's leader when recorded ('' when it was not running), so a later
  // stop never signals a reused pid.
  leaderStart: string
}

interface ProcessInfo {
  pid: number
  ppid: number
  pgid: number
  start: string
}

export interface PlaytestRecord {
  name: string
  dir: string
  command: string
  pgid: number
  // Every process group the playtest's process tree has been seen in, the leader's own first: a
  // script runner can start its children in groups of their own.
  groups: PlaytestGroup[]
  ports: Record<string, number>
  url: string
  log: string
  startedAt: string
}

export interface StartOptions {
  name: string
  dir: string
  command: string
  path?: string
  timeout?: string
}

export type ListenerOwner = 'ours' | 'other' | 'none'

type Outcome = 'ready' | 'collision' | 'exited' | 'no-listener' | 'no-response'

const MAX_TRIES = 3
const DEFAULT_TIMEOUT_SECONDS = 120
const STOP_GRACE_MS = 5000
const POLL_MS = 250
const HTTP_PROBE_MS = 2000
const LOG_TAIL_LINES = 40
const PLACEHOLDER = /\{port(?::([a-z0-9_]+))?\}/g
const ANY_LABELLED_PLACEHOLDER = /\{port:[^}]*\}/g

export const runPlaytestStart = async (options: StartOptions): Promise<void> => {
  const usage = usageError(options)

  if (usage !== undefined) {
    return fail(2, usage)
  }

  const timeoutSeconds = Number(options.timeout ?? DEFAULT_TIMEOUT_SECONDS)
  const deadline = Date.now() + timeoutSeconds * 1000

  await stopPlaytest(options.name)
  ensureDurableDir(playtestDir())

  const log = logPath(options.name)

  writeFileSync(log, '', { mode: 0o600 })

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const record = await launch(options, log)
    let outcome: Outcome

    try {
      outcome = await waitReady(record, deadline)
    } catch (error) {
      await stopPlaytest(options.name)
      throw error
    }

    if (outcome === 'ready') {
      const { name, url, ports } = record

      process.stdout.write(`${JSON.stringify({ name, url, ports, log })}\n`)

      return
    }

    await stopPlaytest(options.name)

    if (outcome !== 'collision') {
      return fail(1, `${failureReason(outcome, record.ports[''], timeoutSeconds)}\n${logTail(log)}`)
    }
  }

  fail(1, `another process held the playtest port on all ${MAX_TRIES} tries\n${logTail(log)}`)
}

export const runPlaytestStop = async (name: string): Promise<void> => {
  const stopped = await stopPlaytest(name)

  process.stdout.write(`${JSON.stringify({ name, stopped })}\n`)
}

export const runPlaytestList = (): void => {
  const snap = snapshot()
  const records = listRecords().map((record) => ({
    ...record,
    alive: record.groups.some((group) => ownsGroup(group, snap)),
  }))

  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`)
}

// Exported for the listener-ownership test: a listener outside the process tree means the port is
// not the playtest's, whether it was taken in the race after allocation or the app moved elsewhere.
// The tree is resolved after the listeners are read, so a process that started listening in between
// is still counted.
export const listenerOwner = (port: number, tree: () => readonly number[]): ListenerOwner => {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    encoding: 'utf8',
  })

  if (result.error !== undefined) {
    throw new Error(`lsof could not be run: ${result.error.message}`)
  }

  const listeners = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number(line.slice(1)))

  if (listeners.length === 0) {
    return 'none'
  }

  const owned = new Set(tree())

  return listeners.every((listener) => owned.has(listener)) ? 'ours' : 'other'
}

const usageError = (options: StartOptions): string | undefined => {
  if (options.name.trim() === '') {
    return '--name must not be empty'
  }

  if (!isDirectory(options.dir)) {
    return `--dir ${options.dir} is not a directory`
  }

  if (options.command.trim() === '') {
    return '--command must not be empty'
  }

  if (options.path !== undefined && !options.path.startsWith('/')) {
    return '--path must start with /'
  }

  if (options.timeout !== undefined && !/^[1-9]\d*$/.test(options.timeout)) {
    return '--timeout must be a whole number of seconds above 0'
  }

  const badLabel = (options.command.match(ANY_LABELLED_PLACEHOLDER) ?? []).find(
    (placeholder) => !/^\{port:[a-z0-9_]+\}$/.test(placeholder)
  )

  if (badLabel !== undefined) {
    return `${badLabel}: a port label is lowercase letters, digits and _ only`
  }

  return undefined
}

const launch = async (options: StartOptions, log: string): Promise<PlaytestRecord> => {
  const ports = await allocatePorts(options.command)
  const dir = resolve(options.dir)
  const fd = openSync(log, 'a', 0o600)
  const child = spawn('/bin/sh', ['-c', substitute(options.command, ports)], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...portEnv(ports) },
  })

  closeSync(fd)
  child.on('error', () => {})
  child.unref()

  if (child.pid === undefined) {
    throw new Error('/bin/sh could not be started')
  }

  const leaderPid = child.pid

  try {
    return recordLaunch(options, { dir, log, ports, leaderPid })
  } catch (error) {
    // The group is ours: it was started just now, detached, so its id is the leader's pid.
    signalGroup(leaderPid, 'SIGKILL')
    throw error
  }
}

interface Launched {
  dir: string
  log: string
  ports: Record<string, number>
  leaderPid: number
}

const recordLaunch = (options: StartOptions, launched: Launched): PlaytestRecord => {
  const { dir, log, ports, leaderPid } = launched

  const leaderStart = snapshot().find((candidate) => candidate.pid === leaderPid)?.start ?? ''
  const record: PlaytestRecord = {
    name: options.name,
    dir,
    command: options.command,
    pgid: leaderPid,
    groups: [{ pgid: leaderPid, leaderStart }],
    ports,
    url: `http://localhost:${ports['']}${options.path ?? '/'}`,
    log,
    startedAt: new Date().toISOString(),
  }

  // Recorded before the ready wait, so a CLI killed mid-wait still leaves a record stop can find.
  writeRecord(record)

  return record
}

const waitReady = async (record: PlaytestRecord, deadline: number): Promise<Outcome> => {
  const port = record.ports['']
  let listened = false

  while (Date.now() < deadline) {
    noteGroups(record, snapshot())

    const owner = listenerOwner(port, () => noteGroups(record, snapshot()))

    if (owner === 'other') {
      return 'collision'
    }

    if (owner === 'ours') {
      listened = true

      if (await answersHttp(port)) {
        return 'ready'
      }
    } else if (!record.groups.some((group) => ownsGroup(group, snapshot()))) {
      return 'exited'
    }

    await sleep(POLL_MS)
  }

  return listened ? 'no-response' : 'no-listener'
}

// Records each process group the tree is seen in, and returns the tree's pids. Rewriting the record
// as the set grows keeps a group known even when the process that started it dies before stop.
const noteGroups = (record: PlaytestRecord, snap: ProcessInfo[]): number[] => {
  const tree = ownedProcesses(record, snap)
  let grew = false

  for (const member of tree) {
    if (record.groups.some((group) => group.pgid === member.pgid)) {
      continue
    }

    const leader = snap.find((candidate) => candidate.pid === member.pgid)

    record.groups.push({ pgid: member.pgid, leaderStart: leader?.start ?? '' })
    grew = true
  }

  if (grew) {
    writeRecord(record)
  }

  return tree.map((member) => member.pid)
}

const failureReason = (outcome: Outcome, port: number, timeoutSeconds: number): string => {
  if (outcome === 'exited') {
    return `the command exited before anything listened on port ${port}`
  }

  if (outcome === 'no-response') {
    return `port ${port} was listening but answered no HTTP request within ${timeoutSeconds}s`
  }

  return `nothing listened on port ${port} within ${timeoutSeconds}s: put {port} in the command or have the app read PLAYTEST_PORT`
}

// The record is removed only once the process table has been read: a stop that could not read it
// leaves the record for the next one.
const stopPlaytest = async (name: string): Promise<boolean> => {
  const record = readRecord(recordPath(name))

  if (record === undefined) {
    return false
  }

  noteGroups(record, snapshot())
  await killGroups(record)
  rmSync(recordPath(name), { force: true })

  return true
}

// While any process is in the group, no new process can be given its id, so a live group whose
// leader is gone is still ours. A leader with a different start time is a reused pid: our group
// ended and this is someone else's.
const ownsGroup = (group: PlaytestGroup, snap: ProcessInfo[]): boolean => {
  if (!groupAlive(group.pgid)) {
    return false
  }

  const leader = snap.find((candidate) => candidate.pid === group.pgid)

  return leader === undefined || leader.start === group.leaderStart
}

// The owned processes are the closure under ppid of the leader and of every live member of a
// recorded group that is still ours: a process whose parent died is reparented out of the leader's
// tree but stays in its group, and its own children are still the playtest's.
const ownedProcesses = (record: PlaytestRecord, snap: ProcessInfo[]): ProcessInfo[] => {
  const ours = new Set(
    record.groups.filter((group) => ownsGroup(group, snap)).map((group) => group.pgid)
  )
  const leader = snap.find((candidate) => candidate.pid === record.pgid)
  const leaderStart = record.groups[0].leaderStart
  const owned = new Map<number, ProcessInfo>()

  for (const candidate of snap) {
    const isLeader = candidate === leader && candidate.start === leaderStart

    if (isLeader || ours.has(candidate.pgid)) {
      owned.set(candidate.pid, candidate)
    }
  }

  const queue = [...owned.keys()]

  while (queue.length > 0) {
    const parent = queue.pop()

    for (const child of snap.filter((candidate) => candidate.ppid === parent)) {
      if (!owned.has(child.pid)) {
        owned.set(child.pid, child)
        queue.push(child.pid)
      }
    }
  }

  return [...owned.values()]
}

// Both passes check the guard against a fresh process table: a group that emptied during the grace
// period may have had its id reissued.
const killGroups = async (record: PlaytestRecord): Promise<void> => {
  signalOwnedGroups(record, 'SIGTERM')

  const deadline = Date.now() + STOP_GRACE_MS

  while (ownedGroups(record).length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS)
  }

  signalOwnedGroups(record, 'SIGKILL')
}

const signalOwnedGroups = (record: PlaytestRecord, signal: NodeJS.Signals): void => {
  for (const pgid of ownedGroups(record)) {
    signalGroup(pgid, signal)
  }
}

const ownedGroups = (record: PlaytestRecord): number[] => {
  const snap = snapshot()
  const own = snap.find((candidate) => candidate.pid === process.pid)?.pgid

  return record.groups
    .filter((group) => group.pgid !== own && ownsGroup(group, snap))
    .map((group) => group.pgid)
}

const snapshot = (): ProcessInfo[] => {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' })

  if (result.error !== undefined) {
    throw new Error(`ps could not be run: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(`ps exited ${result.status}: ${result.stderr.trim()}`)
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      start: match[4].trim().replace(/\s+/g, ' '),
    }))
}

const allocatePorts = async (command: string): Promise<Record<string, number>> => {
  const labels = new Set([''])

  for (const match of command.matchAll(PLACEHOLDER)) {
    labels.add(match[1] ?? '')
  }

  // Every port is held open until all are allocated, so two labels can never be handed one port.
  const servers = await Promise.all([...labels].map(() => listenOnFreePort()))

  const ports = Object.fromEntries(
    [...labels].map((label, index) => [label, (servers[index].address() as AddressInfo).port])
  )

  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))

  return ports
}

const listenOnFreePort = (): Promise<Server> =>
  new Promise((resolveServer, reject) => {
    const server = createServer()

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })

const substitute = (command: string, ports: Record<string, number>): string =>
  command.replace(PLACEHOLDER, (_placeholder, label?: string) => String(ports[label ?? '']))

const portEnv = (ports: Record<string, number>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(ports).map(([label, port]) => [
      label === '' ? 'PLAYTEST_PORT' : `PLAYTEST_PORT_${label.toUpperCase()}`,
      String(port),
    ])
  )

const answersHttp = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(HTTP_PROBE_MS),
      redirect: 'manual',
    })
    await response.body?.cancel()

    return true
  } catch {
    return false
  }
}

const listRecords = (): PlaytestRecord[] => {
  let files: string[]

  try {
    files = readdirSync(playtestDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }

  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => readRecord(join(playtestDir(), file)))
    .filter((record): record is PlaytestRecord => record !== undefined)
}

const readRecord = (path: string): PlaytestRecord | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PlaytestRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

const logTail = (log: string): string => {
  const lines = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES)

  return `--- last ${LOG_TAIL_LINES} lines of ${log} ---\n${lines.join('\n')}`
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The group emptied between the check and the signal.
  }
}

const writeRecord = (record: PlaytestRecord): void => {
  atomicWrite(recordPath(record.name), `${JSON.stringify(record, null, 2)}\n`)
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const fail = (exitCode: number, message: string): void => {
  process.stderr.write(`playtest: ${message}\n`)
  setRequestedExitCode(exitCode)
}

const playtestDir = (): string => join(storeRoot(), 'playtest')

// Branch names can hold `/`, so the file name is the encoded name.
const recordPath = (name: string): string => join(playtestDir(), `${encodeURIComponent(name)}.json`)

const logPath = (name: string): string => join(playtestDir(), `${encodeURIComponent(name)}.log`)
