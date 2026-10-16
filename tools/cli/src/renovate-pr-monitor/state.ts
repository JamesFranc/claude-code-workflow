// Ported from scripts/renovate-pr-monitor.sh's state file helpers (state_ensure, state_load,
// state_save, state_get_pr, state_patch_pr, state_delete_pr, state_prune). State shape:
//   { "prs": { "<owner>/<repo>#<number>": { headSha, ciRetries, agentBusy, agentStartedAt,
//                                            majorNotified, lastSeenAt, blockedSince } },
//     "boardItems": { "<owner>/<repo>#<number>": { item, outcome } } }
// boardItems is read by getBoardItem, below.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RenovatePrState } from './classify.ts'
import { AGENT_BUSY_TIMEOUT_SECONDS } from './config.ts'

export interface StateFile {
  prs: Record<string, RenovatePrState>
  [key: string]: unknown
}

const RENAME_MAP: Record<string, string> = {
  head_sha: 'headSha',
  ci_retries: 'ciRetries',
  agent_busy: 'agentBusy',
  agent_started_at: 'agentStartedAt',
  major_notified: 'majorNotified',
  last_seen_at: 'lastSeenAt',
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// A non-object entry (e.g. a hand-edited null, string, or array) is dropped rather than reaching a
// later consumer that expects an object.
const migrateEntry = (raw: unknown): RenovatePrState | undefined => {
  if (!isPlainObject(raw)) {
    return undefined
  }
  const entry: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    entry[RENAME_MAP[key] ?? key] = value
  }
  return entry as RenovatePrState
}

const readRaw = (stateFile: string): string => {
  try {
    return readFileSync(stateFile, 'utf-8')
  } catch {
    return ''
  }
}

const migrateFile = (raw: unknown): StateFile => {
  const rawObj = isPlainObject(raw) ? raw : {}
  const rawPrs = isPlainObject(rawObj.prs) ? rawObj.prs : {}
  const prs: Record<string, RenovatePrState> = {}
  for (const [key, value] of Object.entries(rawPrs)) {
    const migrated = migrateEntry(value)
    if (migrated !== undefined) {
      prs[key] = migrated
    }
  }
  return { ...rawObj, prs }
}

// A marker beside the state file, written the one time legacy adoption actually runs. Its presence
// — not the state file's — gates re-adoption, so the runbook's "reset the state file" recipe
// (deleting stateFile) can't resurrect stale legacy data.
const adoptionMarkerPath = (stateFile: string): string => `${stateFile}.adopted`

// Accepted difference 1: pr-monitor/state.ts's adoptLegacy() precedent, adapted for a single legacy
// path. Never touches the legacy file itself — only ever read and migrated in memory.
const readLegacy = (legacyStateFile: string | null): StateFile | null => {
  if (legacyStateFile === null || !existsSync(legacyStateFile)) {
    return null
  }
  const text = readRaw(legacyStateFile)
  if (text.trim() === '') {
    return null
  }
  try {
    return migrateFile(JSON.parse(text))
  } catch {
    return null
  }
}

// Tolerates a missing or empty file (e.g. dry-run never creates one) by falling back to an empty
// skeleton. Renames old per-PR snake_case keys, in memory, so every reader sees camelCase keys even
// under --dry-run, which never writes this back to disk. When the new path is absent, falls back to
// legacyStateFile (adopted in memory only here — ensureState is what persists it).
export const loadState = (stateFile: string, legacyStateFile: string | null = null): StateFile => {
  if (!existsSync(stateFile) && !existsSync(adoptionMarkerPath(stateFile))) {
    const legacy = readLegacy(legacyStateFile)
    if (legacy !== null) {
      return legacy
    }
  }
  const text = readRaw(stateFile)
  const raw: unknown = text.trim() === '' ? {} : JSON.parse(text)
  return migrateFile(raw)
}

const writeAtomic = (stateFile: string, text: string): void => {
  const tmp = `${stateFile}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, stateFile)
}

// Skipped entirely in dry-run so a validation pass never mutates real state. Atomic via tmp + rename.
export const saveState = (stateFile: string, state: StateFile, dryRun: boolean): void => {
  if (dryRun) {
    return
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  writeAtomic(stateFile, `${JSON.stringify(state)}\n`)
}

// Creates the state file if it's missing, and persists the load-time migration/rename if an
// existing file predates it — done once here rather than trusting every future load to rewrite it.
// Also the one-time real (on-disk) legacy adoption, gated on adoptionMarkerPath so it fires at most
// once even across a reset of the state file itself.
export const ensureState = (
  stateFile: string,
  dryRun: boolean,
  legacyStateFile: string | null = null
): void => {
  if (dryRun) {
    return
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  const isNew = !existsSync(stateFile)
  if (isNew) {
    const marker = adoptionMarkerPath(stateFile)
    if (!existsSync(marker)) {
      const legacy = readLegacy(legacyStateFile)
      if (legacy !== null) {
        writeAtomic(stateFile, `${JSON.stringify(legacy)}\n`)
        writeFileSync(marker, '')
        return
      }
    }
  }
  const raw = readRaw(stateFile)
  if (raw.trim() === '') {
    writeAtomic(stateFile, '{"prs":{}}\n')
    if (isNew) {
      writeFileSync(adoptionMarkerPath(stateFile), '')
    }
    return
  }
  const migrated = `${JSON.stringify(loadState(stateFile))}\n`
  if (migrated !== raw) {
    writeAtomic(stateFile, migrated)
  }
}

export const getPrState = (
  stateFile: string,
  key: string,
  legacyStateFile: string | null = null
): RenovatePrState | undefined => loadState(stateFile, legacyStateFile).prs[key]

export const patchPrState = (
  stateFile: string,
  key: string,
  patch: Partial<RenovatePrState>,
  dryRun: boolean
): void => {
  const state = loadState(stateFile)
  state.prs[key] = { ...state.prs[key], ...patch }
  saveState(stateFile, state, dryRun)
}

export const deletePrState = (stateFile: string, key: string, dryRun: boolean): void => {
  const state = loadState(stateFile)
  delete state.prs[key]
  saveState(stateFile, state, dryRun)
}

// Removes PR entries whose key is no longer open (merged/closed). An entry with agentBusy=true but
// agentStartedAt older than the timeout keeps its entry — only the busy marker is cleared, so the
// PR's other state (ciRetries, blockedSince, ...) survives the expiry.
export const prunePrState = (
  stateFile: string,
  openKeys: readonly string[],
  nowEpochSeconds: number,
  dryRun: boolean
): void => {
  const state = loadState(stateFile)
  const openSet = new Set(openKeys)
  const pruned: Record<string, RenovatePrState> = {}
  for (const [key, entry] of Object.entries(state.prs)) {
    if (!openSet.has(key)) {
      continue
    }
    const busy = entry.agentBusy ?? false
    const startedAt = entry.agentStartedAt ?? null
    const withinTimeout =
      busy === false ||
      startedAt === null ||
      Date.parse(startedAt) / 1000 > nowEpochSeconds - AGENT_BUSY_TIMEOUT_SECONDS
    if (withinTimeout) {
      pruned[key] = entry
    } else {
      const rest = { ...entry }
      delete rest.agentBusy
      delete rest.agentStartedAt
      pruned[key] = rest
    }
  }
  saveState(stateFile, { ...state, prs: pruned }, dryRun)
}

export interface BoardItem {
  item?: string
  outcome?: string
}

export const getBoardItem = (
  stateFile: string,
  key: string,
  legacyStateFile: string | null = null
): BoardItem | undefined => {
  const boardItems = loadState(stateFile, legacyStateFile).boardItems
  if (!isPlainObject(boardItems)) {
    return undefined
  }
  const entry = boardItems[key]
  if (!isPlainObject(entry)) {
    return undefined
  }
  return {
    ...(typeof entry.item === 'string' ? { item: entry.item } : {}),
    ...(typeof entry.outcome === 'string' ? { outcome: entry.outcome } : {}),
  }
}
