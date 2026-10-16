import { invokeDashboardRaw } from './invoke.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

// Read one board item's prompt back by id — pull-only recovery for an agent whose context was
// compacted and that holds an id it can no longer place. Deliberately takes no session: a
// recovering agent may have no live node, which is exactly the case a session lookup would refuse.
// Writes nothing, here or on the board: the backend verb is a select, and this layer adds no
// local-state update either.
//
// One availability guard, not two. `invokeDashboardRaw` returns null on exactly one condition,
// unavailability, so the null check below is that guard in full; resolving the binary again ahead
// of it would add a decision point without adding a decision. `status.ts` carries the reasoning.
export const runItemShow = (item: string): void => {
  const invocation = invokeDashboardRaw(['item', 'show', '--item', item])
  if (invocation === null) return
  if (invocation.status !== 0) {
    reportFailure(item, invocation.detail)
    setRequestedExitCode(invocation.status ?? 1)
    return
  }
  const shown = parseShownItem(invocation.stdout)
  if (shown === null) {
    process.stderr.write('dashboard: could not parse item show output\n')
    setRequestedExitCode(1)
    return
  }
  process.stdout.write(formatShownItem(shown) + '\n')
}

// The four fields this command renders. The backend hands back the whole row — `response`,
// `decision` and every timestamp included — and trimming it to the prompt is this layer's job. The
// trim is done HERE, at the parse boundary, rather than in the renderer: a field that never enters
// the projection cannot be printed by any later edit to the formatting.
//
// Why the trim exists at all: `unrelease` requires `readAt` null and `consume` requires it
// non-null, and the runtime paths that stamp it are `dashboard answers` and `dashboard comments`.
// An agent that could read an answer through this command would sit outside both gates.
interface ShownItem {
  id: string
  type: string
  state: string
  prompt?: string
}

const parseShownItem = (out: string): ShownItem | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const item = (parsed as { item?: unknown }).item
  if (typeof item !== 'object' || item === null) return null
  const row = item as Record<string, unknown>
  if (typeof row.id !== 'string') return null
  if (typeof row.type !== 'string') return null
  if (typeof row.state !== 'string') return null
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    prompt: typeof row.prompt === 'string' ? row.prompt : undefined,
  }
}

// The marker prefix matches the wake line's so an agent reads both the same way, but the shape
// after it deliberately differs — `(<type>): <answer>` there, `<type>/<state>` and the prompt on
// its own line here — so the two are not mistaken for each other in a transcript.
const formatShownItem = (item: ShownItem): string =>
  `[dashboard] item ${item.id} ${item.type}/${item.state}\n${item.prompt ?? 'no prompt recorded'}`

const reportFailure = (item: string, detail: string): void => {
  process.stderr.write(`dashboard: ai-workflow-app item show --item ${item} failed: ${detail}\n`)
  if (!detail.includes('No command registered')) return
  process.stderr.write(
    'dashboard: the installed ai-workflow-app has no `item show` route — it predates the ' +
      'read-by-id verb. Install a newer ai-workflow-app build and retry.\n'
  )
}
