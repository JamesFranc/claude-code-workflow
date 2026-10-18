import { resolveSessionTargetOrRefuse, tryResolveRawSessionId } from './session-id.ts'
import {
  dashboardAvailable,
  invokeDashboard,
  resolveDashboardBin,
  invokeDashboardBin,
} from './invoke.ts'
import { findBoardNodeFor } from './board-nodes.ts'
import {
  corruptStateDiagnosis,
  deferredQuestionsOf,
  loadState,
  nextDeferredId,
  refuseCorruptState,
  saveState,
  stateFileIsCorrupt,
  stateFilePath,
  type DashboardSessionState,
  type DeferredQuestion,
  type ItemReference,
  type WhyMine,
} from './state.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { splitLines } from '../split-lines.ts'

// Caps in characters, measured by Unicode code point (`[...str].length`, not `str.length`'s UTF-16
// code units) so a multi-byte lede or recommendation is not double-counted. Calibrated against the
// measured question-length distribution in the FLOW-240 PRD (under gitignored docs/plans/, so cited
// by name, not by path) rather than picked for roundness. COMPOSED_PROMPT_MAX_CHARS sits where that
// PRD's acceptance target puts it — it refuses a composed prompt that carried its evidence inline
// instead of linking out, which is the behaviour change this gate exists to make. Refusal never
// deadlocks the asker: the evidence moves to a linked doc or a PR comment and the question posts.
const LEDE_MAX_CHARS = 200
const RECOMMEND_MAX_CHARS = 200
const STALLS_MAX_CHARS = 200
const CONTEXT_MAX_CHARS = 200
const COMPOSED_PROMPT_MAX_CHARS = 1500

// The declaration line's own grammar: bold-labeled fields (`**Recommend:**`, `**Stalls:**`, `**Yours
// because:**`) joined by ` · `. Reproducing that shape in --recommend or --stalls corrupts the one
// composed line those values are inlined into directly — no leading `>` is needed there, since the
// value lands inside the blockquote that already exists.
const DECLARATION_DELIMITER = ' · '
const BOLD_LABEL_PATTERN = /\*\*[^*\n]+:\*\*/

// A value ending or starting with the bare delimiter character — `'A ·'`, or `'· B'` — passes the
// full-delimiter check above (it never contains the 3-character ` · ` sequence itself) but can still
// corrupt the composed line: a trailing space before the `·` combines with the literal ` · ` the
// composer inlines right after --recommend (or a leading space before --stalls) to form a second,
// spurious occurrence of the full delimiter, splitting the field the value's own edge sits in.
// Refused on ANY edge `·`, not only the whitespace-adjacent form that actually corrupts — a
// deliberately blunt rule, since the character is the field's own separator and has no legitimate
// reason to sit at a --recommend/--stalls boundary either way. Checked on the trimmed value —
// ordinary leading/trailing whitespace is not itself refused, only a `·` found after trimming it.
const edgeDot = (text: string): boolean => {
  const trimmed = normalizedForDelimiterCheck(text).trim()
  return trimmed.startsWith('·') || trimmed.endsWith('·')
}

// Only for the equivalence checks below — both the delimiter and the bold-label clauses of every
// declaration-grammar predicate — never for the stored/composed value; the asker's own characters
// ship untouched. NFKC over NFC: NFC alone reduces U+0387 (GREEK ANO TELEIA, canonically equivalent
// to U+00B7) to the real delimiter character, but only NFKC's compatibility mappings also reduce
// U+00A0/U+202F (no-break spaces visually indistinguishable from a plain space) to U+0020, and also
// fold U+FF1A/U+FE55 (fullwidth/small colon) to the ASCII ':' the bold-label pattern requires — so a
// wrapped middle dot like "A␠·␠B" or a label like "**Stalls：**" needs NFKC to surface as the literal
// delimiter/colon. U+30FB KATAKANA MIDDLE DOT and U+A789 MODIFIER LETTER COLON decompose under
// neither form and must keep passing.
const normalizedForDelimiterCheck = (text: string): string => text.normalize('NFKC')

// Exported for commands/dashboard.ts's --phase parser: --phase composes into the "Deferred at
// <phase>" blockquote line (composeDeferredEntry) the same way --recommend/--stalls compose into the
// declaration line, and needs the same grammar guard at its own flag boundary.
export const reproducesDeclarationGrammar = (text: string): boolean =>
  normalizedForDelimiterCheck(text).includes(DECLARATION_DELIMITER) ||
  BOLD_LABEL_PATTERN.test(normalizedForDelimiterCheck(text)) ||
  edgeDot(text)

// Evidence in --prompt is a separate concern from --recommend/--stalls above: it can forge a whole
// extra blockquote below the real one, and that needs its own leading `>` — ordinary prose carrying
// a bold label (dashboard-protocol.md §3 asks for exactly that: "the options and any links in the
// evidence block") is not a forged declaration and must not be refused. The delimiter check stays
// text-wide; only the bold-label check is scoped to a line that actually opens with `>`.
const reproducesDeclarationBlockquote = (text: string): boolean =>
  normalizedForDelimiterCheck(text).includes(DECLARATION_DELIMITER) ||
  splitLines(text).some(
    (line) =>
      line.trim().startsWith('>') && BOLD_LABEL_PATTERN.test(normalizedForDelimiterCheck(line))
  )

// The two citation strings below are not lint-protected — `check-refs` scans skills/agents/commands
// Markdown, not .ts — so grep this file and item.test.ts for "escalation-contract.md" and for
// "dashboard-protocol.md §8" if either doc moves. refuseItem cites ESCALATION_CONTRACT_PATH unless
// its caller passes another string; the note refusals pass DASHBOARD_PROTOCOL_NOTES_SECTION.
const ESCALATION_CONTRACT_PATH = 'skills/board/references/escalation-contract.md'
const DASHBOARD_PROTOCOL_NOTES_SECTION = 'skills/board/references/dashboard-protocol.md §8'

// `item add`'s outcome when no board resolves: the composed item is on stdout, to be asked in the
// terminal. Distinct from 1, which every refusal uses.
const NO_BOARD_EXIT = 3

// add: post a question/approval item and record its id so the wake check knows a wait is pending and
// reconcile can clear it — or post an info note, whose id is never recorded: nothing answers a note,
// and the wake check and the Stop hook's gate read a non-empty openItemIds as "an answer can
// arrive" (dashboard-protocol.md §8). Prints {"itemId":…} on success — a note adds a "note" field
// (infoNoteReminder); with no board it prints the composed item and exits 3, to be asked in the
// terminal; every refusal below (corrupt state, unconfirmed post) writes stderr and sets exit 1
// instead. With a board and --defer, queues the question on this node instead — nothing posts, and
// it prints {"deferredId":…}; `runItemFlushDeferred` posts the queue later. With no board, --defer
// is handed back like any other question. Mutation verb — resolves strictly: fails loud on sibling
// ambiguity (pass --key) rather than silently guessing.
export const runItemAdd = (
  type: 'question' | 'approval' | 'info',
  prompt: string,
  opts: {
    session?: string
    key?: string
    approvalKind?: 'hold' | 'credential' | 'checkpoint'
    recommend?: string
    stalls?: string
    whyMine?: WhyMine
    defer?: boolean
    references?: ItemReference[]
  } = {}
): void => {
  const {
    session,
    key,
    approvalKind,
    recommend,
    stalls,
    whyMine,
    defer = false,
    references = [],
  } = opts
  // Argument validation, not a board operation — checked before the bin is even resolved, so a
  // malformed flag combination is refused the same way whether or not the board is reachable
  // (FLOW-211 review).
  if (type === 'question' && approvalKind !== undefined) {
    process.stderr.write(
      'dashboard: --approval-kind only applies to --type approval — this item is --type question\n'
    )
    setRequestedExitCode(1)
    return
  }
  if (type === 'approval' && defer) {
    refuseItem(
      '--defer only applies to --type question — this item is --type approval.',
      '--defer declares that the question is discovered work being proposed for deferral, which ' +
        'is the user’s decision to make; an approval already is the ask.',
      'Drop --defer, or post the deferral as --type question'
    )
    return
  }
  if (type === 'approval') {
    const questionOnly = [
      recommend !== undefined ? '--recommend' : null,
      stalls !== undefined ? '--stalls' : null,
      whyMine !== undefined ? '--why-mine' : null,
    ].filter((flag): flag is string => flag !== null)
    if (questionOnly.length > 0) {
      refuseItem(
        `${questionOnly.join(', ')} only appl${questionOnly.length === 1 ? 'ies' : 'y'} to --type question — this item is --type approval.`,
        '--recommend, --stalls and --why-mine declare why a QUESTION is the user’s to answer; an ' +
          'approval already is the ask, so there is nothing here for them to declare.',
        `Drop ${questionOnly.join(', ')}, or post this as --type question`
      )
      return
    }
  }
  if (type === 'info') {
    const notForNotes = [
      approvalKind !== undefined ? '--approval-kind' : null,
      recommend !== undefined ? '--recommend' : null,
      stalls !== undefined ? '--stalls' : null,
      whyMine !== undefined ? '--why-mine' : null,
      defer ? '--defer' : null,
    ].filter((flag): flag is string => flag !== null)
    if (notForNotes.length > 0) {
      refuseItem(
        `${notForNotes.join(', ')} only appl${notForNotes.length === 1 ? 'ies' : 'y'} to --type question or approval — this item is --type info.`,
        'A note asks the user for nothing, so there is no decision, recommendation, wait or ' +
          'deferral for these flags to declare.',
        `Drop ${notForNotes.join(', ')}, or post this as --type question if it needs an answer`,
        DASHBOARD_PROTOCOL_NOTES_SECTION
      )
      return
    }
  }
  // The composed prompt, not the raw one, is what the board stores — see composeQuestionPrompt.
  // null means it refused and has already written the reason and set exit 1.
  const composeItem = (): string | null =>
    type === 'question'
      ? composeQuestionPrompt(prompt, { recommend, stalls, whyMine, defer })
      : type === 'info'
        ? validateNotePrompt(prompt)
        : prompt
  // Resolved once and reused for the post below — the guard's own board read resolves separately
  // (see boardOpenItemCount/findBoardNodeFor, shared with status.ts). Avoids two independent
  // resolveDashboardBin() calls disagreeing if binary availability changes mid-request.
  const bin = resolveDashboardBin()
  // With no board the item is composed and validated exactly as a post would be, so a question asked
  // in the terminal has passed the same checks, and a --defer question is handed back too: there is
  // no later flush to wait for, so it is asked now rather than queued.
  if (bin === null) {
    const handBackPrompt = composeItem()
    if (handBackPrompt === null) return
    handBackForTerminal(type, handBackPrompt)
    return
  }
  // --defer does not post: it queues. A question that stalls nothing waits for a diff to point at
  // (escalation-contract.md §Blocking vs. deferrable); `flush-deferred` posts each queued question as
  // its own board item once the PR exists. It validates through queueDeferredQuestion's own
  // composition, ahead of the immediate-post composition below.
  if (type === 'question' && defer) {
    queueDeferredQuestion(prompt, { recommend, stalls, whyMine, defer }, references, session, key)
    return
  }
  const composedPrompt = composeItem()
  if (composedPrompt === null) return
  const sessionId = resolveSessionTargetOrRefuse(session, key)
  if (sessionId === null) return
  if (stateFileIsCorrupt(sessionId)) {
    refuseCorruptState(sessionId, 'post this item')
    return
  }
  if (type === 'approval' && !approvalIsAllowed(sessionId, approvalKind)) return
  const out = invokeDashboardBin(bin, [
    'item',
    'add',
    '--session',
    sessionId,
    '--type',
    type,
    ...referenceArgs(references),
    '--prompt',
    composedPrompt,
  ])
  if (out === null) return
  const itemId = usableItemId(out)
  if (itemId) {
    if (type !== 'info') {
      const state = loadState(sessionId)
      const openItemIds = state?.openItemIds ?? []
      if (!openItemIds.includes(itemId)) openItemIds.push(itemId)
      // Spread the existing state rather than rebuilding it field-by-field — a hand-rolled
      // constructor silently drops any field it doesn't name, and parentId is exactly such a
      // field: it is the tree-structure pointer that keys a node to its epic root, so dropping
      // it here orphans this node from the epic (FLOW-136).
      saveState(sessionId, {
        ...(state ?? { registered: true, phase: '', openItemIds: [] }),
        openItemIds,
      })
    }
    const result =
      type === 'info' ? { itemId, note: infoNoteReminder(itemId, sessionId) } : { itemId }
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }
  // No usable id back means the post is unconfirmed, not failed — the board call above may well
  // have landed. Nothing is written to openItemIds either way, so this command has no local record
  // to fall back on. Reporting success here would leave a caller believing the item posted with
  // nothing to explain a missing id downstream; reporting a plain failure would invite a blind
  // retry that duplicates a post that already landed.
  process.stderr.write(
    'dashboard: the post did not return a usable itemId (a non-blank string) — unconfirmed, not ' +
      'failed. This command cannot tell whether it reached the board.\n' +
      'Check the board before retrying: re-posting one that already landed creates a duplicate, not ' +
      'a correction.\n'
  )
  setRequestedExitCode(1)
}

// No board resolves: the item cannot be posted, and the user is still owed the question. Prints the
// composed item on stdout and exits 3, a code no other `item add` outcome uses, so the caller can tell
// "ask this in the terminal" apart from a refusal (exit 1). Writes no state: nothing was posted, so
// there is no openItemIds entry for the wake check or the Stop hook's gate to wait on.
const handBackForTerminal = (
  type: 'question' | 'approval' | 'info',
  composedPrompt: string
): void => {
  const instruction =
    type === 'info'
      ? 'No board is available. Tell the user this in the terminal; nothing waits on it.'
      : 'No board is available. Ask the user this in the terminal and wait for the reply.'
  process.stdout.write(`${composedPrompt}\n\n${instruction}\n`)
  setRequestedExitCode(NO_BOARD_EXIT)
}

// Validate exactly as the posting path does, then write the parts onto the node's own state instead
// of posting. Prints {"deferredId":…}: the asker needs the id to drop the question later, and
// `list-deferred` should not be the only way to learn it.
//
// No bin is resolved and no board call is made directly by this function — but resolveSessionTarget
// itself can do both: its keyless zero-leaf path falls through to a live board check
// (resolveViaBoard → fetchBoardNodes → invokeDashboardBin(bin, ['session','list'])), so this is not
// always a purely local write. The session target still resolves STRICTLY (resolveSessionTargetOrRefuse,
// the same call the posting path makes) — this is a mutation, and a queue written onto the wrong node is a
// question the user never sees.
const queueDeferredQuestion = (
  prompt: string,
  decl: { recommend?: string; stalls?: string; whyMine?: WhyMine; defer: boolean },
  references: ItemReference[],
  session: string | undefined,
  key: string | undefined
): void => {
  const parts = validateQuestionParts(prompt, decl)
  if (parts === null) return
  const sessionId = resolveSessionTargetOrRefuse(session, key)
  if (sessionId === null) return
  if (stateFileIsCorrupt(sessionId)) {
    refuseCorruptState(sessionId, 'queue this deferred question')
    return
  }
  const state = loadState(sessionId)
  const queue = deferredQuestionsOf(state)
  const base = state ?? { registered: true, phase: '', openItemIds: [] }
  // base.phase travels here from the persisted state file, not from this build's own --phase parser
  // — an older or different CLI build's runEnter could have written it with a laxer (or no) grammar
  // check, and it composes unvalidated into composeDeferredEntry's "Deferred at <phase>" blockquote
  // line the same way --recommend/--stalls do. Re-checked at the point it becomes deferredAtPhase,
  // not assumed safe because SOME --phase parser validated it at write time.
  if (/[\r\n]/.test(base.phase) || reproducesDeclarationGrammar(base.phase)) {
    refuseItem(
      'this session’s persisted phase can forge or corrupt the "Deferred at <phase>" line this ' +
        'deferral would compose into.',
      'deferredAtPhase is read from the state file as written by whatever build last ran `session ' +
        'enter --phase`, not re-validated by this build’s own --phase parser — a state file written ' +
        'by an older or different build can carry a phase this deferral would otherwise compose ' +
        'unvalidated into the flush prompt.',
      'Re-enter with a --phase value that carries no " · " delimiter, bold-label marker, or line break, then defer again'
    )
    return
  }
  const { id, counter } = nextDeferredId(state)
  const entry: DeferredQuestion = {
    id,
    lede: parts.lede,
    body: parts.body,
    recommend: parts.recommend,
    whyMine: parts.whyMine,
    deferredAtPhase: base.phase,
    ...(references.length > 0 ? { references } : {}),
  }
  // Checked against what the FLUSH will actually compose for this one entry — composeDeferredEntry
  // adds the "Deferred at <phase>" line beyond what composeSingleQuestion's immediate-post shape
  // carries. Measured with no --context, since that is checked independently at flush time and is
  // not knowable here. Without this, one over-long entry could enter the queue and refuse every
  // later flush, with no way to shorten it short of dropping it.
  if ([...composeDeferredEntry(entry, undefined)].length > COMPOSED_PROMPT_MAX_CHARS) {
    refuseItem(
      `this question, composed for the flush, is over the ${String(COMPOSED_PROMPT_MAX_CHARS)}-character cap — nothing was queued.`,
      'The flush adds a "Deferred at <phase>" line on top of the declaration and evidence this cap ' +
        'already measures, so an entry that only just fits the immediate-post shape can still refuse ' +
        'the flush once queued.',
      'Move the evidence to a linked doc or a PR comment and defer again'
    )
    return
  }
  // Spread the loaded state rather than rebuilding it — a hand-rolled constructor silently drops any
  // field it does not name, and parentId is exactly such a field (FLOW-136). `deferredIdCounter` is
  // written here, not inside `nextDeferredId` — computing an id is a pure read, and a refused entry
  // (the cap check above) must never advance the counter for an id nobody ever saw.
  saveState(sessionId, {
    ...base,
    deferredQuestions: [...queue, entry],
    deferredIdCounter: counter,
  })
  process.stdout.write(JSON.stringify({ deferredId: entry.id }) + '\n')
}

// The app's own `item add` flags, one pair per reference. The app checks each target (it must
// exist, be live and be on the same session) and refuses the whole post otherwise, so nothing is
// validated here beyond what Stricli parsed.
const referenceArgs = (references: ItemReference[]): string[] =>
  references.flatMap(({ kind, itemId }) => [`--${kind}`, itemId])

// The validated parts of a question, before composition. `body` is what the composer calls the
// evidence block: everything in --prompt after the lede.
interface QuestionParts {
  lede: string
  body: string
  recommend: string
  stalls: string
  whyMine: WhyMine
}

// Validates the three declared facts (--recommend/--stalls/--why-mine) and the prompt's shape
// (a non-blank lede, no forged declaration grammar), refusing anything that would corrupt or forge
// the composed declaration line. Composes nothing itself and emits no blockquote — that is
// composeSingleQuestion's job. Returns null when it refused — it has already written the reason to
// stderr and set exit 1.
//
// Every refusal is argument validation, so a malformed question is refused loudly whether or not a
// board is available.
const validateQuestionParts = (
  prompt: string,
  decl: { recommend?: string; stalls?: string; whyMine?: WhyMine; defer: boolean }
): QuestionParts | null => {
  const { whyMine, defer } = decl
  // Trimmed once, here, so every check below and the declaration itself all read the same
  // normalized value — the blank check and the --defer/--stalls-none check cannot disagree about
  // surrounding whitespace.
  const recommend = decl.recommend?.trim()
  const stalls = decl.stalls?.trim()
  // A direct disjunction on the variables themselves, not on a derived array — this is what lets
  // TypeScript narrow recommend/stalls/whyMine to non-undefined for the rest of the function once
  // this check has passed. Deriving `missing` first and branching on `missing.length` (the prior
  // shape) hides the per-variable comparisons from the type checker, so nothing downstream can
  // ever be proven non-undefined; every later use then needs its own `!== undefined` guard or a
  // `String()` wrapper to satisfy the compiler, and a bug that let one of the three through
  // undefined would compose an "undefined" literal into the declaration and post it at exit 0
  // instead of failing to compile.
  if (
    recommend === undefined ||
    recommend === '' ||
    stalls === undefined ||
    stalls === '' ||
    whyMine === undefined
  ) {
    const missing = [
      recommend === undefined || recommend === '' ? '--recommend' : null,
      stalls === undefined || stalls === '' ? '--stalls' : null,
      whyMine === undefined ? '--why-mine' : null,
    ].filter((flag): flag is string => flag !== null)
    refuseItem(
      `every --type question must declare --recommend, --stalls and --why-mine — missing ${missing.join(', ')}.`,
      'A question that does not say what you would do, or what is waiting on the answer, costs the ' +
        'user a round trip to ask you. Choosing a --why-mine value is itself the claim that this ' +
        'question cleared all three escalation rungs — there is no value meaning "I skipped them".',
      'Add the missing flag(s) and post again'
    )
    return null
  }
  // recommend/stalls are free text interpolated into the declaration blockquote below — a line
  // break in either splits that line, corrupting the contract this function's header comment
  // calls stable and machine-readable. CommonMark line endings are \n, \r, and \r\n; the class
  // covers all three.
  if (/[\r\n]/.test(recommend)) {
    refuseItem(
      '--recommend carries a line break — the declaration line it composes into must stay one line.',
      'The declaration is a stable machine-readable contract: a line break inside it splits the ' +
        'blockquote, and the board no longer parses it as one line.',
      'Remove the line break — keep --recommend to a single line'
    )
    return null
  }
  if (/[\r\n]/.test(stalls)) {
    refuseItem(
      '--stalls carries a line break — the declaration line it composes into must stay one line.',
      'The declaration is a stable machine-readable contract: a line break inside it splits the ' +
        'blockquote, and the board no longer parses it as one line.',
      'Remove the line break — keep --stalls to a single line'
    )
    return null
  }
  if (reproducesDeclarationGrammar(recommend)) {
    refuseItem(
      '--recommend reproduces the declaration line’s own grammar (a " · " delimiter, a ' +
        'Unicode-equivalent form of it, a leading or trailing "·", or a "**Label:**" marker) — it ' +
        'would extend or corrupt the composed line.',
      'The declaration line is a stable machine-readable contract: three bold-labeled fields joined ' +
        'by " · ". A value that reproduces that shape can forge a fourth field or blur where ' +
        '--recommend ends and --stalls begins.',
      'Remove the " · " delimiter (or any Unicode-equivalent form of it), any leading or trailing ' +
        '"·", and any "**Label:**" markers from --recommend'
    )
    return null
  }
  if (reproducesDeclarationGrammar(stalls)) {
    refuseItem(
      '--stalls reproduces the declaration line’s own grammar (a " · " delimiter, a ' +
        'Unicode-equivalent form of it, a leading or trailing "·", or a "**Label:**" marker) — it ' +
        'would extend or corrupt the composed line.',
      'The declaration line is a stable machine-readable contract: three bold-labeled fields joined ' +
        'by " · ". A value that reproduces that shape can forge a fourth field or blur where ' +
        '--stalls ends and --why-mine begins.',
      'Remove the " · " delimiter (or any Unicode-equivalent form of it), any leading or trailing ' +
        '"·", and any "**Label:**" markers from --stalls'
    )
    return null
  }
  const [firstLine = '', ...restLines] = splitLines(prompt)
  const lede = firstLine.trim()
  if (lede === '') {
    refuseItem(
      'the first line of --prompt is empty — a question has no lede.',
      'The lede is the decision in one line, and it is the only part guaranteed to be read. A ' +
        'prompt that opens with a blank line, a heading, or preamble buries it.',
      'Put the decision on the first line, in plain language'
    )
    return null
  }
  if (reproducesDeclarationBlockquote(lede)) {
    refuseItem(
      'the first line of --prompt reproduces the declaration line’s own grammar (a " · " delimiter, ' +
        'or a "**Label:**" marker on a line starting with ">") — it would forge a declaration ' +
        'blockquote ahead of the real one.',
      'The lede and the evidence both compose ahead of the declaration line. A lede that reproduces ' +
        'the declaration’s shape reads as an earlier, unvalidated declaration, and a reader hits ' +
        'the forged one first.',
      'Remove the " · " delimiter from the first line, or the "**Label:**" marker if the line starts with ">"'
    )
    return null
  }
  if ([...lede].length > LEDE_MAX_CHARS) {
    refuseItem(
      `the first line of --prompt is ${String([...lede].length)} characters — the lede cap is ${String(LEDE_MAX_CHARS)}.`,
      'A lede the user has to parse is not a lede. Everything beyond the decision itself belongs ' +
        'in the evidence block beneath it.',
      'Shorten the first line to the decision alone and move the rest below it'
    )
    return null
  }
  if ([...recommend].length > RECOMMEND_MAX_CHARS) {
    refuseItem(
      `--recommend is ${String([...recommend].length)} characters — the cap is ${String(RECOMMEND_MAX_CHARS)}.`,
      'The recommendation is one line: what you would do. Its reasoning belongs in the evidence ' +
        'block, where the user can read it if they want to disagree.',
      'Shorten --recommend to the action and move the reasoning into --prompt'
    )
    return null
  }
  if ([...stalls].length > STALLS_MAX_CHARS) {
    refuseItem(
      `--stalls is ${String([...stalls].length)} characters — the cap is ${String(STALLS_MAX_CHARS)}.`,
      'What is waiting on the answer is one line, or the literal word none. A paragraph here is ' +
        'evidence wearing a declaration’s clothes.',
      'Shorten --stalls to what waits, or pass none'
    )
    return null
  }
  if (defer && stalls !== 'none') {
    refuseItem(
      `--defer requires --stalls none — got --stalls ${JSON.stringify(stalls)}.`,
      'A deferral-gate question asks whether work you found should be done later. If something is ' +
        'stalled on the answer, the work is not deferrable and this is an ordinary blocking question.',
      'Pass --stalls none, or drop --defer and state what stalls'
    )
    return null
  }
  const body = restLines.join('\n').trim()
  if (reproducesDeclarationBlockquote(body)) {
    refuseItem(
      'the evidence in --prompt reproduces the declaration line’s own grammar (a " · " delimiter, ' +
        'or a "**Label:**" marker on a line starting with ">") — it would forge a second ' +
        'declaration blockquote.',
      'The declaration line is the only place the declared facts survive. Evidence that reproduces ' +
        'its shape on a blockquote line reads as a second, unvalidated one, and nothing marks which ' +
        'is authentic. Ordinary prose carrying a bold label is unaffected.',
      'Remove the " · " delimiter from the evidence, or move any "**Label:**" line out of blockquote position'
    )
    return null
  }
  return { lede, body, recommend, stalls, whyMine }
}

// Composes the prompt the board actually stores for a single posted question: the lede, then the
// evidence, then the declaration blockquote — the question is read before the recommendation. The
// blockquote is a stable machine-readable contract, not presentation: the board's `item` table
// stores only the composed `prompt` string, so that line is the only place the declared facts
// survive. Its form is shared with `composeDeferredEntry` through `composeDeclaration`.
const composeSingleQuestion = (parts: QuestionParts): string | null => {
  const composed = [
    parts.lede,
    parts.body,
    composeDeclaration(parts.recommend, parts.stalls, parts.whyMine),
  ]
    .filter((block) => block !== '')
    .join('\n\n')
  if ([...composed].length > COMPOSED_PROMPT_MAX_CHARS) {
    refuseItem(
      `the composed prompt is ${String([...composed].length)} characters — the cap is ${String(COMPOSED_PROMPT_MAX_CHARS)}.`,
      'A question longer than one screen is read by skimming, and a skimmed question gets a ' +
        'guessed answer. Refusing here never deadlocks you: the evidence is still reachable, just ' +
        'not inline.',
      'Move the evidence to a linked doc or a PR comment and link it from --prompt'
    )
    return null
  }
  return composed
}

// The one declaration line every posted question carries, composed here and nowhere else so a
// deferred and an immediate question are indistinguishable to anything that measures it.
const composeDeclaration = (recommend: string, stalls: string, whyMine: WhyMine): string =>
  `> **Recommend:** ${recommend} · **Stalls:** ${stalls} · **Yours because:** ${whyMine}`

const composeQuestionPrompt = (
  prompt: string,
  decl: { recommend?: string; stalls?: string; whyMine?: WhyMine; defer: boolean }
): string | null => {
  const parts = validateQuestionParts(prompt, decl)
  return parts === null ? null : composeSingleQuestion(parts)
}

// The refusal shape approvalIsAllowed already sets in this file: what was wrong, why the rule
// exists, what to do instead, and the citation — the escalation contract unless the caller names
// another.
const refuseItem = (
  wrong: string,
  why: string,
  fix: string,
  cite = ESCALATION_CONTRACT_PATH
): void => {
  process.stderr.write(`dashboard: ${wrong}\n${why}\n${fix} (${cite}).\n`)
  setRequestedExitCode(1)
}

// A note gets the same lede and size caps as a question's prompt and nothing more: it carries no
// declaration line, so there is no declaration grammar for its text to forge.
const validateNotePrompt = (prompt: string): string | null => {
  const [firstLine = ''] = splitLines(prompt)
  const lede = firstLine.trim()

  if (lede === '') {
    refuseItem(
      'the first line of --prompt is empty — a note has no lede.',
      'The first line is what the user reads first. A note that opens with a blank line, a ' +
        'heading, or preamble buries what it is telling them.',
      'Put what the user should know on the first line, in plain language',
      DASHBOARD_PROTOCOL_NOTES_SECTION
    )
    return null
  }

  if ([...lede].length > LEDE_MAX_CHARS) {
    refuseItem(
      `the first line of --prompt is ${String([...lede].length)} characters — the lede cap is ${String(LEDE_MAX_CHARS)}.`,
      'The lede is one line the user can take in at a glance; the detail belongs beneath it.',
      'Shorten the first line and move the rest below it',
      DASHBOARD_PROTOCOL_NOTES_SECTION
    )
    return null
  }

  if ([...prompt].length > COMPOSED_PROMPT_MAX_CHARS) {
    refuseItem(
      `--prompt is ${String([...prompt].length)} characters — the cap is ${String(COMPOSED_PROMPT_MAX_CHARS)}.`,
      'A note longer than one screen gets skimmed, and what it was posted to preserve is lost anyway.',
      'Move the detail to a linked doc or a PR comment and link it from --prompt',
      DASHBOARD_PROTOCOL_NOTES_SECTION
    )
    return null
  }

  return prompt
}

// What a note cannot do, returned beside every note's id (FLOW-427). A go-ahead posted as a note
// never reaches "Needs me" and nothing answers it, and the agent that posted it reads the note as
// the step done. The posting call is the one moment every such mistake shares, whichever step it
// should have come from, so the reminder rides on its result, in the JSON line itself.
const infoNoteReminder = (itemId: string, sessionId: string): string =>
  'Nothing answers a note. If this asks the user to approve, merge, flip, proceed or validate ' +
  `anything, withdraw it (dashboard item withdraw --item ${itemId} --session ${sessionId}) and ` +
  'post it with --type approval.'

// FLOW-211 guard — enforces skills/board/references/dashboard-protocol.md §3.1. Type-aware:
// blocks only on an open QUESTION (`openItemCounts.question`, REV-72), never on another open
// approval — the HOLD path deliberately posts one.
//
// Scoped to ONE node — the one `sessionId` targets. A caller who retargets the post (`--session
// <root>` or a different `--key`) to a sibling node that doesn't carry the open question escapes
// the guard, even if the two nodes represent entangled work from the user's point of view. This is
// in-spec (§3.1 reads "on one node at once") and a conscious choice, not an oversight: the guard
// has no way to know which sibling nodes are entangled without a cross-node relationship the board
// doesn't expose, and blocking on ANY open item anywhere in the tree would refuse legitimate,
// unrelated advancement approvals too. Retargeting to dodge a refusal you know is warranted is a
// misuse of `--session`/`--key`, the same class of misuse §3.1 prohibits for `--approval-kind`.
//
// The dashboard-protocol.md path is spelled out in this file's stderr messages, but
// `check-refs` only scans skills/agents/commands Markdown for stale references — nothing here or
// in the shipped stderr text is lint-protected if that doc ever moves. `item.test.ts` and
// `dashboard.ts`'s own `--approval-kind` help text now carry assertions on this exact string
// (FLOW-230), so a move breaks those two loudly; grep this file, item.test.ts, dashboard.ts, and
// session-id.ts (which carries a bare "dashboard-protocol.md §1" of its own) for
// "dashboard-protocol.md" to find every remaining site a move must update.
// This file now cites escalation-contract.md the same unprotected way (see
// ESCALATION_CONTRACT_PATH above) — that path has its own grep list, in that constant's comment.
//
// Fails OPEN on every uncertain read: unreachable board, unparseable payload, node absent, and
// `openItemCounts` absent — an ai-workflow-app build that predates REV-72 reports no per-type
// breakdown at all, and that absence must read as unknown, not as zero.
//
// `approvalKind` is an enum, not free text — it supplies a missing fact the CLI cannot infer from
// the prompt string, the same shape as `--key`; see
// skills/board/references/dashboard-protocol.md §3.1 for why free text was rejected.
const approvalIsAllowed = (
  sessionId: string,
  approvalKind: 'hold' | 'credential' | 'checkpoint' | undefined
): boolean => {
  if (approvalKind !== undefined) return true
  // A DEFERRED question is an open question the board cannot see: it lives on local state until the
  // flush. §3.1 gates an advancement approval on open questions "deferred or not", so this is checked
  // before the board read. By the time this runs, runItemAdd has already refused every state
  // `stateFileIsCorrupt` covers — present but unparseable, and present with a shape-invalid
  // `deferredQuestions` — so the only way loadState returns null here is a state file that has
  // never been written for this node at all — which correctly admits the approval:
  // deferredQuestionsOf(null) is [], and a node that has never deferred anything has nothing pending.
  const pending = deferredQuestionsOf(loadState(sessionId))
  if (pending.length > 0) {
    process.stderr.write(
      `dashboard: refusing to post an approval — this node has ${String(pending.length)} deferred ` +
        `question(s) the user has not seen yet: ${pending.map((entry) => entry.id).join(', ')}\n` +
        `No advancement approval goes on the board while any question is open, deferred or not ` +
        `(skills/board/references/dashboard-protocol.md §3.1): the approval asserts this is ` +
        `finished while the queue asserts it is still being decided.\n` +
        `In a workflow with a PR, push the branch so the questions point at real code, then ` +
        `\`dashboard item flush-deferred --context "<pr url>"\`. In a workflow with none (JTBD, ` +
        `Architecture), \`--context\` is optional — flush with no \`--context\` instead of waiting ` +
        `on a diff that is never coming. Either way, post this approval once every flushed question is answered ` +
        `and consumed. A queued question the work itself answered is removed with \`dashboard item ` +
        `drop-deferred --id "<id>" --reason "<what answered it>"\`.\n`
    )
    setRequestedExitCode(1)
    return false
  }
  const openQuestions = boardOpenItemCount(sessionId, 'question')
  if (openQuestions === null || openQuestions === 0) return true
  process.stderr.write(
    `dashboard: refusing to post an approval — this node has ${openQuestions} open question(s) ` +
      `the user has not answered.\n` +
      `An approval asking the user to advance the work must not sit alongside a question that ` +
      `could change what they are advancing ` +
      `(skills/board/references/dashboard-protocol.md §3.1): they answer the question, ` +
      `then have to reject this and restate the answer.\n` +
      `Wait for the answer, then post this. Only three kinds of approval are exempt: a HOLD ` +
      `(--approval-kind hold), a credential/auth/environment ask (--approval-kind credential), ` +
      `or a checkpoint (--approval-kind checkpoint). There is no fourth exempt category — if this ` +
      `is none of the three, it is an advancement approval, and the required action is the same ` +
      `as always: wait.\n`
  )
  setRequestedExitCode(1)
  return false
}

// This node's open-item count of one kind, as the BOARD reports it, or null when that cannot be
// determined — including when the backend predates REV-72 and reports no `openItemCounts` at all.
// The board, never the local openItemIds ledger: that ledger is known to drift from the board in
// both directions (FLOW-196), so a guard reading it would both block on items the user already
// answered and wave through ones they have not. Node lookup is `findBoardNodeFor` (board-nodes.ts),
// shared with status.ts's resolveBoardLifecycle.
//
// `tryResolveRawSessionId` (not the throwing `resolveRawSessionId`) so a missing
// CLAUDE_CODE_SESSION_ID fails open like every other uncertain read here, rather than throwing out
// of a guard that must never strand the caller. `{ quiet: true }` — see invoke.ts for why.
const boardOpenItemCount = (sessionId: string, kind: 'question' | 'approval'): number | null => {
  const rawSessionId = tryResolveRawSessionId()
  if (rawSessionId === null) return null
  const node = findBoardNodeFor(rawSessionId, sessionId, { quiet: true })
  return node?.openItemCounts?.[kind] ?? null
}

// drop-deferred: remove a queued question the work itself answered. The reason is the asker's own
// record — it is printed with the result and never reaches the board, since the user reads only the
// questions still open.
export const runItemDropDeferred = (
  id: string | undefined,
  reason: string | undefined,
  opts: { session?: string; key?: string } = {}
): void => {
  // --id and --reason are Stricli-optional and refused here, not declared mandatory: Stricli's own
  // missing-flag path exits 252 with "Expected input for flag --reason", and this verb's contract is
  // exit 1 with a message that says why the reason is required at all.
  if (id === undefined || reason === undefined) {
    const missing = [id === undefined ? '--id' : null, reason === undefined ? '--reason' : null]
      .filter((flag): flag is string => flag !== null)
      .join(', ')
    process.stderr.write(
      `dashboard: drop-deferred requires --id and --reason — missing ${missing}.\n` +
        'The reason is your own record of what answered the question; a drop with no reason is a ' +
        'question removed for no stated cause.\n' +
        'Run `dashboard item list-deferred` for the ids, then pass both flags.\n'
    )
    setRequestedExitCode(1)
    return
  }
  const trimmedReason = reason.trim()
  if (trimmedReason === '') {
    refuseItem(
      '--reason is blank.',
      'A blank reason is a question removed for no stated cause, which is what requiring --reason ' +
        'at all exists to prevent.',
      'Pass the actual reason the question was dropped'
    )
    return
  }
  const sessionId = resolveSessionTargetOrRefuse(opts.session, opts.key)
  if (sessionId === null) return
  // Without this, a corrupt state file's `state === null` falls into the not-found branch below and
  // reports the id as absent with "queued ids: (none)" — a false diagnosis naming an unreadable
  // queue as an empty one, compounded by the branch's own advice to run `list-deferred` (which,
  // guarded the same way, now also refuses rather than corroborating the same false [] answer).
  if (stateFileIsCorrupt(sessionId)) {
    refuseCorruptState(sessionId, 'drop this deferred question')
    return
  }
  const state = loadState(sessionId)
  const queue = deferredQuestionsOf(state)
  const target = queue.find((entry) => entry.id === id)
  if (state === null || target === undefined) {
    process.stderr.write(
      `dashboard: no deferred question with id ${JSON.stringify(id)} on this node — queued ids: ` +
        `${queue.length === 0 ? '(none)' : queue.map((entry) => entry.id).join(', ')}\n` +
        'Ids are addressable only while the entry is queued, and they are per node.\n' +
        'Run `dashboard item list-deferred` to see this node’s queue, and pass --key if the ' +
        'question was deferred on a different one.\n'
    )
    setRequestedExitCode(1)
    return
  }
  saveState(sessionId, {
    ...state,
    deferredQuestions: queue.filter((entry) => entry.id !== id),
  })
  process.stdout.write(JSON.stringify({ dropped: id, reason: trimmedReason }) + '\n')
}

// list-deferred: print this node's queue as JSON. No refusal when the queue is genuinely empty (an
// empty queue prints `[]`, which is the honest answer) — but a PRESENT, unparseable file must refuse
// rather than print the identical `[]`: team-cleanup and pr-lifecycle both drain by repeating
// list-deferred/flush until list-deferred reports `[]`, so an unreadable file that prints the same
// thing as a genuinely empty queue makes the flush that would surface the corruption never run.
// resolveSessionTarget's keyless zero-leaf path falls through to a live board check, so this is not
// always a purely local read — see dashboard-protocol.md. The pre-flush review is done against these
// entries rather than from memory: the step is review, then flush, never a blind flush.
export const runItemListDeferred = (opts: { session?: string; key?: string } = {}): void => {
  const sessionId = resolveSessionTargetOrRefuse(opts.session, opts.key)
  if (sessionId === null) return
  if (stateFileIsCorrupt(sessionId)) {
    refuseCorruptState(sessionId, 'list the deferred queue')
    return
  }
  process.stdout.write(JSON.stringify(deferredQuestionsOf(loadState(sessionId)), null, 2) + '\n')
}

// flush-deferred: post every queued question as its own board item, in queue order, in one call.
// Each entry leaves the queue as its post is confirmed, so a failure part-way leaves exactly the
// unposted suffix queued for a retry.
//
// Each posted item is a --type question, so it lands in the node's own openItemCounts.question and
// correctly blocks a later advancement approval until it is answered and consumed. That is the loop
// this closes: push, flush, answer, then approve.
export const runItemFlushDeferred = (
  opts: { context?: string; session?: string; key?: string } = {}
): void => {
  const context = opts.context?.trim()
  if (context !== undefined) {
    if (context === '') {
      refuseItem(
        '--context is blank — indistinguishable from omitting it entirely.',
        'A blank --context composes identically to no --context at all, since composeDeferredEntry ' +
          'filters empty blocks out before joining them — refusing rather than silently accepting ' +
          'means a mis-expanded shell variable (an unset or empty $VAR) does not go unnoticed.',
        'Pass the actual context, or omit --context entirely'
      )
      return
    }
    // Checked the same way --recommend/--stalls are: no line break, since --context is the last
    // evidence block, composed on one line; a length cap, since --context counts toward
    // COMPOSED_PROMPT_MAX_CHARS the same as everything else composed into it; and a grammar check,
    // since it is interpolated verbatim directly above the declaration.
    if (/[\r\n]/.test(context)) {
      refuseItem(
        '--context carries a line break — it is the last evidence block, composed on one line.',
        'A line break inside it splits that line, corrupting the composed prompt the same way a ' +
          'line break in --recommend corrupts the declaration.',
        'Remove the line break — keep --context to a single line'
      )
      return
    }
    if ([...context].length > CONTEXT_MAX_CHARS) {
      refuseItem(
        `--context is ${String([...context].length)} characters — the cap is ${String(CONTEXT_MAX_CHARS)}.`,
        '--context is one line naming the diff — a pointer, not a paragraph of evidence.',
        'Shorten --context to the PR URL or a short note'
      )
      return
    }
    if (reproducesDeclarationBlockquote(context) || edgeDot(context)) {
      refuseItem(
        '--context reproduces the declaration line’s own grammar (a " · " delimiter, a leading or ' +
          'trailing "·", or a "**Label:**" marker on a line starting with ">") — it sits directly ' +
          'above the declaration and would forge a second one.',
        'The declaration line is a stable machine-readable contract; a value reproducing its shape ' +
          'on the line before it reads as a second, unvalidated declaration.',
        'Pass the PR URL or a plain note — remove the " · " delimiter, any leading or trailing "·", ' +
          'and any blockquoted "**Label:**"'
      )
      return
    }
  }
  const bin = resolveDashboardBin()
  if (bin === null) {
    process.stderr.write(
      'dashboard: ai-workflow-app is not available — cannot flush the deferred queue.\n' +
        'The queue is left untouched. A drain loop that repeats `list-deferred`/`flush-deferred` ' +
        'until the queue is empty would otherwise see the same non-empty queue forever, with no ' +
        'diagnostic explaining why.\n' +
        'Make ai-workflow-app reachable, then flush again.\n'
    )
    setRequestedExitCode(1)
    return
  }
  const sessionId = resolveSessionTargetOrRefuse(opts.session, opts.key)
  if (sessionId === null) return
  if (stateFileIsCorrupt(sessionId)) {
    refuseCorruptState(sessionId, 'flush the deferred queue')
    return
  }
  let snapshot = loadState(sessionId)
  const queue = deferredQuestionsOf(snapshot)
  if (queue.length === 0) {
    process.stdout.write(JSON.stringify({ itemIds: [], flushed: 0 }) + '\n')
    return
  }
  if (!flushIsAllowed(sessionId)) return
  // Every entry was measured against its own flush shape at defer time, so only --context can push
  // one over the cap now — unless it was queued by a build before that guard existed. Checked for
  // the whole queue before anything posts: a flush that posts some entries and then refuses the
  // rest on a cap the caller could have fixed up front is a partial post for no reason.
  const overCap = queue.filter(
    (entry) => [...composeDeferredEntry(entry, context)].length > COMPOSED_PROMPT_MAX_CHARS
  )
  if (overCap.length > 0) {
    const ids = overCap.map((entry) => entry.id).join(', ')
    const contextIsTheCause =
      context !== undefined &&
      overCap.every(
        (entry) => [...composeDeferredEntry(entry, undefined)].length <= COMPOSED_PROMPT_MAX_CHARS
      )
    process.stderr.write(
      contextIsTheCause
        ? `dashboard: --context pushes ${ids} past the ${String(COMPOSED_PROMPT_MAX_CHARS)}-character ` +
            `cap — nothing was posted and the queue is unchanged.\n` +
            'Each of those entries fits on its own; --context is what pushes it over.\n' +
            'Shorten --context, or flush without it and reference the diff another way.\n'
        : `dashboard: ${ids} compose past the ${String(COMPOSED_PROMPT_MAX_CHARS)}-character cap on ` +
            `their own — nothing was posted and the queue is unchanged.\n` +
            'Shorten the question (move its evidence to a link), or drop it with `dashboard item ' +
            'drop-deferred --id "<id>" --reason "<what answered it>"`.\n'
    )
    setRequestedExitCode(1)
    return
  }
  const itemIds: string[] = []
  for (const entry of queue) {
    const out = invokeDashboardBin(bin, [
      'item',
      'add',
      '--session',
      sessionId,
      '--type',
      'question',
      ...referenceArgs(entry.references ?? []),
      '--prompt',
      composeDeferredEntry(entry, context),
    ])
    // invokeDashboardBin has already written the failure to stderr and set exit 1.
    if (out === null) {
      if (entry.references !== undefined && entry.references.length > 0) {
        process.stderr.write(
          `dashboard: the post for ${entry.id} failed; it carries ${referenceArgs(entry.references).join(' ')}. ` +
            'It stays queued, and so does every entry after it.\n' +
            'If the failure is a refused reference, keep the question: read it with `dashboard item ' +
            `list-deferred\`, run \`dashboard item drop-deferred --id "${entry.id}" --reason ` +
            '"re-queued with corrected references"`, then re-queue it with `dashboard item add --defer` ' +
            'and the corrected --answers/--replaces/--related.\n'
        )
      }
      reportPartialFlush(itemIds, queue.length)
      return
    }
    const itemId = usableItemId(out)
    // No usable id back means the post is unconfirmed. The entry stays queued: a re-flush the user
    // sees twice costs a duplicate item, while removing it on an unconfirmed post costs the question
    // outright. The duplicate is the safe direction.
    if (itemId === undefined) {
      process.stderr.write(
        `dashboard: the post for ${entry.id} did not return a usable itemId (a non-blank string) — ` +
          'leaving it queued rather than removing it, since an unconfirmed post is not a confirmed ' +
          'one.\n' +
          'Retry the flush.\n'
      )
      setRequestedExitCode(1)
      reportPartialFlush(itemIds, queue.length)
      return
    }
    itemIds.push(itemId)
    const saved = recordPostedEntry(sessionId, snapshot, entry.id, itemId)
    if (saved === false) {
      reportPartialFlush(itemIds, queue.length, 1)
      return
    }
    snapshot = saved
  }
  process.stdout.write(JSON.stringify({ itemIds, flushed: itemIds.length }) + '\n')
}

// The stdout record of a flush that stopped part-way: what posted, and how many entries are still
// queued for the retry. stderr already carries why it stopped. `unrecorded` is 1 when the last
// itemId in `itemIds` posted but was never removed from the queue (recordPostedEntry found the
// state file corrupt after the post) — it counts toward `remaining`, not `flushed`, since the entry
// was never removed from any queue: the file that would record its removal is unreadable.
const reportPartialFlush = (itemIds: string[], queued: number, unrecorded = 0): void => {
  process.stdout.write(
    JSON.stringify({
      itemIds,
      flushed: itemIds.length - unrecorded,
      remaining: queued - itemIds.length + unrecorded,
    }) + '\n'
  )
}

// Removes one posted entry from the queue and records its item id, re-reading state AFTER the board
// call rather than reusing the pre-invoke snapshot — the same reason runItemAdd re-loads after its
// own invoke: a question deferred while the call was in flight would otherwise be silently
// clobbered. `snapshot` is the fallback only when the file is gone (a concurrent clearState) —
// spread whole, never hand-rolled, so parentId and deferredIdCounter survive (FLOW-136, FLOW-250).
// Returns the saved state on success, so the caller can thread it as the next entry's `snapshot`
// instead of the stale pre-loop one (a multi-entry flush whose state file vanishes mid-loop must not
// fall back to a snapshot that still lists already-posted entries and lacks their itemIds). Returns
// false, having written stderr and set exit 1, when the file turned corrupt during the post: the
// item has already landed, and saving over a corrupt file would destroy what is recorded there.
const recordPostedEntry = (
  sessionId: string,
  snapshot: DashboardSessionState | null,
  entryId: string,
  itemId: string
): DashboardSessionState | false => {
  if (stateFileIsCorrupt(sessionId)) {
    process.stderr.write(
      `dashboard: ${stateFilePath(sessionId)} ${corruptStateDiagnosis(sessionId)} — the flush already ` +
        `posted itemId ${itemId} for ${entryId}, but the local queue was not updated to match, since ` +
        `treating the file as empty would either overwrite what is actually recorded there or report ` +
        `a false success as if it holds nothing.\n` +
        'Inspect and repair or remove the file by hand, then reconcile the queue against the posted ' +
        'item by hand.\n'
    )
    setRequestedExitCode(1)
    return false
  }
  const baseState = loadState(sessionId) ?? snapshot
  const openItemIds = baseState?.openItemIds ?? []
  if (!openItemIds.includes(itemId)) openItemIds.push(itemId)
  const nextState: DashboardSessionState = {
    ...(baseState ?? { registered: true, phase: '', openItemIds: [] }),
    openItemIds,
    deferredQuestions: deferredQuestionsOf(baseState).filter((entry) => entry.id !== entryId),
  }
  saveState(sessionId, nextState)
  return nextState
}

// §3.1 read in the other direction: an advancement approval and an open question must not sit on one
// node, so a flush — which posts a question — must not run while an approval is open.
//
// This refuses on ANY open approval, not only an advancement one. The CLI cannot tell them apart:
// advancement-ness is DECLARED at post time via --approval-kind, and the board reports one
// undifferentiated `approval` bucket with no way to read that declaration back. Inferring it from
// prompt text is what §3.1 already rejected. So the message names both exits instead — withdraw an
// advancement approval per §3.1's withdraw path, or answer and consume a credential/checkpoint ask.
// A flush is never urgent (it happens at a PR boundary), so waiting is always available.
//
// Fails OPEN on every uncertain read, exactly like approvalIsAllowed: unreachable board,
// unparseable payload, node absent, or a backend predating REV-72's openItemCounts. An unknown must
// not strand a queue the user is already waiting on.
const flushIsAllowed = (sessionId: string): boolean => {
  const openApprovals = boardOpenItemCount(sessionId, 'approval')
  if (openApprovals === null || openApprovals === 0) return true
  process.stderr.write(
    `dashboard: refusing to flush — this node has ${String(openApprovals)} open approval(s).\n` +
      `A flush posts a question, and an approval asserting the work is finished must not sit ` +
      `alongside one asserting it is still being decided ` +
      `(skills/board/references/dashboard-protocol.md §3.1).\n` +
      `If it is an advancement approval, withdraw it first (\`dashboard item withdraw --item ` +
      `"<id>"\`) and post a fresh one after the flush is answered. If it is a HOLD, a credential ask ` +
      `or a checkpoint, answer and consume it first — this CLI cannot tell which it is, because ` +
      `--approval-kind is declared at post time and the board does not report it back.\n`
  )
  setRequestedExitCode(1)
  return false
}

// One posted question per queued entry — the shape composeSingleQuestion posts, then --context as
// the evidence closing the question, then the declaration line with the phase the question arose at
// attached beneath it, so the declaration reads last. `**Stalls:** none` is literally true for every
// entry: deferring IS the claim that nothing stalls, which is why DeferredQuestion carries no stalls
// field. The phase line is omitted for an entry whose deferredAtPhase is '' (no state file existed
// yet at defer time) rather than rendered as a dangling "Deferred at ." — there is no fact to report.
//
// This deliberately COMPOSES the declaration grammar, which is exactly what composeQuestionPrompt
// refuses in agent-supplied text. That is why the flush posts through invokeDashboardBin directly and
// never routes back through runItemAdd — its own gate would, correctly, refuse this prompt. Every
// value interpolated here was validated at defer time, and --context is checked by the caller.
const composeDeferredEntry = (entry: DeferredQuestion, context: string | undefined): string => {
  const phaseLine =
    entry.deferredAtPhase === '' ? '' : `\n> *Deferred at ${entry.deferredAtPhase}.*`
  return [
    entry.lede,
    entry.body,
    context ?? '',
    composeDeclaration(entry.recommend, 'none', entry.whyMine) + phaseLine,
  ]
    .filter((block) => block !== '')
    .join('\n\n')
}

// The four out-of-band resolutions (REV-6) + consume (REV-3), each dropping the id from openItemIds.
export const runItemAnswer = (
  item: string,
  response: string,
  session?: string,
  key?: string
): void =>
  resolveItem(['item', 'answer', '--item', item, '--response', response], item, session, key)
export const runItemApprove = (
  item: string,
  note: string | undefined,
  session?: string,
  key?: string
): void =>
  resolveItem(
    note
      ? ['item', 'approve', '--item', item, '--note', note]
      : ['item', 'approve', '--item', item],
    item,
    session,
    key
  )
export const runItemReject = (item: string, note: string, session?: string, key?: string): void =>
  resolveItem(['item', 'reject', '--item', item, '--note', note], item, session, key)

// withdraw: single item, or all pending for the session (cleanup path). Returns whether the
// board-side withdraw invocation succeeded — not whether the local ledger ended up cleared: a
// single-item withdraw only drops that one id, and a missing or corrupt state file leaves the
// ledger untouched while this still returns true. The bare form (no item, no --all) always returns
// false, since it exists only to surface the backend's own refusal — it never inspects the
// invocation's result. runEnd (lifecycle.ts) gates its own `session end` call on this return value.
export const runItemWithdraw = (
  item: string | undefined,
  all: boolean,
  session?: string,
  key?: string
): boolean => {
  if (!dashboardAvailable()) return false
  // No item and no --all: invoke bare so the backend's own exit-1 refusal reaches the caller
  // (FLOW-236). Returning here instead hid a refusal that already existed. No flags at all — that
  // is the branch in the board app's `item withdraw` carrying the message about both forms of
  // the verb. Checked before resolving a session: this form names no session at all — sessionId is
  // unused below — so refusing it for ambiguity or an empty registry buys nothing and costs the
  // refusal this branch exists to surface.
  if (!all && !item) {
    invokeDashboard(['item', 'withdraw'])
    return false
  }
  const sessionId = resolveSessionTargetOrRefuse(session, key)
  if (sessionId === null) return false
  if (all) {
    if (invokeDashboard(['item', 'withdraw', '--session', sessionId, '--all']) === null)
      return false
    clearOpenItems(sessionId)
    return true
  }
  if (!item) return false // unreachable: the bare-form check above already handled !all && !item
  if (invokeDashboard(['item', 'withdraw', '--item', item]) === null) return false
  dropOpenItems(sessionId, [item])
  return true
}

// consume: ack items the human answered in the dashboard (released → consumed).
export const runItemConsume = (
  item: string | undefined,
  all: boolean,
  session?: string,
  key?: string
): void => {
  if (!dashboardAvailable()) return
  const sessionId = resolveSessionTargetOrRefuse(session, key)
  if (sessionId === null) return
  if (all) {
    const out = invokeDashboard(['consume', '--session', sessionId, '--all'])
    if (out === null) return
    reportSkippedUnread(out)
    const consumed = parseConsumedIds(out)
    if (consumed === null) {
      process.stderr.write(
        'dashboard: consume --all did not report which items it consumed (backend predates ' +
          'REV-67) — the local open-item ledger was left unchanged; reconcile it with ' +
          '`dashboard item consume --item "<id>"`\n'
      )
      return
    }
    dropOpenItems(sessionId, consumed)
    return
  }
  // Same as withdraw above: let the backend refuse rather than returning silently. `consume`'s
  // --session flag is required, so it is passed; omitting --item/--all is what triggers the
  // refusal in the board app's `consume`.
  if (!item) {
    invokeDashboard(['consume', '--session', sessionId])
    return
  }
  if (invokeDashboard(['consume', '--session', sessionId, '--item', item]) === null) return
  dropOpenItems(sessionId, [item])
}

// shared helpers below their callers (top-down)
const resolveItem = (args: string[], item: string, session?: string, key?: string): void => {
  if (!dashboardAvailable()) return
  const sessionId = resolveSessionTargetOrRefuse(session, key)
  if (sessionId === null) return
  if (invokeDashboard(args) === null) return
  dropOpenItems(sessionId, [item])
}
// The ids `consume --all` actually acknowledged. The board consumes only RELEASED items, so clearing
// the whole ledger would silently drop items the user has not answered yet, and the Stop hook would
// stop blocking on a live question (FLOW-196). `null` means the backend did not report ids at all
// (pre-REV-67) — distinct from an empty list, and the caller warns rather than guessing. Leaving a
// stale id costs one spurious re-wake; dropping a live one costs a missed question, so the safe
// failure direction is to leave the ledger alone. The `id is string` filter below can only shrink
// the drop list, so a malformed `ids` (e.g. `[1,2]`) degrades toward leaving entries in the ledger —
// safe by construction, not by care.
const parseConsumedIds = (out: string): string[] | null => {
  try {
    const parsed: unknown = JSON.parse(out)
    if (typeof parsed !== 'object' || parsed === null) return null
    const ids = (parsed as { ids?: unknown }).ids
    if (!Array.isArray(ids)) return null
    return ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return null
  }
}
// The board refuses to consume an answer no agent has read (FLOW-236), so `--all` can come back
// having skipped some. Silence there would recreate this ticket's own failure from the other side —
// the agent would believe the batch was fully acknowledged. A backend that predates the field
// reports nothing, which is indistinguishable from "skipped none": both are silent, and both are
// correct to be silent, so no warning is emitted for a missing field.
const reportSkippedUnread = (out: string): void => {
  const skipped = parseSkippedUnread(out)
  if (skipped === null || skipped === 0) return
  process.stderr.write(
    `dashboard: consume --all skipped ${String(skipped)} item(s) whose answers have not been read ` +
      'yet — they are still released; read them with `dashboard answers`, then consume again\n'
  )
}
const parseSkippedUnread = (out: string): number | null => {
  try {
    const parsed: unknown = JSON.parse(out)
    if (typeof parsed !== 'object' || parsed === null) return null
    const skipped = (parsed as { skippedUnread?: unknown }).skippedUnread
    return typeof skipped === 'number' ? skipped : null
  } catch {
    return null
  }
}
const dropOpenItems = (sessionId: string, items: string[]): void => {
  if (items.length === 0) return
  const state = loadState(sessionId)
  if (!state) {
    warnIfLocalLedgerUnreconciled(sessionId)
    return
  }
  saveState(sessionId, {
    ...state,
    openItemIds: state.openItemIds.filter((id) => !items.includes(id)),
  })
}
const clearOpenItems = (sessionId: string): void => {
  const state = loadState(sessionId)
  if (!state) {
    warnIfLocalLedgerUnreconciled(sessionId)
    return
  }
  saveState(sessionId, { ...state, openItemIds: [] })
}
// Both callers above run AFTER the board side of the operation already succeeded — only the LOCAL
// open-item ledger update is at stake here. A merely absent state file (no node ever recorded
// locally) is silently fine, the same "nothing to reconcile" case this file already treats as a
// no-op elsewhere. A present-but-corrupt one — unparseable, or parsing with a shape-invalid
// `deferredQuestions` — is the same false-success shape `runItemConsume`'s own `--all` branch
// already warns about for the analogous pre-REV-67 case: the board is now ahead of the local
// ledger, and nothing here reports that drift on its own. A warning, not a refusal — the failure
// direction is a stale local id, which the comment on the consumed-ids filter above already argues
// is the safe one (one spurious re-wake, not a missed question).
const warnIfLocalLedgerUnreconciled = (sessionId: string): void => {
  if (!stateFileIsCorrupt(sessionId)) return
  process.stderr.write(
    `dashboard: ${stateFilePath(sessionId)} ${corruptStateDiagnosis(sessionId)} — the local ` +
      `open-item ledger was left unchanged; reconcile it by hand once the file is repaired.\n`
  )
}

// Shared by runItemAdd and runItemFlushDeferred: a board reply is JSON we do not control, so
// `itemId` is read as `unknown` and only accepted when it is a non-blank string.
const usableItemId = (out: string): string | undefined => {
  try {
    const parsed = JSON.parse(out) as { itemId?: unknown }
    return typeof parsed.itemId === 'string' && parsed.itemId.trim() !== ''
      ? parsed.itemId
      : undefined
  } catch {
    return undefined
  }
}
