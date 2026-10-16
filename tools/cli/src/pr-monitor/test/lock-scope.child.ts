// Minimal cross-process helper for lock.test.ts's cross-dirKey legacy lock test. Mirrors
// store-scope.child.ts: the lock dirKey is pinned per process
// by workflow-store/store.ts's resolveDirKey, so proving a legacy lock under a DIFFERENT sibling
// dirKey is actually found requires a genuinely separate process from the one calling
// stopLegacyMonitor. Reads action/args from argv (HOME and CLAUDE_CODE_SESSION_ID come from
// the inherited environment, set by the parent test) and prints a single-line result to stdout.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stopLegacyMonitor } from '../lock.ts'
import { sessionScope, storePath } from '../../workflow-store/store.ts'

const [, , action, ...rest] = process.argv

switch (action) {
  // Writes a legacy lock file at THIS process's own dirKey, naming the given pid — used to seed a
  // legacy lock under a directory OTHER than the one stopLegacyMonitor will be called from.
  // Built inline (matching store-scope.child.ts's pattern) rather than via an exported production
  // helper — lock.ts's legacyLockPath was deleted once it had no production caller left, so a
  // future caller reaching for the single-dirKey path can't reintroduce CR-2's gap by accident.
  case 'write-legacy-lock': {
    const [prNumber, repo, pidStr, heartbeatAt] = rest
    const legacyDir = storePath(sessionScope(), 'pr-monitor')
    const path = join(legacyDir, `${repo.replace(/\//g, '-')}-${prNumber}.lock`)
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ pid: Number(pidStr), startedAt: heartbeatAt, heartbeatAt })
    )
    console.log(path)
    break
  }
  case 'stop': {
    const [prNumber, repo] = rest
    console.log(stopLegacyMonitor(prNumber, repo) ?? 'no live monitor')
    break
  }
  default:
    throw new Error(`unknown action: ${action}`)
}
