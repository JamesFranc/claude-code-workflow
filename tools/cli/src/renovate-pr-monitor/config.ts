// Ported from scripts/renovate-pr-monitor.sh's constants/config block and its parse_scope /
// parse_excludes / parse_bot_authors / parse_hold_relax functions. loadConfig reads every
// RENOVATE_MONITOR_* env var once per process.
import { join } from 'node:path'
import { storeDir } from '../pr-monitor/state.ts'

export class ConfigError extends Error {}

export interface MonitorConfig {
  author: string
  scopeOwners: string[]
  scopeRepos: string[]
  scopeExcludes: string[]
  pollIntervalSeconds: number
  maxCiRetries: number
  mergeDelaySeconds: number
  holdForHumanPrs: boolean
  holdRelaxStart: number | null
  holdRelaxEnd: number | null
  // The raw regex-matched digit strings behind holdRelaxStart/End — e.g. '06', not 6 — kept only so
  // the startup banner can echo the operator's own input (leading zero and all) rather than the
  // parsed number. Hour arithmetic uses the parsed numbers above, never these.
  holdRelaxStartRaw: string | null
  holdRelaxEndRaw: string | null
  holdRelaxTz: string
  nonhumanAuthors: string[]
  agentBusyTimeoutSeconds: number
  stateFile: string
  // Accepted difference 1: non-null only when RENOVATE_MONITOR_STATE_FILE is unset, so state.ts's
  // legacy adoption (pr-monitor/state.ts's adoptLegacy() precedent) runs only on the default path.
  legacyStateFile: string | null
}

export const AGENT_BUSY_TIMEOUT_SECONDS = 7200
export const BLOCKED_ESCALATE_SECONDS = 7200

export const defaultStateFile = (): string => join(storeDir(), 'renovate-pr-monitor-state.json')

// The pre-storeDir() location: bash's `$PWD/.claude/renovate-pr-monitor-state.json`.
export const legacyStateFilePath = (): string =>
  join(process.cwd(), '.claude', 'renovate-pr-monitor-state.json')

export const loadConfig = (env: NodeJS.ProcessEnv): MonitorConfig => {
  const author = env.RENOVATE_MONITOR_AUTHOR || 'app/renovate'
  const { owners: scopeOwners, repos: scopeRepos } = parseScope(env.RENOVATE_MONITOR_SCOPE || '')
  const { holdRelaxStart, holdRelaxEnd, holdRelaxStartRaw, holdRelaxEndRaw } = parseHoldRelaxHours(
    env.RENOVATE_MONITOR_HOLD_RELAX_HOURS || ''
  )
  return {
    author,
    scopeOwners,
    scopeRepos,
    scopeExcludes: parseExcludes(env.RENOVATE_MONITOR_EXCLUDE || ''),
    pollIntervalSeconds: parseNonNegativeInt(
      'RENOVATE_MONITOR_POLL_SECONDS',
      env.RENOVATE_MONITOR_POLL_SECONDS || '900'
    ),
    maxCiRetries: parseNonNegativeInt(
      'RENOVATE_MONITOR_MAX_CI_RETRIES',
      env.RENOVATE_MONITOR_MAX_CI_RETRIES || '2'
    ),
    mergeDelaySeconds: parseNonNegativeInt(
      'RENOVATE_MONITOR_MERGE_DELAY_SECONDS',
      env.RENOVATE_MONITOR_MERGE_DELAY_SECONDS || '120'
    ),
    holdForHumanPrs: parseHoldForHumanPrs(env.RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS || 'false'),
    holdRelaxStart,
    holdRelaxEnd,
    holdRelaxStartRaw,
    holdRelaxEndRaw,
    holdRelaxTz: env.RENOVATE_MONITOR_HOLD_RELAX_TZ || '',
    nonhumanAuthors: parseBotAuthors(author, env.RENOVATE_MONITOR_BOT_AUTHORS || ''),
    agentBusyTimeoutSeconds: AGENT_BUSY_TIMEOUT_SECONDS,
    stateFile: env.RENOVATE_MONITOR_STATE_FILE || defaultStateFile(),
    legacyStateFile: env.RENOVATE_MONITOR_STATE_FILE ? null : legacyStateFilePath(),
  }
}

// Splits on whitespace and commas, the same as bash's `for x in ${RAW//,/ }` word-splitting.
const splitPatterns = (raw: string): string[] =>
  raw
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 0)

export const parseScope = (raw: string): { owners: string[]; repos: string[] } => {
  if (raw === '') {
    throw new ConfigError(
      '[monitor] ERROR: RENOVATE_MONITOR_SCOPE is required.\n' +
        '  Set it to a space/comma-separated list of patterns, e.g.:\n' +
        '    RENOVATE_MONITOR_SCOPE="acme/* me/some-repo"'
    )
  }
  const owners: string[] = []
  const repos: string[] = []
  for (const pattern of splitPatterns(raw)) {
    if (pattern.endsWith('/*')) {
      owners.push(pattern.slice(0, -2))
    } else if (pattern.includes('/')) {
      repos.push(pattern)
    } else {
      throw new ConfigError(
        `[monitor] ERROR: invalid scope pattern '${pattern}' — must be 'owner/*' or 'owner/repo'.`
      )
    }
  }
  if (owners.length === 0 && repos.length === 0) {
    throw new ConfigError('[monitor] ERROR: RENOVATE_MONITOR_SCOPE parsed to no usable patterns.')
  }
  return { owners, repos }
}

export const parseExcludes = (raw: string): string[] => {
  if (raw === '') {
    return []
  }
  const excludes: string[] = []
  for (const rawPattern of splitPatterns(raw)) {
    const pattern = rawPattern.startsWith('-') ? rawPattern.slice(1) : rawPattern
    if (pattern === '') {
      continue
    }
    if (pattern.includes('/')) {
      excludes.push(pattern)
    } else {
      throw new ConfigError(
        `[monitor] ERROR: invalid exclude pattern '${pattern}' — must be 'owner/repo' or 'owner/*'.`
      )
    }
  }
  return excludes
}

const NON_NEGATIVE_INT_RE = /^[0-9]+$/

const parseNonNegativeInt = (envVarName: string, raw: string): number => {
  if (!NON_NEGATIVE_INT_RE.test(raw)) {
    throw new ConfigError(
      `[monitor] ERROR: ${envVarName} must be a whole, non-negative number. Got '${raw}'.`
    )
  }
  return Number.parseInt(raw, 10)
}

const HOLD_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

export const parseHoldForHumanPrs = (raw: string): boolean =>
  HOLD_TRUE_VALUES.has(raw.toLowerCase())

// authors, lowercased and deduped — jq's `unique` sorts, so the result is sorted too.
export const parseBotAuthors = (author: string, botAuthorsRaw: string): string[] => {
  const authors = [author, ...splitPatterns(botAuthorsRaw)].filter((a) => a.length > 0)
  return [...new Set(authors.map((a) => a.toLowerCase()))].sort()
}

// The RHS globs (repo names can't contain glob metacharacters, so a plain entry only ever matches
// itself): "owner/repo" exact, "owner/*" whole-org, "owner/prefix-*" prefix. Matched
// case-insensitively (GitHub names are case-insensitive).
const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export const repoIsExcluded = (config: MonitorConfig, repo: string): boolean => {
  const lowerRepo = repo.toLowerCase()
  return config.scopeExcludes.some((e) => globToRegExp(e.toLowerCase()).test(lowerRepo))
}

const HOLD_RELAX_HOURS_RE = /^([0-9]{1,2})-([0-9]{1,2})$/

export interface HoldRelaxHours {
  holdRelaxStart: number | null
  holdRelaxEnd: number | null
  holdRelaxStartRaw: string | null
  holdRelaxEndRaw: string | null
}

export const parseHoldRelaxHours = (raw: string): HoldRelaxHours => {
  if (raw === '') {
    return {
      holdRelaxStart: null,
      holdRelaxEnd: null,
      holdRelaxStartRaw: null,
      holdRelaxEndRaw: null,
    }
  }
  const m = HOLD_RELAX_HOURS_RE.exec(raw)
  if (!m) {
    throw new ConfigError(
      `[monitor] ERROR: RENOVATE_MONITOR_HOLD_RELAX_HOURS must be 'START-END' on a 24h clock, e.g. '0-8'. Got '${raw}'.`
    )
  }
  const holdRelaxStart = Number.parseInt(m[1], 10)
  const holdRelaxEnd = Number.parseInt(m[2], 10)
  if (holdRelaxStart > 23 || holdRelaxEnd > 24 || holdRelaxEnd < 1) {
    throw new ConfigError(
      `[monitor] ERROR: RENOVATE_MONITOR_HOLD_RELAX_HOURS '${raw}' — start must be 0-23, end 1-24.`
    )
  }
  return { holdRelaxStart, holdRelaxEnd, holdRelaxStartRaw: m[1], holdRelaxEndRaw: m[2] }
}
