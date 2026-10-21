import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord, PRIVATE_TERMS_PATH, type PrivateTerms } from './terms.ts'

export type FindingClass =
  | 'credential'
  | 'personal-handle'
  | 'home-directory'
  | 'private-link'
  | 'private-repo'
  | 'personal-wording'
  | 'missing-licence'
  | 'missing-notice'
  | 'export-leak'

export interface Finding {
  class: FindingClass
  path: string
  line?: number
  match: string
}

export const LICENCE_ID = 'GPL-3.0-or-later'
export const LICENCE_PATH = 'LICENSE'
export const NOTICES_PATH = 'THIRD-PARTY-NOTICES.md'
export const RUNTIME_MANIFEST_PATH = 'tools/cli/package.json'

// Paths that must never reach a snapshot. Each one also carries `export-ignore` in .gitattributes;
// this list is what proves the attribute took effect.
export const EXCLUDED_PATHS: readonly string[] = [
  PRIVATE_TERMS_PATH,
  'CHANGELOG.md',
  'release-please-config.json',
  '.release-please-manifest.json',
  '.github/workflows/release-please.yml',
  '.github/workflows/publish-check.yml',
  'renovate.json',
]

export const scanExportSet = (
  dir: string,
  files: readonly string[],
  terms: PrivateTerms
): Finding[] => {
  const patterns = linePatterns(terms)
  const present = new Set(files)

  return [
    ...files.flatMap((path) => scanFile(dir, path, patterns)),
    ...checkLicence(dir, present),
    ...checkNotices(dir, present),
    ...EXCLUDED_PATHS.filter((path) => present.has(path)).map((path): Finding => ({
      class: 'export-leak',
      path,
      match: path,
    })),
  ]
}

interface LinePattern {
  class: FindingClass
  pattern: RegExp
}

const linePatterns = (terms: PrivateTerms): LinePattern[] => [
  { class: 'credential', pattern: CREDENTIAL_PATTERN },
  { class: 'home-directory', pattern: HOME_DIRECTORY_PATTERN },
  ...termPatterns(terms),
]

const termPatterns = (terms: PrivateTerms): LinePattern[] => [
  ...terms.handles.map((term): LinePattern => ({
    class: 'personal-handle',
    pattern: wordPattern(term),
  })),
  ...terms.privateHosts.map((host): LinePattern => ({
    class: 'private-link',
    pattern: hostPattern(host),
  })),
  ...terms.privateRepos.map((repo): LinePattern => ({
    class: 'private-repo',
    pattern: repoPattern(repo),
  })),
  ...terms.phrases.map((phrase): LinePattern => ({
    class: 'personal-wording',
    pattern: wordPattern(phrase),
  })),
]

// What scanExportSet refuses in any line of text, other than a licence or export-set problem, so a
// credential comes back redacted and a placeholder home directory is exempt.
export const privateTextMatches = (text: string, terms: PrivateTerms): string[] =>
  findIn(text, linePatterns(terms)).map((hit) => hit.match)

const scanFile = (dir: string, path: string, patterns: readonly LinePattern[]): Finding[] => [
  ...findIn(path, patterns).map((hit) => toFinding(path, hit)),
  ...scanContent(dir, path, patterns),
]

// Only the content of a regular text file has lines to point at. A path name, a symlink's target and
// a binary file's bytes are scanned too, and their findings carry no line.
const scanContent = (dir: string, path: string, patterns: readonly LinePattern[]): Finding[] => {
  const full = join(dir, path)

  if (lstatSync(full).isSymbolicLink()) {
    return findIn(readlinkSync(full), patterns).map((hit) => toFinding(path, hit))
  }

  const buffer = readFileSync(full)
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return findIn(buffer.toString('latin1'), patterns).map((hit) => toFinding(path, hit))
  }

  const text = buffer.toString('utf8')
  return findIn(text, patterns).map((hit) => toFinding(path, hit, lineAt(text, hit.index)))
}

interface Hit {
  class: FindingClass
  match: string
  index: number
}

const findIn = (text: string, patterns: readonly LinePattern[]): Hit[] =>
  patterns.flatMap((p) => hitsOf(p, text)).sort((a, b) => a.index - b.index)

const hitsOf = (p: LinePattern, text: string): Hit[] =>
  Array.from(text.matchAll(p.pattern))
    .filter((m) => p.class !== 'home-directory' || !HOME_PLACEHOLDERS.has(m[1] ?? ''))
    .map((m): Hit => ({
      class: p.class,
      match: p.class === 'credential' ? redact(m[0]) : m[0],
      index: m.index,
    }))

const toFinding = (path: string, hit: Hit, line?: number): Finding =>
  line === undefined
    ? { class: hit.class, path, match: hit.match }
    : { class: hit.class, path, line, match: hit.match }

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

// A credential is reported by its prefix and length only, so the finding never re-publishes it in
// CI logs or stdout.
const redact = (secret: string): string => `${secret.slice(0, 4)}… (${secret.length} characters)`

const checkLicence = (dir: string, present: ReadonlySet<string>): Finding[] => [
  ...checkLicenceText(dir, present),
  ...LICENCE_MANIFESTS.flatMap((manifest) => checkManifestLicence(dir, present, manifest)),
]

const checkLicenceText = (dir: string, present: ReadonlySet<string>): Finding[] => {
  if (!present.has(LICENCE_PATH)) {
    return [{ class: 'missing-licence', path: LICENCE_PATH, match: 'no licence file' }]
  }

  const text = readFileSync(join(dir, LICENCE_PATH), 'utf8')
  const missing = LICENCE_MARKERS.find((marker) => !text.includes(marker))
  if (missing === undefined) {
    return []
  }

  return [
    {
      class: 'missing-licence',
      path: LICENCE_PATH,
      match: `not the GPL-3.0 text: no "${missing}"`,
    },
  ]
}

const checkManifestLicence = (
  dir: string,
  present: ReadonlySet<string>,
  manifest: LicenceManifest
): Finding[] => {
  const parsed = readJson(dir, present, manifest.path)
  if (parsed === undefined) {
    return [
      {
        class: 'missing-licence',
        path: manifest.path,
        match: 'manifest missing or not valid JSON',
      },
    ]
  }

  return manifest
    .licences(parsed)
    .filter((id) => id !== LICENCE_ID)
    .map((id): Finding => ({
      class: 'missing-licence',
      path: manifest.path,
      match: `license: ${JSON.stringify(id) ?? 'absent'}`,
    }))
}

const checkNotices = (dir: string, present: ReadonlySet<string>): Finding[] => {
  if (!present.has(NOTICES_PATH)) {
    return [{ class: 'missing-notice', path: NOTICES_PATH, match: 'no notices file' }]
  }

  const lines = readFileSync(join(dir, NOTICES_PATH), 'utf8').split('\n')

  return runtimeDependencies(dir, present)
    .filter((name) => !lines.some((line) => line.startsWith(`| \`${name}\` |`)))
    .map((name): Finding => ({ class: 'missing-notice', path: NOTICES_PATH, match: name }))
}

// Every exported package.json counts, not only the CLI's: a dependency on another workspace package
// ships with the snapshot and needs no notice of its own.
const runtimeDependencies = (dir: string, present: ReadonlySet<string>): string[] => {
  const names = Array.from(present)
    .filter((path) => path === 'package.json' || path.endsWith('/package.json'))
    .flatMap((path) => dependencyNames(readJson(dir, present, path)))

  return Array.from(new Set(names)).sort()
}

const dependencyNames = (manifest: unknown): string[] => {
  const dependencies = field(manifest, 'dependencies')
  if (!isRecord(dependencies)) {
    return []
  }

  return Object.entries(dependencies)
    .filter(([, range]) => !(typeof range === 'string' && range.startsWith('workspace:')))
    .map(([name]) => name)
}

interface LicenceManifest {
  path: string
  licences: (manifest: unknown) => unknown[]
}

const LICENCE_MANIFESTS: readonly LicenceManifest[] = [
  { path: 'package.json', licences: (m) => [field(m, 'license')] },
  { path: RUNTIME_MANIFEST_PATH, licences: (m) => [field(m, 'license')] },
  { path: '.claude-plugin/plugin.json', licences: (m) => [field(m, 'license')] },
  {
    path: '.claude-plugin/marketplace.json',
    licences: (m) => {
      const plugins = field(m, 'plugins')
      if (!Array.isArray(plugins) || plugins.length === 0) {
        return [undefined]
      }

      return plugins.map((plugin) => field(plugin, 'license'))
    },
  },
]

const readJson = (dir: string, present: ReadonlySet<string>, path: string): unknown => {
  if (!present.has(path)) {
    return undefined
  }

  try {
    return JSON.parse(readFileSync(join(dir, path), 'utf8'))
  } catch {
    return undefined
  }
}

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined)

const wordPattern = (term: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9_])`, 'gi')

// The host itself or any subdomain of it, but not a longer domain that merely starts with it.
const hostPattern = (host: string): RegExp =>
  new RegExp(
    `(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\\.)*${escapeRegExp(host)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
    'gi'
  )

const repoPattern = (repo: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(repo)}(?![A-Za-z0-9_-])`, 'gi')

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Common token formats (GitHub, Anthropic, Slack, AWS, Notion, Atlassian) and any PEM private key.
// The left boundary keeps a kebab-case word ending in `sk-` from reading as a key.
const CREDENTIAL_PATTERN = new RegExp(
  '(?<![A-Za-z0-9_-])(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}' +
    '|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}' +
    '|ntn_[A-Za-z0-9]{20,}|ATATT[A-Za-z0-9_=-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'g'
)

const HOME_DIRECTORY_PATTERN = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g

// Names that stand for "some user" in examples and fixtures rather than naming one.
const HOME_PLACEHOLDERS: ReadonlySet<string> = new Set(['x', 'you', 'user', 'username', 'runner'])

const LICENCE_MARKERS = ['GNU GENERAL PUBLIC LICENSE', 'Version 3, 29 June 2007'] as const

const BINARY_SNIFF_BYTES = 8000
