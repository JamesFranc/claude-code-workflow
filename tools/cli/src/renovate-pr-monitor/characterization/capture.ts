// Runs every case in cases.ts against the TypeScript renovate-pr-monitor command and writes
// expected/. Never hand-edit expected/ — rerun this instead:
//   node --experimental-transform-types tools/cli/src/renovate-pr-monitor/characterization/capture.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyCases, tickCases } from './cases.ts'
import { runClassify, runTick, serialize } from './harness.ts'

const EXPECTED_DIR = join(import.meta.dirname, 'expected')
const TICK_DIR = join(EXPECTED_DIR, 'tick')

const ALL_CLASSIFY_OUTPUTS = [
  'agent-busy',
  'left-alone',
  'major',
  'major-skip',
  'rebase-conflict',
  'needs-rebase',
  'skip',
  'ci-pending',
  'ci-failed',
  'mergeable',
  'needs-approval',
  'blocked',
  'blocked-stuck',
  'unknown',
]

const main = async (): Promise<void> => {
  const classifyResults = classifyCases.map((c) => [c.name, runClassify(c)] as const)

  const missing = ALL_CLASSIFY_OUTPUTS.filter(
    (want) => !classifyResults.some(([, output]) => output === want)
  )
  if (missing.length > 0) {
    console.error(
      'capture refused: classify cases do not cover every classify output — missing: ' +
        missing.join(', ')
    )
    process.exitCode = 1
    return
  }

  const tickCaptures = await Promise.all(
    tickCases.map(async (c) => [c.name, await runTick(c)] as const)
  )

  mkdirSync(TICK_DIR, { recursive: true })
  writeFileSync(join(EXPECTED_DIR, 'classify.json'), serialize(Object.fromEntries(classifyResults)))
  for (const [name, capture] of tickCaptures) {
    writeFileSync(join(TICK_DIR, `${name}.json`), serialize(capture))
  }

  const wantedFiles = new Set(tickCases.map((c) => `${c.name}.json`))
  for (const entry of readdirSync(TICK_DIR)) {
    if (entry.endsWith('.json') && !wantedFiles.has(entry)) {
      rmSync(join(TICK_DIR, entry))
    }
  }
}

await main()
