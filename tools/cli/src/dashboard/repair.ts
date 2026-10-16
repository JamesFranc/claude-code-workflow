import { resolveRawSessionId } from './session-id.ts'
import { clearState } from './state.ts'
import { loadRegistry, removeRegistryNode } from './registry.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

export interface RepairOptions {
  forget: string[]
  dryRun: boolean
}

/**
 * Manipulate local session state directly. Deliberately dumb (FLOW-133): it never contacts the
 * board, never infers a target, and never validates an id against reality — the agent decides what
 * is wrong and names the ids. This verb exists so the agent does not have to hand-edit JSON.
 * `enter`/`leave` are untouched by design.
 *
 * The registry has no single "active" slot to set or clear (FLOW-173) — the old `--set-active` /
 * `--clear-active` pointer ops are gone. `--forget <id>` now drops BOTH the id's cached per-node
 * state AND its registry entry. Unlike the old pointer model (where a node's parentId lived only
 * in its own state file, so forgetting the CURRENTLY ACTIVE node destroyed the only copy and
 * stranded a later `leave` at the root), a registry node's parentId lives in the registry entry
 * itself, and other nodes reference their parent by id rather than through a walked chain — so
 * forgetting a node cannot strand `leave`. It CAN orphan children: any live node that still names
 * the forgotten id as its parent loses the only local record of that ancestor. Warns (does not
 * refuse) when that would happen — repair stays board-free and does not infer whether the agent
 * is deliberately cleaning up the child too in the same invocation (FLOW-133).
 */
export const runRepair = (options: RepairOptions, session?: string): void => {
  let rawSessionId: string
  try {
    assertOperations(options)
    rawSessionId = resolveRawSessionId(session)
    for (const id of options.forget) assertIdShape(id)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return
  }

  for (const warning of warnOrphaningChildren(options, rawSessionId)) {
    process.stderr.write(`${warning}\n`)
  }

  // Each operation's description is built exactly once here and reused for both paths below —
  // two independently-maintained copies of the same strings (one printed by --dry-run, one
  // printed by the real run) would let --dry-run drift out of sync with what the real run
  // actually does, which is the one guarantee --dry-run exists to make.
  const operations = buildOperations(options, rawSessionId)

  if (options.dryRun) {
    process.stdout.write(`dry run — would perform ${operations.length} write(s):\n`)
    for (const op of operations) process.stdout.write(`  ${op.describe}\n`)
    return
  }

  // Print each write as it lands, not after all of them succeed. clearState can throw on a real
  // fs error (EACCES/EPERM/EISDIR — it is deliberately not swallow-everything), and a throw
  // partway through the forget loop must not leave some already-forgotten ids with zero output
  // describing what actually happened. Whatever is printed before a throw is exactly what landed.
  process.stdout.write(`repairing ${rawSessionId} — ${operations.length} write(s):\n`)
  for (const op of operations) {
    op.apply()
    process.stdout.write(`  done: ${op.describe}\n`)
  }
}

const assertOperations = (options: RepairOptions): void => {
  if (options.forget.length === 0)
    throw new Error('dashboard session repair: nothing to do — pass --forget')
}

// Warn (not refuse) when a --forget would leave a live child pointing at an id no longer in the
// registry. A child forgotten in the SAME invocation does not trigger the warning for its own
// parent — the agent is plainly cleaning up the whole subtree, not orphaning anything.
const warnOrphaningChildren = (options: RepairOptions, rawSessionId: string): string[] => {
  const nodes = loadRegistry(rawSessionId)
  const warnings: string[] = []
  for (const id of options.forget) {
    const children = nodes.filter(
      (n) => n.parentId === id && !options.forget.includes(n.internalId)
    )
    if (children.length === 0) continue
    const names = children.map((c) => c.key ?? c.internalId).join(', ')
    warnings.push(
      `dashboard session repair: warning — forgetting ${id} orphans ${children.length} live child node(s) still in the registry (${names})`
    )
  }
  return warnings
}

interface RepairOperation {
  describe: string
  apply: () => void
}

// Two separate operations per id, not one combined apply(): clearState and removeRegistryNode
// are two independent writes to two independent stores, and a real fs error can fail one without
// the other (clearState's own comment notes it deliberately does not swallow errors). Splitting
// them means a partial failure is surfaced precisely — "done: forget cached state for X" printed,
// then the throw, rather than an opaque all-or-nothing line that hides which write actually
// landed.
const buildOperations = (options: RepairOptions, rawSessionId: string): RepairOperation[] => {
  return options.forget.flatMap((id) => [
    {
      describe: `forget cached state for ${id}`,
      apply: () => clearState(id),
    },
    {
      describe: `forget registry entry for ${id}`,
      apply: () => removeRegistryNode(rawSessionId, id),
    },
  ])
}

// Shape only. Whether the id names a real node is the agent's problem, not the tool's — checking
// the board would make this verb infer, which is exactly what it must not do.
const assertIdShape = (id: string): void => {
  if (!/^[A-Za-z0-9:_-]+$/.test(id))
    throw new Error(`dashboard session repair: malformed session id: ${id}`)
}
