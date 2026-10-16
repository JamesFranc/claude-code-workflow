import { resolveRawSessionId } from './session-id.ts'
import { loadRegistry, type RegistryNode } from './registry.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

/**
 * Answer "which key is this ticket's board node live under in THIS session?" — the question every
 * skill that RE-ENTERS a ticket node has to ask, ever since the restart recovery gained the right to
 * mint a replacement key (`<TICKET-ID>-resumed`, `-resumed-2`, …) in `commands/restart-jobs.md`.
 *
 * Skills used to answer it by writing `<TICKET-ID>` as a literal, and that literal IS the node:
 * `enter` composes `externalId = <root>:<key>`, so after a recovery every hardcoded site recomposed
 * the dead node's id and the register upsert reactivated it. A lookup cannot be forgotten one file
 * away; five copies of a remembered value can, and were — twice (FLOW-137, then FLOW-207).
 *
 * Contract: exactly one match → its key on stdout, exit 0; zero → nothing, exit 0; two or more →
 * every match named on stderr, non-zero, nothing on stdout.
 *
 * Zero is an answer, not a failure — the ticket IS the dashboard root, or its node has not been
 * entered yet. Two or more is a failure this verb must not paper over: nothing in the registry
 * distinguishes a deliberate revival from an accidental reactivation, so choosing between them
 * would be a guess wearing a rule's clothes. The only other failure is having no session id, which
 * belongs to resolveRawSessionId. It makes no board call, so with the dashboard binary absent it
 * behaves as it always did: empty registry, no output, caller takes its zero-match branch.
 */
export const runSessionKey = (ticket: string, require = false, session?: string): void => {
  let rawSessionId: string
  try {
    rawSessionId = resolveRawSessionId(session)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return
  }
  const matches = ticketNodes(loadRegistry(rawSessionId), ticket)
  if (matches.length === 0) {
    // Zero is an answer on the generic path (the ticket IS the root) and an impossible state on a
    // path whose precondition asserts the node exists. Only the caller knows which, so only the
    // caller can ask for the second reading. Never default the key here: `<TICKET-ID>` recomposes
    // the dead node's external id after an interrupted recovery, and register reactivates it.
    if (!require) return
    process.stderr.write(
      `dashboard session key: no live node for ${ticket} in this session, and --require was ` +
        `passed. The caller asserted this ticket already has its own node — that precondition is ` +
        `false. Use the keyless form, or enter the node first.\n`
    )
    setRequestedExitCode(1)
    return
  }
  const first = matches[0]
  if (matches.length > 1) {
    process.stderr.write(
      `dashboard session key: ${ticket} has more than one live node in this session:\n` +
        matches
          .map((n) => `  ${n.key}  external=${n.externalId}  internal=${n.internalId}\n`)
          .join('') +
        `Which one the work belongs to is a judgement this verb cannot make. Dispose of the one you ` +
        `are not keeping — \`dashboard session repair --forget <internal id>\`, or ` +
        `\`dashboard session leave --key <key>\` when the keys differ — then re-run.\n`
    )
    setRequestedExitCode(1)
    return
  }
  process.stdout.write(`${first.key}\n`)
}

/**
 * Every node in this session's registry naming this ticket — the bare id, or any of the replacement
 * keys the restart recovery mints for it (`-resumed`, `-resumed-2`, …).
 *
 * Returns ALL of them rather than picking one, deliberately. An earlier draft ordered by "recovery
 * generation" and returned the newest, which reads as a rule and is a guess: `restart-jobs.md`'s
 * "If you deliberately need to revive one" and an accidental reactivation leave the registry in
 * identical states, so nothing here can tell which node the agent means. `resolveSessionTarget`
 * refuses the same ambiguity rather than resolving it, and FLOW-205 kept adjudication in the
 * skills, not the CLI.
 *
 * Nodes, not keys: two matches can share a key. `enter` composes the external id off the ROOT's,
 * and a dead-ROOT recovery mints a fresh root suffix, so `raw_aaaa1111:FLOW-500` and
 * `raw_bbbb2222:FLOW-500` both persist under key `FLOW-500` (they differ by internalId, which is
 * what `upsertRegistryNode` dedupes on). An error message naming only keys would print
 * `FLOW-500, FLOW-500` and propose a `--key` that cannot distinguish them.
 */
// Excludes the root, the only node with a null key, so isTicketNodeKey below can take `string` — and
// so callers get `key: string` back rather than asserting past the `string | null` on RegistryNode.
export const ticketNodes = (
  nodes: RegistryNode[],
  ticket: string
): (RegistryNode & { key: string })[] =>
  nodes.filter(
    (node): node is RegistryNode & { key: string } =>
      node.key !== null && isTicketNodeKey(node.key, ticket)
  )

/**
 * Anchored at both ends, so `FLOW-2` never matches `FLOW-20`'s node and a branch-keyed PR node never
 * matches its ticket. The ticket id is escaped first: a Jira key is `[A-Z]+-\d+` today, but this verb
 * takes whatever the caller passes, and an unescaped regex metacharacter in it would match another
 * ticket's key.
 */
const isTicketNodeKey = (key: string, ticket: string): boolean =>
  key === ticket || new RegExp(`^${escapeForPattern(ticket)}-resumed(?:-\\d+)?$`).test(key)

const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
