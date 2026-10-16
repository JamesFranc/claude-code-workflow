import { resolveSessionTargetOrRefuse } from './session-id.ts'
import { dashboardAvailable, invokeDashboard } from './invoke.ts'
import { formatReleasedEntry, parseReleasedItems } from './released.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

// answers: released questions/approvals (a rejection note is the approval's `response`).
export const runReadAnswers = (session?: string, key?: string): void =>
  readReleased('answers', session, key)
// comments: released reviewer comments.
export const runReadComments = (session?: string, key?: string): void =>
  readReleased('comments', session, key)

// Shared reader: invoke the backend read verb, print each released item with the line naming the
// command that consumes it, or a short notice when there are none. Reading does not consume —
// `consume` stays explicit, which is why every item says how.
const readReleased = (verb: 'answers' | 'comments', session?: string, key?: string): void => {
  if (!dashboardAvailable()) {
    return
  }

  const sessionId = resolveSessionTargetOrRefuse(session, key)
  if (sessionId === null) {
    return
  }

  const out = invokeDashboard([verb, '--session', sessionId])
  if (out === null) {
    return
  }

  const items = parseReleasedItems(out)
  if (items === null) {
    process.stderr.write(`dashboard: could not parse ${verb} output\n`)
    setRequestedExitCode(1)
    return
  }
  if (items.length === 0) {
    process.stdout.write(`No released ${verb} for this session.\n`)
    return
  }

  for (const item of items) {
    process.stdout.write(formatReleasedEntry(item, sessionId) + '\n')
  }
}
