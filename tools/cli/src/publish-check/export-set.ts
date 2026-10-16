import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { git, run } from './git.ts'

// The export set is exactly what `git archive` emits for the commit, so `export-ignore` attributes
// decide it: the commit's own .gitattributes, plus `$GIT_DIR/info/attributes` on a local run (CI has
// none). Extracted to a temporary directory that is always removed.
export const withExportSet = <T>(
  repo: string,
  sha: string,
  use: (dir: string, files: readonly string[]) => T
): T => {
  const work = mkdtempSync(join(tmpdir(), 'publish-check-'))
  try {
    const tarPath = join(work, 'export.tar')
    const dir = join(work, 'tree')

    git(repo, ['archive', '--format=tar', '-o', tarPath, sha], `git archive ${sha} failed`)
    mkdirSync(dir)
    run('tar', ['-xf', tarPath, '-C', dir], 'could not extract the export set')

    return use(dir, listFiles(dir))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const listFiles = (dir: string): string[] => walk(dir, dir).sort()

// Dirent types come from lstat, so a symlink to a directory is listed as an entry, not descended.
const walk = (root: string, current: string): string[] =>
  readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      return walk(root, full)
    }

    return [relative(root, full).split(sep).join('/')]
  })
