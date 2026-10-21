import { buildCommand, buildRouteMap } from '@stricli/core'
import { parseNonBlankString } from '../parse.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { DashboardEnterRefusal, runEnter } from '../dashboard/enter.ts'
import { runSessionKey } from '../dashboard/key.ts'
import { runRefreshReturn } from '../dashboard/return-link.ts'
import {
  runItemAdd,
  runItemAnswer,
  runItemApprove,
  runItemReject,
  runItemWithdraw,
  runItemConsume,
  runItemDropDeferred,
  runItemListDeferred,
  runItemFlushDeferred,
} from '../dashboard/item.ts'
import { runItemShow } from '../dashboard/show.ts'
import type { WhyMine } from '../dashboard/state.ts'
import { runHeartbeat, runEnd, runLeave, runLinkAdd } from '../dashboard/lifecycle.ts'
import { runReadAnswers, runReadComments } from '../dashboard/read.ts'
import { runStatus } from '../dashboard/status.ts'
import { runRepair } from '../dashboard/repair.ts'

const sessionFlag = {
  kind: 'parsed' as const,
  parse: String,
  brief: 'Session id (defaults to CLAUDE_CODE_SESSION_ID)',
  optional: true as const,
}

const keyFlag = {
  kind: 'parsed' as const,
  parse: String,
  brief: 'Target node key (e.g. a ticket id) when this session has multiple active leaves',
  optional: true as const,
}

// `item add --answers/--replaces/--related`: each repeatable, each passed through to the app.
const referenceFlag = (name: string, brief: string) => ({
  kind: 'parsed' as const,
  parse: parseNonBlankString(`--${name}`),
  variadic: true as const,
  default: [] as string[],
  brief,
})

const heartbeatCommand = buildCommand({
  docs: { brief: 'Send a heartbeat to keep the session alive on the dashboard' },
  parameters: {
    flags: { session: sessionFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string }) {
    runHeartbeat(flags.session)
  },
})

const endCommand = buildCommand({
  docs: { brief: 'Mark the session as ended on the dashboard' },
  parameters: {
    flags: { session: sessionFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string }) {
    runEnd(flags.session)
  },
})

// Only the blank check lives at this parse boundary, matching --recommend/--stalls's own parse
// callbacks (both parseNonBlankString and nothing else) — a blank --phase exits via Stricli's own
// parse-failure path (252) the same way a blank --recommend or --stalls does. The line-break and
// declaration-grammar checks live in runEnter instead: those are semantic refusals, and this
// feature's own exit-1 `dashboard:`-prefixed contract (item.ts's --recommend/--stalls) is what
// every sibling grammar guard uses for that, not a Stricli parse throw. The value that reaches the
// composer at defer time is base.phase read back off the state file, not this parser's return value
// directly, so queueDeferredQuestion (item.ts) re-checks it
// there too: a state file written by an older or different build's --phase parser is not covered by
// either guard.
const parsePhase = parseNonBlankString('--phase')

const enterCommand = buildCommand({
  docs: {
    brief: 'Start (or re-enter) work on a node, making it the current leaf',
  },
  parameters: {
    flags: {
      level: {
        kind: 'parsed',
        parse: String,
        brief:
          'Deprecated and ignored (FLOW-205). Accepted so a plugin cache still passing it does not error; dropped in a later release',
        optional: true,
      },
      key: {
        kind: 'parsed',
        parse: String,
        brief: 'Node key (e.g. a ticket id) used to derive the node id (omit for the root)',
        optional: true,
      },
      phase: {
        kind: 'parsed',
        parse: parsePhase,
        brief: 'Phase name (e.g. prd, architecture, pr)',
        optional: false,
      },
      title: {
        kind: 'parsed',
        parse: String,
        brief:
          'Human-readable node title. Names the node on first enter; renaming an existing node also requires --retitle',
        optional: true,
      },
      'parent-key': {
        kind: 'parsed',
        parse: String,
        brief: 'Parent node key, if this node nests under one already entered',
        optional: true,
      },
      retitle: {
        kind: 'boolean',
        brief: 'Deliberately rename an already-entered node (required to change its --title)',
        default: false,
      },
      'parent-session': {
        kind: 'parsed',
        parse: String,
        brief:
          "Nest this session's root under another Claude session's current board node (a teammate under its lead). Keyless enter only",
        optional: true,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    level?: string
    key?: string
    phase: string
    title?: string
    'parent-key'?: string
    retitle: boolean
    'parent-session'?: string
    session?: string
  }) {
    try {
      runEnter(
        flags.key,
        flags.phase,
        flags.title,
        flags['parent-key'],
        flags.session,
        flags.retitle,
        flags['parent-session']
      )
    } catch (err) {
      // runEnter's argument refusals throw so its unit tests can assert them; the operator-visible
      // contract is the sibling one — the message on stderr and exit 1, no stack. Anything that is
      // not a refusal is a real fault and rethrows with its stack intact.
      if (!(err instanceof DashboardEnterRefusal)) throw err
      process.stderr.write(`${err.message}\n`)
      setRequestedExitCode(1)
    }
  },
})

const leaveCommand = buildCommand({
  docs: { brief: 'Finish the current leaf and repoint back to its parent (or the root)' },
  parameters: {
    flags: {
      root: {
        kind: 'boolean',
        brief: 'Confirm leaving at the root — ends the whole epic (refused without this flag)',
        default: false,
      },
      key: {
        kind: 'parsed',
        parse: String,
        brief: 'Target node key (e.g. a ticket id) when this session has multiple active leaves',
        optional: true,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { root: boolean; key?: string; session?: string }) {
    runLeave(flags.session, flags.root, flags.key)
  },
})

const statusCommand = buildCommand({
  docs: {
    brief: 'Report local session state alongside the board (read-only; reports facts, no verdict)',
  },
  parameters: {
    flags: {
      json: { kind: 'boolean', brief: 'Emit the report as JSON', default: false },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { json: boolean; session?: string }) {
    runStatus(flags.json, flags.session)
  },
})

const repairCommand = buildCommand({
  docs: {
    brief: 'Forget cached local session/registry state (the agent names the ids; never infers)',
  },
  parameters: {
    flags: {
      forget: {
        kind: 'parsed',
        parse: String,
        variadic: true,
        default: [],
        brief: 'Discard cached per-node state and registry entry for this session id (repeatable)',
      },
      'dry-run': {
        kind: 'boolean',
        brief: 'Print the writes that would happen; change nothing',
        default: false,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { forget: string[]; 'dry-run': boolean; session?: string }) {
    runRepair(
      {
        forget: flags.forget,
        dryRun: flags['dry-run'],
      },
      flags.session
    )
  },
})

const keyCommand = buildCommand({
  docs: {
    brief: "Print the key this ticket's node is live under (nothing when it has none)",
  },
  parameters: {
    flags: {
      ticket: {
        kind: 'parsed',
        parse: parseNonBlankString('--ticket'),
        brief: 'Ticket id whose node key to resolve (e.g. FLOW-207)',
        optional: false,
      },
      require: {
        kind: 'boolean',
        brief: 'Fail when the ticket has no live node, instead of printing nothing',
        default: false,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { ticket: string; require: boolean; session?: string }) {
    runSessionKey(flags.ticket, flags.require, flags.session)
  },
})

const refreshReturnCommand = buildCommand({
  docs: {
    brief:
      "Re-point the session root's return link at the terminal this session runs in (no-op outside iTerm2)",
  },
  parameters: {
    flags: {
      cwd: {
        kind: 'parsed',
        parse: parseNonBlankString('--cwd'),
        brief: 'Directory the session was launched from (recorded for `claude --resume`)',
        optional: true,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { cwd?: string; session?: string }) {
    runRefreshReturn(flags.cwd, flags.session)
  },
})

const sessionRoutes = buildRouteMap({
  routes: {
    enter: enterCommand,
    key: keyCommand,
    'refresh-return': refreshReturnCommand,
    leave: leaveCommand,
    heartbeat: heartbeatCommand,
    end: endCommand,
    status: statusCommand,
    repair: repairCommand,
  },
  docs: { brief: 'Manage dashboard session lifecycle' },
})

const linkAddCommand = buildCommand({
  docs: { brief: 'Add a link to the dashboard session' },
  parameters: {
    flags: {
      kind: {
        kind: 'parsed',
        parse: String,
        brief: 'Link kind (e.g. ticket, prd, pr, architecture)',
        optional: false,
      },
      label: {
        kind: 'parsed',
        parse: String,
        brief: 'Display label for the link',
        optional: false,
      },
      url: { kind: 'parsed', parse: String, brief: 'URL for the link', optional: false },
      key: {
        kind: 'parsed',
        parse: String,
        brief:
          'Target node key (e.g. a ticket id) — required as soon as the session root has ANY children, not only when there are several; pass --root instead to target the root, which has no key',
        optional: true,
      },
      root: {
        kind: 'boolean',
        brief: 'Target the session root explicitly (a root has no key, so --key cannot name it)',
        default: false,
      },
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    kind: string
    label: string
    url: string
    session?: string
    key?: string
    root: boolean
  }) {
    runLinkAdd(flags.kind, flags.label, flags.url, flags.session, flags.key, flags.root)
  },
})

const linkRoutes = buildRouteMap({
  routes: { add: linkAddCommand },
  docs: { brief: 'Manage dashboard session links' },
})

const itemAddCommand = buildCommand({
  docs: {
    brief:
      'Post a question/approval item and record its id in session state, or an info note (never recorded — nothing answers it) — or, with --defer, queue a question on this node instead of posting (see --defer; `flush-deferred` posts it later). With no board available it prints the composed item and exits 3, for the agent to ask in the terminal.',
  },
  parameters: {
    flags: {
      type: {
        kind: 'parsed',
        parse: (s: string): 'question' | 'approval' | 'info' => {
          if (s !== 'question' && s !== 'approval' && s !== 'info')
            throw new Error(`type must be question, approval or info, got: ${s}`)
          return s
        },
        brief: 'Item type: question, approval or info (a note that needs nothing from the user)',
        optional: false,
      },
      prompt: {
        kind: 'parsed',
        parse: String,
        brief: 'The question, approval or note text',
        optional: false,
      },
      key: keyFlag,
      'approval-kind': {
        kind: 'parsed',
        parse: (s: string): 'hold' | 'credential' | 'checkpoint' => {
          if (s !== 'hold' && s !== 'credential' && s !== 'checkpoint')
            throw new Error(`--approval-kind must be hold, credential or checkpoint, got: ${s}`)
          return s
        },
        brief:
          'Declare this approval a HOLD, a credential/auth/environment ask, or a checkpoint (a paused workflow with nothing to decide) — the ONLY three exemptions from the open-question guard (skills/board/references/dashboard-protocol.md §3.1; the CLI cannot tell these apart from the prompt text). Do not pass this to route around a refusal on an approval that is actually advancement — that refusal is correct; wait instead',
        optional: true,
      },
      recommend: {
        kind: 'parsed',
        parse: parseNonBlankString('--recommend'),
        brief:
          'Required on --type question: what you would do, in one line. There is no question for which this is unanswerable — a pure taste call still has one',
        optional: true,
      },
      stalls: {
        kind: 'parsed',
        parse: parseNonBlankString('--stalls'),
        brief:
          'Required on --type question: what is waiting on the answer, or the literal word none',
        optional: true,
      },
      'why-mine': {
        kind: 'parsed',
        parse: (s: string): WhyMine => {
          if (
            s !== 'taste' &&
            s !== 'scope' &&
            s !== 'risk' &&
            s !== 'teammate-unsettled' &&
            s !== 'fact'
          )
            throw new Error(
              `--why-mine must be taste, scope, risk, teammate-unsettled or fact, got: ${s}`
            )
          return s
        },
        brief:
          'Required on --type question: which escalation route this took (skills/board/references/escalation-contract.md §Required question form). Choosing a value is itself the claim the question cleared all three rungs — there is no value meaning you skipped them',
        optional: true,
      },
      defer: {
        kind: 'boolean',
        brief:
          "Mark this a deferral-gate question — discovered work proposed for deferral (contract rule 5). Queues the question on this node instead of posting it — no item is posted, but resolving this node's own session target may still call the board and may refuse. `dashboard item flush-deferred` posts it as its own board item later. Requires --stalls none, and is refused on --type approval. With no board available it is not queued: the question is printed and the command exits 3.",
        default: false,
      },
      answers: referenceFlag(
        'answers',
        'ID of an item this one answers, such as the user comment it replies to (repeatable)'
      ),
      replaces: referenceFlag(
        'replaces',
        'ID of an item this one takes the place of, such as one you withdrew for it (repeatable)'
      ),
      related: referenceFlag('related', 'ID of an item this one is about (repeatable)'),
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: {
    type: 'question' | 'approval' | 'info'
    prompt: string
    session?: string
    key?: string
    'approval-kind'?: 'hold' | 'credential' | 'checkpoint'
    recommend?: string
    stalls?: string
    'why-mine'?: WhyMine
    defer: boolean
    answers: string[]
    replaces: string[]
    related: string[]
  }) {
    runItemAdd(flags.type, flags.prompt, {
      session: flags.session,
      key: flags.key,
      approvalKind: flags['approval-kind'],
      recommend: flags.recommend,
      stalls: flags.stalls,
      whyMine: flags['why-mine'],
      defer: flags.defer,
      references: [
        ...flags.answers.map((itemId) => ({ kind: 'answers' as const, itemId })),
        ...flags.replaces.map((itemId) => ({ kind: 'replaces' as const, itemId })),
        ...flags.related.map((itemId) => ({ kind: 'related' as const, itemId })),
      ],
    })
  },
})

const itemAnswerCommand = buildCommand({
  docs: {
    brief: 'Record the answer to a question item (reflects a terminal answer onto the dashboard)',
  },
  parameters: {
    flags: {
      item: { kind: 'parsed', parse: String, brief: 'Item id', optional: false },
      response: { kind: 'parsed', parse: String, brief: 'The answer text', optional: false },
      session: sessionFlag,
      key: keyFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { item: string; response: string; session?: string; key?: string }) {
    runItemAnswer(flags.item, flags.response, flags.session, flags.key)
  },
})

const itemApproveCommand = buildCommand({
  docs: {
    brief: 'Mark an approval item as approved (reflects a terminal approval onto the dashboard)',
  },
  parameters: {
    flags: {
      item: { kind: 'parsed', parse: String, brief: 'Item id', optional: false },
      note: { kind: 'parsed', parse: String, brief: 'Optional note', optional: true },
      session: sessionFlag,
      key: keyFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { item: string; note?: string; session?: string; key?: string }) {
    runItemApprove(flags.item, flags.note, flags.session, flags.key)
  },
})

const itemRejectCommand = buildCommand({
  docs: {
    brief: 'Mark an approval item as rejected (reflects a terminal rejection onto the dashboard)',
  },
  parameters: {
    flags: {
      item: { kind: 'parsed', parse: String, brief: 'Item id', optional: false },
      note: {
        kind: 'parsed',
        parse: String,
        brief: 'Rejection reason (required)',
        optional: false,
      },
      session: sessionFlag,
      key: keyFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { item: string; note: string; session?: string; key?: string }) {
    runItemReject(flags.item, flags.note, flags.session, flags.key)
  },
})

const itemShowCommand = buildCommand({
  docs: {
    brief: 'Read one item’s prompt back by id — recovery for an answer you cannot place',
    fullDescription:
      'Prints the item’s type, state and prompt in any lifecycle state, consumed included, and ' +
      'writes nothing. Takes no --session: a compacted agent may have no live node, which is the ' +
      'case this exists for. It returns the prompt and never the answer — read the answer with ' +
      '`dashboard answers`, which is also what marks it read so `dashboard item consume` will ' +
      'accept it. Exits 1 if no such item exists.',
  },
  parameters: {
    flags: {
      item: { kind: 'parsed', parse: String, brief: 'Item id to read', optional: false },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { item: string }) {
    runItemShow(flags.item)
  },
})

const itemWithdrawCommand = buildCommand({
  docs: { brief: 'Withdraw a single item or all pending items for this session' },
  parameters: {
    flags: {
      item: { kind: 'parsed', parse: String, brief: 'Item id to withdraw', optional: true },
      all: {
        kind: 'boolean',
        brief: 'Withdraw all pending items for this session',
        default: false,
      },
      session: sessionFlag,
      key: keyFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { item?: string; all: boolean; session?: string; key?: string }) {
    runItemWithdraw(flags.item, flags.all, flags.session, flags.key)
  },
})

const itemConsumeCommand = buildCommand({
  docs: { brief: 'Acknowledge dashboard-answered items as consumed (released → consumed)' },
  parameters: {
    flags: {
      item: { kind: 'parsed', parse: String, brief: 'Item id to consume', optional: true },
      all: {
        kind: 'boolean',
        brief: 'Consume all released items for this session',
        default: false,
      },
      session: sessionFlag,
      key: keyFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { item?: string; all: boolean; session?: string; key?: string }) {
    runItemConsume(flags.item, flags.all, flags.session, flags.key)
  },
})

const itemDropDeferredCommand = buildCommand({
  docs: {
    brief: 'Remove a queued deferred question the work itself answered',
  },
  parameters: {
    flags: {
      id: {
        kind: 'parsed',
        parse: parseNonBlankString('--id'),
        brief: 'Id of the queued question (from `dashboard item list-deferred`)',
        optional: true,
      },
      reason: {
        kind: 'parsed',
        parse: parseNonBlankString('--reason'),
        brief: 'What answered it — printed with the result, never posted',
        optional: true,
      },
      key: keyFlag,
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { id?: string; reason?: string; key?: string; session?: string }) {
    runItemDropDeferred(flags.id, flags.reason, { session: flags.session, key: flags.key })
  },
})

const itemListDeferredCommand = buildCommand({
  docs: { brief: 'Print this node’s deferred-question queue as JSON (review before flushing)' },
  parameters: {
    flags: { key: keyFlag, session: sessionFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { key?: string; session?: string }) {
    runItemListDeferred({ session: flags.session, key: flags.key })
  },
})

const itemFlushDeferredCommand = buildCommand({
  docs: {
    brief: 'Post every queued deferred question as its own board item, in one call',
  },
  parameters: {
    flags: {
      context: {
        kind: 'parsed',
        parse: parseNonBlankString('--context'),
        brief:
          'What the questions point at — normally the PR URL, appended to each posted question',
        optional: true,
      },
      key: keyFlag,
      session: sessionFlag,
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { context?: string; key?: string; session?: string }) {
    runItemFlushDeferred({ context: flags.context, session: flags.session, key: flags.key })
  },
})

const itemRoutes = buildRouteMap({
  routes: {
    add: itemAddCommand,
    answer: itemAnswerCommand,
    approve: itemApproveCommand,
    reject: itemRejectCommand,
    show: itemShowCommand,
    withdraw: itemWithdrawCommand,
    consume: itemConsumeCommand,
    'drop-deferred': itemDropDeferredCommand,
    'list-deferred': itemListDeferredCommand,
    'flush-deferred': itemFlushDeferredCommand,
  },
  docs: {
    brief:
      'Manage dashboard items: post questions/approvals, read one back by id, reconcile outcomes, and defer/drop/list/flush deferred questions',
  },
})

const answersCommand = buildCommand({
  docs: {
    brief:
      'Read released answers (questions/approvals the user resolved, incl. a rejection note) on demand',
  },
  parameters: {
    flags: { session: sessionFlag, key: keyFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string; key?: string }) {
    runReadAnswers(flags.session, flags.key)
  },
})

const commentsCommand = buildCommand({
  docs: { brief: 'Read released reviewer comments for this session on demand' },
  parameters: {
    flags: { session: sessionFlag, key: keyFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string; key?: string }) {
    runReadComments(flags.session, flags.key)
  },
})

export const dashboardRoutes = buildRouteMap({
  routes: {
    session: sessionRoutes,
    link: linkRoutes,
    item: itemRoutes,
    answers: answersCommand,
    comments: commentsCommand,
  },
  docs: {
    brief: 'Dashboard session tracking: register, update phase, heartbeat, end, and link sessions',
  },
})
