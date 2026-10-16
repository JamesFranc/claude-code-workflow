// Runs the TypeScript renovate-pr-monitor command against a fake `gh` and a pinned clock, and
// normalizes the result into a byte-comparable capture. See cases.ts for the case catalogue and
// capture.ts for the script that turns every case into an expected/ fixture.
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  classify,
  type ClassifyResult,
  type GhPrDetails,
  type RenovatePrState,
} from '../classify.ts'
import type { BoardItem } from '../state.ts'

const execFileAsync = promisify(execFile)

export type FakeGhRule = {
  match: string
  stdout?: unknown
  stderr?: string
  exit?: number
  delaySeconds?: number
  once?: boolean
}
export type FakeGhScript = FakeGhRule[]

export type ClassifyCase = {
  name: string
  pr: GhPrDetails
  entry: RenovatePrState | null
  now: string
  boardItem?: BoardItem
}

export type TickCase = {
  name: string
  env: Record<string, string>
  gh: FakeGhScript
  state: Record<string, unknown> | null
  now: string
}

export type RunCapture = {
  exit: number
  stdout: string
  stderr: string
  ghCalls: string[][]
  state: unknown
}
export type TickCapture = { dryRun: RunCapture; live: RunCapture }

export const serialize = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

const CHARACTERIZATION_DIR = import.meta.dirname
const FAKE_BIN = join(CHARACTERIZATION_DIR, 'fake-bin')
const FAKE_CLOCK = join(CHARACTERIZATION_DIR, 'fake-clock.ts')
const CLI_MAIN = join(CHARACTERIZATION_DIR, '..', '..', 'main.ts')

const BASE_ENV = {
  RENOVATE_MONITOR_AUTHOR: 'app/renovate',
  RENOVATE_MONITOR_SCOPE: 'acme/*',
  RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '0',
}

export const runClassify = (c: ClassifyCase): ClassifyResult =>
  classify(c.pr, c.entry, Date.parse(c.now) / 1000, c.boardItem ?? null)

// Runs the command twice, each in a fresh temp dir seeded with c.state: once
// `--once --dry-run --verbose`, once `--once --verbose`.
export const runTick = async (c: TickCase): Promise<TickCapture> => {
  await ensureEnvironment()
  const dryRun = await runOnce(c, true)
  const live = await runOnce(c, false)
  return { dryRun, live }
}

const runOnce = async (c: TickCase, dryRun: boolean): Promise<RunCapture> => {
  await ensureEnvironment()
  const tmp = mkTmpDir()
  try {
    const realTmp = realpathSync(tmp)
    const env = buildEnv(tmp, c.now, c.env)
    writeFileSync(env.FAKE_GH_RULES, JSON.stringify(c.gh))
    if (c.state !== null) {
      mkdirSync(dirname(env.RENOVATE_MONITOR_STATE_FILE), { recursive: true })
      writeFileSync(env.RENOVATE_MONITOR_STATE_FILE, JSON.stringify(c.state))
    }

    const args = dryRun ? ['--once', '--dry-run', '--verbose'] : ['--once', '--verbose']
    let exit = 0
    let stdout = ''
    let stderr = ''
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-transform-types',
          '--import',
          FAKE_CLOCK,
          CLI_MAIN,
          'renovate-pr-monitor',
          ...args,
        ],
        { cwd: tmp, env }
      )
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string }
      if (typeof e.code !== 'number') {
        throw err
      }
      exit = e.code
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? ''
    }

    if (existsSync(`${env.FAKE_GH_LOG}.unmatched`)) {
      throw new Error(
        `runTick(${c.name}, ${dryRun ? 'dryRun' : 'live'}): fake gh received an unmatched call — ` +
          `the fixture is missing a rule for it (see ${env.FAKE_GH_LOG}.unmatched)`
      )
    }

    const ghCalls = readGhLog(env.FAKE_GH_LOG)
    const state = existsSync(env.RENOVATE_MONITOR_STATE_FILE)
      ? (JSON.parse(readFileSync(env.RENOVATE_MONITOR_STATE_FILE, 'utf8')) as unknown)
      : null

    const tmpPaths = realTmp === tmp ? [tmp] : [tmp, realTmp].sort((a, b) => b.length - a.length)
    return {
      exit,
      stdout: normalizeTmpPaths(stdout, tmpPaths),
      stderr: normalizeTmpPaths(stderr, tmpPaths),
      ghCalls,
      state,
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const buildEnv = (
  tmp: string,
  now: string,
  extra: Readonly<Record<string, string>>
): Record<string, string> => ({
  PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
  HOME: tmp,
  TZ: 'UTC',
  LC_ALL: 'C',
  FAKE_NOW_EPOCH: String(Date.parse(now) / 1000),
  FAKE_GH_RULES: join(tmp, 'rules.json'),
  FAKE_GH_LOG: join(tmp, 'gh.log'),
  RENOVATE_MONITOR_STATE_FILE: join(tmp, 'state', 'state.json'),
  ...BASE_ENV,
  ...extra,
})

const readGhLog = (path: string): string[][] => {
  if (!existsSync(path)) {
    return []
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[])
}

const normalizeTmpPaths = (text: string, tmpPaths: readonly string[]): string =>
  tmpPaths.reduce((out, p) => out.split(p).join('<tmp>'), text)

const mkTmpDir = (): string => mkdtempSync(join(tmpdir(), 'renovate-pr-monitor-characterization-'))

// Resolved once (memoized promise) rather than per case: the preconditions the harness refuses a
// capture without. fake-bin/gh shells out to jq, so jq must be on PATH.
let environmentPromise: Promise<void> | undefined

const ensureEnvironment = (): Promise<void> => {
  environmentPromise ??= probeEnvironment()
  return environmentPromise
}

const probeEnvironment = async (): Promise<void> => {
  try {
    await execFileAsync('bash', ['-c', 'command -v jq'])
  } catch {
    throw new Error('renovate-pr-monitor characterization harness requires `jq` on PATH')
  }
}
