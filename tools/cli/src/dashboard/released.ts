// Shape of released items returned by `answers` / `comments` (REV-3). The note on an approval
// lives in `response` (there is no `note` field on backend items).
export interface ReleasedItem {
  id: string
  type: string
  prompt?: string
  response?: string
  decision?: string
  // The item's outgoing references (FLOW-405). Absent from an app that predates them.
  references?: ReleasedReference[]
}

export interface ReleasedReference {
  kind: 'answers' | 'replaces' | 'related'
  // null when the referenced item has since been deleted.
  item: { id: string; type: string; prompt?: string | null; response?: string | null } | null
}

// One released item as an agent reads it: the item, then a line saying what to do with it. Shared by
// `mailbox check` (the wake) and `dashboard answers`/`comments`, so every read of a released item
// names the command that consumes it. Reading never consumes, and the wake mod delivers an item only
// once, so the line that delivers it is the one place the agent is sure to see that command. The
// instruction is a line of its own so the item's first line stays exactly what `formatReleasedItem`
// prints: hooks/permission-hold.sh reads an approval's decision and note off it.
export const formatReleasedEntry = (item: ReleasedItem, nodeId: string): string =>
  `${formatReleasedItem(item)}\n  → ${releasedItemInstruction(item, nodeId)}`

// What to do with a released item, as one sentence. Every command targets the node the item was
// released on by `--session`: the anchor is the root when the session has several live leaves, and a
// command without `--session` refuses there. A comment is answered on the board before it is
// consumed; the `[dashboard] item` tag alone does not say a reply belongs there.
export const releasedItemInstruction = (item: ReleasedItem, nodeId: string): string => {
  const consume = `\`dashboard item consume --item ${item.id} --session ${nodeId}\``
  if (item.type === 'comment') {
    return (
      'reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers ${item.id} --session ${nodeId} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: ${consume}`
    )
  }

  return `act on it, then consume it: ${consume}`
}

// The item itself: one line per item, several when the response itself contains newlines. For an
// approval the decision leads and the note (response) follows; a question has no decision, so its
// answer (response) is the whole detail. Each outgoing reference follows as its own indented `↳`
// line, so a comment shows which item it is about.
export const formatReleasedItem = (item: ReleasedItem): string => {
  const detail = item.decision
    ? item.response
      ? `${item.decision} — ${item.response}`
      : item.decision
    : (item.response ?? '')

  return [
    `[dashboard] item ${item.id} (${item.type}): ${detail}`,
    ...(item.references ?? []).map(formatReference),
  ].join('\n')
}

const REFERENCE_PREVIEW_MAX_CHARS = 120
const REFERENCE_VERB = { answers: 'answers', replaces: 'replaces', related: 'related to' } as const

const formatReference = ({ kind, item }: ReleasedReference): string => {
  if (item === null) {
    return `  ↳ ${REFERENCE_VERB[kind]} an item that no longer exists`
  }
  const firstLine = (item.prompt ?? item.response ?? '').split('\n')[0] ?? ''
  const preview =
    [...firstLine].length > REFERENCE_PREVIEW_MAX_CHARS
      ? `${[...firstLine].slice(0, REFERENCE_PREVIEW_MAX_CHARS).join('')}…`
      : firstLine
  return `  ↳ ${REFERENCE_VERB[kind]} item ${item.id} (${item.type}): ${preview}`
}

// Parse `answers`/`comments` stdout into released items. Returns null when the payload is
// not a JSON array (parse failure or a non-array value) so callers can distinguish
// "backend returned no items" from "we couldn't read the backend's output".
export const parseReleasedItems = (out: string): ReleasedItem[] | null => {
  try {
    const parsed: unknown = JSON.parse(out)
    return Array.isArray(parsed) ? (parsed as ReleasedItem[]) : null
  } catch {
    return null
  }
}
