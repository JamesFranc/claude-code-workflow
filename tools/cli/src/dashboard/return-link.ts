import {
  atomicWrite,
  loadClassified,
  sessionGlobalScope,
  storePath,
} from '../workflow-store/store.ts'
import { invokeDashboardBin, resolveDashboardBin } from './invoke.ts'
import { loadRegistry, registryRoot } from './registry.ts'
import { tryResolveRawSessionId } from './session-id.ts'
import { hashId } from './state.ts'

/**
 * Point this session's board root back at the terminal it is running in now. iTerm2 session ids are
 * not guaranteed to survive an iTerm2 restart or a `claude --resume` in a new tab, so this runs on
 * every keyless enter and from the SessionStart hook. A silent no-op when there is no board, no
 * session id, no entered root, no iTerm2 session to return to, or a launch record that exists but
 * cannot be read, is not valid JSON, or has no string `cwd`.
 */
export const runRefreshReturn = (cwd?: string, session?: string): void => {
  const bin = resolveDashboardBin()
  if (bin === null) {
    return
  }

  const rawId = tryResolveRawSessionId(session)
  if (rawId === null) {
    return
  }
  if (cwd !== undefined) {
    saveLaunchDir(rawId, cwd)
  }

  const root = registryRoot(loadRegistry(rawId))
  if (root === undefined) {
    return
  }

  const launchDir = loadLaunchDir(rawId)
  if (launchDir.kind === 'unknown') {
    return
  }

  const url = returnUrl(
    process.env.ITERM_SESSION_ID,
    rawId,
    launchDir.kind === 'recorded' ? launchDir.cwd : process.cwd()
  )
  if (url === null) {
    return
  }

  invokeDashboardBin(
    bin,
    [
      'link',
      'add',
      '--session',
      root.internalId,
      '--kind',
      'return',
      '--label',
      'iTerm',
      '--url',
      url,
    ],
    { quiet: true }
  )
}

export const returnUrl = (
  itermSessionId: string | undefined,
  claudeSessionId: string,
  launchDir: string
): string | null => {
  const itermUuid = itermSessionId?.split(':').at(1)
  if (!itermUuid) {
    return null
  }
  const query = new URLSearchParams({ claude: claudeSessionId, cwd: launchDir })
  return `agent-session://iterm/${encodeURIComponent(itermUuid)}?${query.toString()}`
}

const saveLaunchDir = (rawId: string, cwd: string): void => {
  atomicWrite(storePath(sessionGlobalScope(rawId), launchDirName(rawId)), JSON.stringify({ cwd }))
}

type LaunchDir = { kind: 'recorded'; cwd: string } | { kind: 'absent' } | { kind: 'unknown' }

// Only an absent record means "not recorded", and the caller then falls back to process.cwd(). A record
// that is unreadable or malformed is unknown: publishing a guess would supersede a correct live link.
const loadLaunchDir = (rawId: string): LaunchDir => {
  const read = loadClassified(sessionGlobalScope(rawId), launchDirName(rawId))
  if (read.kind === 'absent') {
    return { kind: 'absent' }
  }
  if (read.kind !== 'content') {
    return { kind: 'unknown' }
  }
  try {
    const cwd: unknown = (JSON.parse(read.content) as { cwd?: unknown } | null)?.cwd
    return typeof cwd === 'string' ? { kind: 'recorded', cwd } : { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' }
  }
}

const launchDirName = (rawId: string): string => `dashboard-return-${hashId(rawId)}.json`
