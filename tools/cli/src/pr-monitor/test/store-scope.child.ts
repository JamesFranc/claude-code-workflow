// Minimal cross-process helper for store-scope.test.ts. The pr-monitor store's dirKey is pinned
// once per process by workflow-store/store.ts's resolveDirKey, so proving FLOW-216 — that the
// baseline no longer forks per launch directory — requires two genuinely separate processes, each
// with its own pinned dirKey. This script is that separate process: it reads action/args from
// argv (HOME and CLAUDE_CODE_SESSION_ID come from the inherited environment, set by the parent
// test) and prints a single-line result to stdout.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadState, saveState, statePath } from '../state.ts'
import { sessionScope, storePath } from '../../workflow-store/store.ts'

const [, , action, ...rest] = process.argv

switch (action) {
  case 'save': {
    const [prNumber, repo, stateJson] = rest
    saveState(prNumber, repo, JSON.parse(stateJson))
    console.log('OK')
    break
  }
  case 'load': {
    const [prNumber, repo] = rest
    console.log(JSON.stringify(loadState(prNumber, repo)))
    break
  }
  // Writes a store file at the pre-FLOW-216 location (cwd-derived dirKey) then immediately calls
  // loadState from that SAME cwd, so both halves resolve the same dirKey — the realistic "restart
  // from the directory it was last launched from" case the adoption path exists for. Reports
  // whether the legacy file was found, and the on-disk state of both paths afterward.
  case 'legacy-adopt': {
    const [prNumber, repo, stateJson] = rest
    const legacyDir = storePath(sessionScope(), 'pr-monitor')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'state.json')
    const legacyStore = {
      prs: {
        [`${repo}#${prNumber}`]: {
          state: JSON.parse(stateJson),
          updatedAt: new Date().toISOString(),
        },
      },
    }
    writeFileSync(legacyPath, JSON.stringify(legacyStore))

    const loaded = loadState(prNumber, repo)
    const newPath = statePath()
    console.log(
      JSON.stringify({
        loaded,
        legacyExists: existsSync(legacyPath),
        newExists: existsSync(newPath),
      })
    )
    break
  }
  // Populates BOTH the new (session-global) path and a legacy path for the same PR key, then
  // loads. Proves the new path wins outright once it exists — legacy must never be consulted, let
  // alone override it — even when a legacy file happens to still be present on disk.
  case 'seed-both': {
    const [prNumber, repo, newStateJson, legacyStateJson] = rest
    saveState(prNumber, repo, JSON.parse(newStateJson))
    const legacyDir = storePath(sessionScope(), 'pr-monitor')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'state.json')
    const legacyStore = {
      prs: {
        [`${repo}#${prNumber}`]: {
          state: JSON.parse(legacyStateJson),
          updatedAt: new Date().toISOString(),
        },
      },
    }
    writeFileSync(legacyPath, JSON.stringify(legacyStore))
    console.log(
      JSON.stringify({ loaded: loadState(prNumber, repo), legacyExists: existsSync(legacyPath) })
    )
    break
  }
  // Writes a raw legacy store file (a full `{prs: {...}}` blob, arbitrary PR keys) at THIS cwd's
  // legacy location, without going through loadState/saveState. Used to seed multiple sibling
  // dirKey directories with independent legacy content for the sibling-merge test.
  case 'legacy-write-raw': {
    const [entriesJson] = rest
    const legacyDir = storePath(sessionScope(), 'pr-monitor')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'state.json')
    writeFileSync(legacyPath, JSON.stringify({ prs: JSON.parse(entriesJson) }))
    console.log(legacyPath)
    break
  }
  // Reports whether THIS cwd's legacy file still exists — used to confirm adopted sibling legacy
  // files SURVIVE (adopt-and-leave, not adopt-and-remove — see state.ts's adoptLegacy).
  case 'legacy-exists': {
    const legacyPath = join(storePath(sessionScope(), 'pr-monitor'), 'state.json')
    console.log(String(existsSync(legacyPath)))
    break
  }
  // Saves via the real saveState, then dumps the raw on-disk JSON plus its mode — used to pin the
  // store key format AND the file permissions atomicWrite gives it, directly, rather than
  // inferring either from loadState's behaviour.
  case 'save-and-dump': {
    const [prNumber, repo, stateJson] = rest
    saveState(prNumber, repo, JSON.parse(stateJson))
    const path = statePath()
    console.log(
      JSON.stringify({
        raw: readFileSync(path, 'utf-8'),
        mode: statSync(path).mode & 0o777,
      })
    )
    break
  }
  // NEW-1: writes a legacy file (so a broken guard would try to merge it in), then makes the
  // CURRENT path unreadable-as-a-file by putting a directory where the state file should be —
  // readFileSync throws EISDIR, a portable non-ENOENT stand-in for EACCES/EIO that doesn't depend
  // on chmod being honored (e.g. under a root test runner). Reports whether loadState threw, what
  // it returned, and whether the legacy file survived untouched.
  case 'unreadable-current-with-legacy': {
    const [prNumber, repo, legacyStateJson] = rest
    const legacyDir = storePath(sessionScope(), 'pr-monitor')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'state.json')
    const legacyStore = {
      prs: {
        [`${repo}#${prNumber}`]: {
          state: JSON.parse(legacyStateJson),
          updatedAt: new Date().toISOString(),
        },
      },
    }
    writeFileSync(legacyPath, JSON.stringify(legacyStore))

    mkdirSync(statePath(), { recursive: true })

    let threw = false
    let loaded: unknown = 'not-called'
    try {
      loaded = loadState(prNumber, repo)
    } catch {
      threw = true
    }
    console.log(JSON.stringify({ threw, loaded, legacyExists: existsSync(legacyPath) }))
    break
  }
  default:
    throw new Error(`unknown action: ${action}`)
}
