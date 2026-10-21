---
name: team-dispatch
description: Use after design is validated — Architecture for feature work, Systematic Debugging for bug work, or Quick Change for small changes — writes an implementation plan, spins up a team (implementers + senior engineer), executes the plan, gets senior review, and opens a draft PR. Operates on a single ticket. Triggers after the design doc (architecture, bug summary, or change summary) is validated or when the user wants to execute a ticket.
---

# Team Dispatch

## Checklist (mandatory, in order)

1. **Tool intent check** (do not run `check-mcp`): Run `check-tools --require jira,notion`. Parse the JSON on stdout.
   - `check-tools` only inspects environment/configuration intent — it does not probe MCP server availability.
   - `configured` → attempt the tool path directly. If a configured tool attempt fails, STOP and tell the user that tool is configured/intended but is not working. Do NOT fall back.
   - `unconfigured` → use the documented non-integration fallback for that tool.
   - `failed` → STOP and print the reason.

2. **Read the inputs:** read the design doc and, when there is one, the ticket; understand the scope, data structures, API contracts, and sequencing; identify which repos are involved. Transition the Jira ticket to "In Progress" and ensure it's assigned to the current user (when Jira is configured — else per the unconfigured-Jira row in `references/team-dispatch-reference.md` §Error Handling) — if unassigned, resolve the account ID via `atlassianUserInfo` (`account_id`) and set it with `editJiraIssue` (`fields.assignee.accountId`); never hardcode an account ID. **IMPORTANT:** At dispatch, transition only to "In Progress" — the review and Done transitions come later, at the points `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: The Workflow Moves Its Own Tickets names. **The parent epic starts too.** When Jira is configured, if the dispatched ticket has an epic parent, read the epic parent's `fields.status.statusCategory.key` with `getJiraIssue`: when it is `new`, transition the epic to "In Progress" as well — an epic with a story underway is not To Do. When it is `indeterminate` the epic is already started, so leave it; when it is `done`, leave it and do not reopen it (`skills/workflow-guide/references/routing.md`, *Never reopen an epic on your own initiative*). If the parent lookup fails or comes back with no status, leave the epic alone and say so in-session — never guess at it silently. Closing the epic is not this step's: Team Cleanup closes it when its last story closes (`skills/team-cleanup/SKILL.md` step 1).

3. **Dashboard enter** (required when the board is present; silently no-ops only if the `dashboard` CLI is absent): enter the ticket-level session with phase `implementation`, then, when there is a ticket, register the ticket link — a ticket-level node is not fully entered until it carries one, once the ticket exists (`skills/board/references/dashboard-protocol.md` §1). A child node is a second unit of work under a first — pass `--key "<TICKET-ID>"` literally only when **minting** a distinct epic-root node's story-level child for the first time this session (the node doesn't exist yet, so there is nothing to look up); when **re-entering** any existing ticket node — a story node Team Cleanup's auto-continue minted, or the root a front door entered — resolve the key instead of writing it (`skills/board/references/dashboard-protocol.md` §1, *The ticket node key*); otherwise omit `--key` entirely (Team Dispatch **is** the entry point and no front door ran, so this mints the root).

   > Invoke `workflow:board` for the protocol (session enter, items, reconcile).

   ```bash
   # Epic story, arriving directly from Architecture — this enter MINTS the node, so it names it.
   # One link only: the story's own — the epic already carries its own link on its own root node,
   # and a board node holds exactly one live `kind:ticket` link (the association comes from the
   # nesting, not from copying the epic's link onto the story's node):
   dashboard session enter --key "<TICKET-ID>" --phase implementation --title "<story summary>"
   dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" --key "<TICKET-ID>"
   ```

   ```bash
   # Re-entering an existing ticket node — a front door already ran, or Team Cleanup §7.3's
   # auto-continue minted this story's node. No --title: the node already has one. The lookup picks the
   # node — the story's key under an epic (or its -resumed key after a restart), empty when the ticket
   # IS the root (skills/board/references/dashboard-protocol.md §1, The ticket node key):
   TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
   TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
   dashboard session enter --phase implementation ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
   dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" "${TICKET_NODE[@]}"
   ```

   ```bash
   # Standalone ticket, Team Dispatch IS the entry point and no front door ran — mint the root and
   # name it, without --retitle: a bare --title on a keyless enter already refuses to rename an
   # EXISTING titled root (FLOW-180's own guard), so --retitle here would defeat that protection and
   # risk a silent rename if this branch is picked by mistake. --phase dispatch clears the guard
   # hook's BLOCKED_PHASES (implementation is one of the blocked phases); the second enter then
   # advances to the working phase:
   dashboard session enter --phase dispatch --title "<ticket summary>"
   dashboard session enter --phase implementation
   dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" --root
   ```

   Run `link add` on **every** path without checking first: it is idempotent per node on `(kind, url)`, so re-registering a link an earlier skill already added is a no-op, while skipping it loses the link entirely in the case where Team Dispatch *is* the entry point and no front door ran. Pass the same targeting the corresponding `enter` used on that branch's `link add` call too — `--key "<TICKET-ID>"` on the mint branch, the looked-up `"${TICKET_NODE[@]}"` on the re-enter branch, `--root` on the no-front-door branch (its `enter` mints the root itself, so `--root` names it explicitly rather than relying on leaf resolution). Pass the flag rather than relying on what the CLI would do without it — the resolution rules differ by branch and by verb, and the flag is correct on every branch either way. Use the ticket's canonical browse URL (the `webUrl` on the Jira response), never a hardcoded host. Protocol: `skills/board/references/dashboard-protocol.md`. With no ticket, skip `link add`; the lookup still resolves the node.

4. **Seed process improvement notes** (always — no design doc required): invoke the **Process Improvement Notes** skill (`workflow:process-improvement-notes`) in **seed** mode, on every run regardless of which upstream path led here. Pass the design-doc filename when one exists (omit on the quick-change / repeat-consolidation / design-skipped paths). For a single ticket: `docs/plans/process-improvement/YYYY-MM-DD-<TICKET-ID>-notes.md` (with no ticket, `<branch-key>` in place of `<TICKET-ID>`: `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket); for a multi-story epic, one epic-level file every story appends to, keyed by the epic ID, or with no Jira the architecture doc's topic slug.

5. **Set up the workspace:** use the **Git Worktrees** skill (`workflow:git-worktrees`) to create isolated workspaces for each repo involved — it handles fetching, branching from origin/main, `.gitignore` verification, dependency installation, and registering repo-root trust.

6. **Write the implementation plan** to `docs/plans/YYYY-MM-DD-<topic>-3-impl.md` in the parent workspace directory (not inside a worktree) — the source of truth for implementers and the reviewer. Nothing checks it before they read it: it is gitignored and outside every gate, CI run and diff review (`skills/code-review/references/checklist.md` §The artifacts no gate reads), so a claim in it about a file you did not open reaches the implementer as an instruction and the reviewer as a premise, and the only check it gets is whoever opens the file it is about. **Repo drift check:** if the design doc is more than a few days old, check whether the codebase has drifted from its assumptions; if key decisions/data structures/contracts no longer apply, go back to Architecture or Systematic Debugging to re-validate first. Include `**Jira:** [TICKET-ID]` at the top (with no ticket, omit the line). The plan must include: exact file paths to create/modify; code to write (complete and literal — written verbatim by the implementer, not pseudocode); tests to write (TDD where applicable); exact commands to run and expected output.

   > **A per-task acceptance contract.** Every task in the plan carries all four, written out before
   > implementation starts — this is the artifact the lead and the senior *check* instead of deriving
   > their own. **Each field names its capture id — the sha is on the capture, not restated beside
   > it**, once filled in — a record with no capture id can't be checked against the state under review.
   >
   > **Every capture states its scope, because its shelf life is measured in commits and something
   > already checks that.** Step 18's **superseded** trigger is the check: a record produced against
   > an earlier state than the one under review is re-run when
   > `git diff "<record-sha>..<reviewed-sha>" --name-only`, intersected with *the record's stated
   > scope*, is non-empty. That intersection is only computable if the scope was stated — so this
   > field is the producer side of a consumer-side check that already exists, not a new rule. A
   > capture reads the artifact at one sha and stays valid until a commit lands touching a path inside
   > what it read: the sweep's scope, the test's file, the evidence command's inputs. State that
   > scope alongside the sha. **A capture whose scope is not stated cannot be aged at all** — step 18's
   > intersection has nothing to intersect with. **Step 18 is silent on what follows, so this contract
   > stipulates it:** an unscoped capture is treated as superseded by the next commit to anything.
   > That is a rule added here, not a reading of step 18, and it is why stating the scope costs less
   > than omitting it. Program disclosure is cross-cutting the same way: it is a property of a
   > recorded command, not of sweeps, and it reaches a test's red and green commands and an evidence
   > command exactly as it reaches a sweep's.
   >
   > **A capture is written by a program too, not only read by one.** `record`/`show`/`check` are
   > themselves resolved the way a command's own programs are, and a bare `proof-ledger` on PATH can
   > resolve to the installed plugin build rather than the worktree's own source. Disclose the
   > recorder the same way a command's programs are disclosed — `type "proof-ledger"` (or whichever
   > name was invoked), beside the capture. When the ticket's own diff changes the ledger CLI, record
   > through the worktree's own wrapper — the `proof-ledger` script under the worktree's `bin/`
   > directory, invoked by that path rather than by bare name — for the duration of that ticket: a
   > stale recorder does not contain the change under review, so a flag the ticket added reads back
   > as an unknown flag rather than as a check. **The direction it fails in matches the grep shim's:**
   > the stale build does not refuse a capture the branch's own CLI would refuse — the check the
   > branch added simply is not in it — so the record it writes looks exactly like a normal one and is
   > missing only a field whose absence nothing refuses at record time.
   >
   > - **Sweep:** captured as `sweep`. Five required parts, each stated separately:
   >   - the **key** — the behaviour this change belongs to, stated as something an instance *does*
   >     rather than something it is worded like. "A refusal string that names a later call's exit
   >     code" is a behaviour; "the phrase `will exit 25`" is a wording. The key decides whether a
   >     candidate is in the class; the pattern is only how you go looking for one.
   >   - the **pattern** — the exact grep/rg expression, derived from the key. A pattern that
   >     alternates the literal wordings of the instances already known matches nothing outside them
   >     by construction, so a live instance phrased differently is a guaranteed miss, not a risk.
   >     **A recorded command is a reproducer only if it names the program that actually ran it.**
   >     A bare name is resolved by the recorder's own shell, and a shell function or alias can
   >     point it elsewhere — `which` does not reveal one, `type` does — so a command whose name
   >     resolves differently in another shell is not a reproducer whatever hash it carries. Record
   >     `type "<name>"` for each program the command names, beside the capture: nothing else shows
   >     it, since an undisclosed shim leaves both the command string and the output looking exactly
   >     like the bare program's. **The direction it fails in is what makes it dangerous.** A shim
   >     that injects its own exclusions returns a *shorter* found list, and a short found list is
   >     indistinguishable from a class with nothing left in it. Nothing catches it by re-running
   >     either — a second run's shell carries the same shim. Say where a program a reproducer may
   >     not have is required, rather than leaving the name to resolve.
   >   - the **scope** — the package dirs of the files this task changes, derived and never
   >     chosen: for each changed file, the nearest ancestor directory below the repo root holding
   >     a package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`),
   >     else `.`. `proof-ledger record --capture sweep --scope "<dir>[,<dir>]"` requires it and
   >     refuses any other dir and any found path outside it (in grep/rg's line or `-l` listing
   >     output; a custom formatter is not checked) (exit 6). A `--sha-is-label` sweep is
   >     the one exception: it reads live state rather than the tree at `--sha`
   >     (`skills/team-cleanup/SKILL.md` §4. Shut Down Team Members), so it carries no `--scope`,
   >     and `record` refuses one. A sweep is never widened
   >     past it; a site elsewhere in a monorepo is a process note, not a finding.
   >   - the **blind spot** — one sentence naming a concrete way an instance of the key would evade
   >     this pattern, written as the *shape* such an instance would have. "There may be others" is
   >     not a blind spot; it is the absence of one.
   >   - the **found list** — every path the pattern matched, each changed by the task or left alone
   >     with the reason.
   >
   >   **A sweep does not certify that the class is closed, and must not be written or read as if it
   >   did.** It states a behaviour, a way of looking for it, what that way of looking cannot see, and
   >   what it found. A reviewer wanting more coverage asks for a second pattern with a *different*
   >   blind spot — never for a promise the first one was exhaustive. Demanding that promise is what
   >   turns one pass into many: nobody can produce it, so every round re-argues the same unprovable
   >   claim and the finding rate never falls. A sweep with no key stated separately from its pattern,
   >   a pattern not derivable from that key, or no blind spot, is not a sweep. An empty found list is
   >   still a sweep.
   > - **Claims:** captured as `evidence`. Every sentence this task's diff **adds or rewrites** that
   >   asserts something about another rule, mechanism, file, or guarantee — what it says, where it
   >   lives, what it permits, that it is the only one of its kind — gets one row: the sentence, the
   >   authority it names, and what opening that authority actually showed. A sentence asserting
   >   nothing outside itself gets no row.
   >
   >   **Split before verifying.** A label, the ground offered for it, and the consequence drawn from
   >   it are three claims; verifying one buys nothing about the other two. A definite description is
   >   a claim too — "the case the exception excludes" asserts exactly one such case exists, and is
   >   false wherever the exception admits two. This class concentrates in remedies: the sentence
   >   written to fix a finding is the likeliest place for the next one.
   >
   >   **The population is the diff's own added-and-rewritten lines**, which
   >   `git diff "<base>..HEAD" -- "<the task's paths>"` produces — closed, countable, and the same
   >   set for everyone who runs it.
   >
   >   **When the task changes one of this contract's own rules, the task's paths include the
   >   documents that restate that rule, not only the file the rule lives in.** Those documents go on
   >   instructing the old behaviour until they are changed with it, and an agent reading one of them
   >   never sees the amended rule. Add a carve-out here and leave the referrer set alone and the
   >   carve-out is not in force — it is contradicted, by the very files agents read first.
   >   Enumerating the referrers as part of the population is what moves such a contradiction from a
   >   reviewer's judgement to a matched path. **This is not a completeness check and must not be
   >   argued as one.** It does not certify the document free of false claims. It certifies that the
   >   sentences *this diff wrote* had their citations opened. Its blind spot is stated like a
   >   sweep's: a sentence this diff did not touch is outside the population, and so is a claim made
   >   by the arrangement of two sentences rather than by either one alone, and so is **a
   >   requirement the diff removed** — a deletion is neither added nor rewritten, so it earns no
   >   row at all, and a rewritten line earns a row about what it now claims rather than about what
   >   the rewrite dropped, so a replacement that is a strict subset of what it replaced crosses
   >   this field untouched — and so is a claim made in a **capture note or a proofs-file row**.
   >   Neither is diff-borne: a capture note is held by the ledger, and a proofs file lives outside
   >   the repository altogether, so no commit can carry either one. The proofs-file case is not a
   >   gap that a wider diff would close — that text is permanently unreachable by any diff-shaped
   >   check, which is the stronger reason to say so here. A capture note is shipped evidence that
   >   no diff contains, so it is checked the way a claim row is — by opening what it cites — while
   >   sitting outside this field's population. Read this table as covering false claims about other
   >   rules *generally* and you will be wrong: its population is only the lines this diff added or
   >   rewrote.
   > - **Tests:** captured as `red` + `green`. For each new regression test, or one changed to cover
   >   changed production behaviour, the RED baseline command — narrowed to that one test with
   >   `--test-name-pattern` (`node --test --test-name-pattern "<pattern>"`) or the runner's equivalent —
   >   run once against the pre-change production code, where it must go red. `--test-name-pattern` is an
   >   unanchored regex against the test's own title, not a literal-string match: a title is usually not
   >   a valid pattern verbatim, since a literal `( ) . * + ? [ ] { } ^ $ | \` in it changes what the
   >   pattern means and can select zero tests, crash as an invalid regex, or select the wrong one. Pick
   >   a short substring of the title free of those characters, confirm it appears in exactly one test's
   >   title in the file, and use that substring as `<pattern>`. Then verify the narrowing actually
   >   worked, not just that the run passed — `tests 1 / pass 1 / exit 0` looks identical whether the
   >   pattern selected your test or matched nothing at all, since Node's test runner falls back to
   >   reporting the whole file as the one passing "test" on a zero-match pattern. Put
   >   `--test-name-pattern` before the file argument, check the runner's `tests N` against the expected
   >   count, and read its ✔/✖ line, which must name the test's own title, not the bare file path
   >   (`agents/implementer.md` self-check item 1): a misplaced flag runs the whole file, which still
   >   prints the target's title line. `proof-ledger check`'s `--expect-command` separates captures by
   >   the command string alone: two tests invoked by the identical bare command are indistinguishable to
   >   it, and one recorded red/green pair then satisfies both. A test whose red state was never observed
   >   is unproven. A task with no automated test names the gate that covers it instead, and why that
   >   gate is sufficient — not-applicable must be stated, never left blank.
   >
   >   **A verifier is proven by watching it fail.** A test of a checker — a lint rule, a guard hook, a
   >   schema validator — carries at least one **red case**: an input that violates the property, fed
   >   to the checker through its real entry point, with the checker's own output showing it fired. A
   >   checker never shown to fail is not known to check anything. No test reads source and asserts on
   >   its text or shape (`skills/code-review/references/review-rules.md` §Tests).
   >   No test's subject is another test, a fixture or stub, or the test runner or count, and no
   >   control is committed to prove another test non-vacuous (same section).
   >
   >   **A fixture stands in for shipped code only along the dimensions the defect lives in.** Name
   >   those dimensions before building the fixture, and state per dimension that the fixture has it.
   >   A fixture simplified along a dimension the defect depends on cannot reproduce the defect, and a
   >   green test over it says nothing. Dimensions the defect does not depend on may be simplified
   >   freely — that is what a fixture is for.
   > - **Evidence:** captured as `evidence`. At plan time, the field names the command that will
   >   produce it; at report time, it carries that command's output — a real run, not a local-green
   >   claim. For visual work, a frame from the real booted app; for config/transport/assistant work, a
   >   real run against the real artifact. A measured figure is evidence only if a named command
   >   regenerates it; a figure no command reproduces is removed, not annotated with a sample.
   >
   >   **Stated rather than papered over: nothing catches a swapped
   >   gate command.** A `gate-ledger` run stores no command at all, so the record carries no
   >   statement of what was executed for anything to be compared against. The declaration is the
   >   only place the intended command exists, and `gate-ledger check` prints it per gate, but no
   >   step in this workflow reads the two together. Whether the declared script is what actually
   >   ran is **unverified**. Say that where it matters, rather than describing a comparison nobody
   >   performs.
   >
   > These four answer three recurring review-finding categories — a class named but not swept, tests
   > whose red state was never observed, and a sentence asserting something false
   > about another rule — from the plan, before implementation starts, rather than from a review round
   > afterwards.

   The plan must also include: commit message format (`<type>: [<TICKET-ID>] <description>`; with no ticket, `<type>: <description>`) and the commit-body rule (`agents/implementer.md` §Commit Format); task breakdown with sequencing. The plan, like every commit it specifies, names no person (`skills/workflow-guide/references/no-people-names.md`). Completeness checks and team-size guidance: `references/team-dispatch-reference.md` §Implementation Plan Completeness Checks / §Team Composition.

7. **Sync the task list to Jira** using the **syncing-plans-to-jira** skill (`workflow:syncing-plans-to-jira`) — this must happen before spinning up the team, when Jira is configured; with no Jira, skip it. The team lead syncs each checkbox as implementers report task completion (step 16), not the implementers themselves.

8. **Declare the ticket's gates.** Before spinning up the team, determine this repo's gates — one `{name, command, owner}` triple per required check (typecheck, lint, the test suite, any hook suite; carry forward whatever the repo's own tooling already enumerates), write them to a scratch JSON file outside any repo, and run `gate-ledger declare --ticket "<TICKET-ID>" --file "<path>"`. This is the one point in the sequence a ticket's gates actually get declared — step 12's implementers and PR Lifecycle's coverage check both depend on it having already run before any task is dispatched, and every reference elsewhere to "the team lead's kickoff declare" means this step.

9. **Spin up the team, verifying visibility before trusting it:**

   **Spawning the team is a process step, not a user decision.** Do not ask the user for permission to spin up the team, and do not offer a solo / "skip the team" / "I'll just implement it directly" alternative — the team (implementer(s) + senior engineer) is *how* Team Dispatch executes, not one option among several. The process already self-abbreviates for small work (a single implementer is still a team, never a solo bypass). Do not spawn any teammate until every sub-step below has passed.

   1. Register repo-root trust for every repo a teammate will work in, from the launch dir (not
      prefixed with `cd`): `workspace-trust ensure --repo "<repo-root>"`. A teammate is a fresh
      `claude` process whose cwd is the worktree path passed at spawn time — or the team lead's own
      cwd when none is passed; an unregistered root stops it on the trust dialog in its pane, which
      reads as a hung teammate rather than an error. Exit 0 means trusted — continue. Exit 1 means
      refused — read the command's own `reason` (stderr and JSON) for why and what to do (a `cd` fix,
      or a genuine scope question to post to the board and ask); it is not always the same cause.
      Exit 2 means failed (the global config couldn't be read or the write couldn't be verified) —
      that's a real problem to report, not a scope question, so surface it rather than retrying
      blindly. **This step passes when the command exits 0, or when it is not installed. Any other
      outcome stops progress — do not spawn any teammate.** **Known limits, accepted rather
      than fixed — two distinct losses:** the command's own key can still be lost if a write lands
      after it has already exited and reported `trusted` — self-correcting on the next run, since
      nothing running at that point can cover it; separately, a write landing inside the command's
      own read-then-write window used to be silently overwritten by its stale snapshot, undetectable
      by its verification, which only confirms its own key survived, never anyone else's data — the
      command now detects this before writing and retries onto fresh data, which narrows this window
      to the small gap right before the write, not closes it. Since the teammate is spawned right
      after (sub-step 2), a write in either gap reproduces the original symptom this sub-step exists
      to prevent: a hung teammate stuck on the trust dialog.
   2. Spawn the first teammate.
   3. Verify it got its own pane: read `~/.claude/teams/<current-session-id>/config.json` and confirm the spawned teammate's row (`agentType: workflow:implementer` / `workflow:senior-engineer`) has `"backendType"` `"iterm2"` or `"tmux"`, NOT `"in-process"` (ignore the `team-lead` row — always `in-process` by design, not a failure).
   4. **Pane present →** spawn the rest of the team (implementer(s) per plan complexity using the `workflow:implementer` agent definition; the senior engineer using the `workflow:senior-engineer` agent definition — it does not implement, only reviews, and parallelizes its own review via sub-agents for large diffs) and continue.
   5. **Pane absent (in-process) → STOP.** Tell the user the team can't be made visible here and to re-run from a fresh top-level `claude` session (a brand-new terminal, not resumed or nested). Never silently run an invisible in-process team.

10. **Track tasks via the Jira checklist and the board.** The implementation plan's task breakdown became the Jira checklist in step 7; assign each implementer their task(s) by `SendMessage`, naming the plan section and any dependencies directly since there is no tool-tracked dependency graph. The senior engineer waits for all implementation tasks to complete.

11. **Pass to all team members:** the commit message format and the short-body rule, the branch name, the implementation plan file path, and the process improvement notes file path (step 4, "Seed process improvement notes") — every roster entry an implementer writes for an agent or monitor it spawns (`skills/team-cleanup/SKILL.md` §4. Shut Down Team Members) goes there — and the reminder that their first action is `workflow-state record-entry --phase implementation --key "<TICKET-ID>"` (teammate sessions have their own session ids and the edit gate checks per-session state). A teammate runs tests as `test-lock -- pnpm test`, in the background; its heartbeats reach the board node of the lead session that spawned it, because `dashboard session heartbeat` reads that lead's session id from the teammate's own process. **When spawning any teammate that reads the review standards — the senior engineer and every implementer alike — also pass the absolute path to the user's review-standards file: `<launch-dir>/.claude/review-standards.md` — where `<launch-dir>` is the directory Claude was launched in — for a multi-repo workspace the parent that spans the repos, not any single repo's git root (resolve your original top-level cwd, NOT a worktree and NOT `git rev-parse --show-toplevel`). The file is untracked, so it is absent from worktrees. If a per-repo `<repo-root>/.claude/review-standards.md` also exists, pass that too — it is read additively on top of the launch-dir file. Every rule in either file is a blocking checklist item for whichever agent reads it. Three states, not two, for each path: no path was passed — the agent says so in its report; a path was passed and the file exists but is empty — a no-op, nothing to enforce yet; a path was passed and the file is missing or unreadable — the agent says so exactly as for no path passed, never treats it as a no-op.** **Maintaining** that file belongs to the memory phase, not to this step: Memory Review (`workflow:memory-review`) routes the user's review standards to **exactly one file — `<launch-dir>/.claude/review-standards.md`** at every story close, and **creates it when it is absent** — which is recording, not auto-seeding (see that skill's §The Second Store — Review Standards). If the user states a standard mid-story, route it there immediately rather than waiting for cleanup — same file, and follow that section's numbered write procedure (sharpen the existing rule it belongs under first; add a new entry only when stating why no existing rule covers it), including creating the file with its header when it does not yet exist, which is the usual case for the first standard — and **never create a per-repo `<repo-root>/.claude/review-standards.md`** (that would scatter conflicting review files across sub-repos). The immediate mid-story write above applies to a standard stated outright; an inferred one waits for the memory phase, where the antecedent test is specified.

12. **Implementers commit but never push, and record every gate they run.** Before reporting a task complete, the implementer runs every declared gate with `owner: implementer` — bare, never through a pipe, since `$?` immediately after a pipe reports only the last stage's exit status and an earlier stage can fail silently while `rc` still reads clean — redirecting its output to `<file>` and capturing `rc=$?` on the next line, and records each one at the SHA it committed — unless that commit left the tree unchanged, where `gate-ledger check` already reports the earlier runs through `reusedFrom` and a new record needs a licence (below) when a run exists at that SHA or at one whose recorded tree is identical, or, when `record` cannot resolve the SHA's tree, at any SHA: `gate-ledger record --ticket "<TICKET-ID>" --gate "<name>" --sha $(git rev-parse HEAD) --exit "$rc" --role implementer --output-file "<file>"`. `--sha` takes a full 40-character sha only. A gate that fails is fixed before reporting — a failing record is not a substitute for a passing gate. **Run the gates in one order, and stop at the first one that fails.** Each gate is its own command, never chained with the others. Run every gate except the test suite cheapest first, then the test suite last, whatever it costs next to the others. A failure means fix, commit, and start again from the first gate at the new SHA, so a failure costs only the gates in front of it. The team lead pushes only after senior review; the pre-push gate is `gate-ledger check` (PR Lifecycle skill), not a second run of the commands. A rebase mid-round leaves the branch diverged from its remote — the team lead pushes it per `skills/pr-lifecycle/SKILL.md` §Force-Pushing the Team's Own Branch — force-pushing only when that section's checks say so — which is an ordinary step there and a board question only when that section's check 1 both exits `0` and finds a non-empty `<file>`. A ticket with nothing declared has no declared gates, and **`gate-ledger check` exits 8 rather than reporting green**. Exit 8's JSON names which of four causes applies — a cause is a reason for the exit, not the same unit as an `error` string, and there are only three of those strings: `error: "no gates declared for this ticket"` means nothing was declared at kickoff — escalate to the team lead to run the kickoff declare (step 8) rather than declaring it yourself, the same remedy PR Lifecycle's own pre-push check uses; `error: "--manifest <path> does not exist"` means a `--manifest` override was given and that path is wrong — the ticket's own kickoff declare, if any, was never consulted and is untouched, so fix the flag rather than escalating for a re-declare; `error: "<path> does not declare a usable \"gates\" array"` names whichever manifest actually resolved (the ticket's own, or the override) and by itself covers two of the four causes: a `detail` field alongside means that manifest is malformed, its absence means it parsed but the declared `gates` array is empty — both are repaired and re-declared, never silently worked around. **A manifest that exists and cannot be read is a different exit, 26, never 8** — the two prescribe opposite responses, declare versus do NOT declare and repair the file instead, so do not treat 26 as an exit-8 cause at all or route it to the kickoff declare.

13. **A gate runs once per SHA, and one role owns it.** Build, lint, typecheck, and the test suite are properties of a commit, not of a role's confidence. The declared list lives in exactly one place — the ticket's own entry in the workflow's store, written by `gate-ledger declare` — and nothing else enumerates it. **A composite command is not a gate**: `gate-ledger record` refuses a name the manifest does not declare, so running a wrapper script never discharges the rows naming its conjuncts.

    | Gate | Owning role | Run when |
    | --- | --- | --- |
    | each declared gate, per its own `owner` field | **implementer** for `owner: implementer` rows (`runRecord` exits 6 on a non-owning role without a licence) | at implementation time, at the SHA it committed |
    | each declared gate, per its own `owner` field | **team lead** for `owner: team-lead` rows | reactively: when the pre-push coverage check (PR Lifecycle step 2) reports it `missing`, then re-checked at the SHA being pushed |
    | the pre-push coverage check (`gate-ledger check`) | **team lead** | once, at the SHA being pushed |
    | the review checklist | **senior engineer** | once per review round, at the pinned SHA |

    **Re-running a gate already recorded at that SHA, at one whose recorded tree is identical, or — when `record` cannot resolve the SHA's tree — at any SHA, or recording one your role does not own, requires a licence — a closed list of three, and nothing else:** `inconsistent` (the recorded run is incomplete, or its output does not support what it claims), `contradicted` (something else, in the diff or in the tree, contradicts it), `superseded` (the record was produced against an earlier state, and commits between the two touch its stated scope). `gate-ledger record` refuses without `--condition` and `--reason` (exit 6). These are step 18's three triggers, applied to a command whose output depends only on the tree rather than to a claim a teammate derived.

    **A changed tree invalidates every record against the old one.** That is not a caveat on the rule — it is why the rule is safe: `gate-ledger check` carries a record forward only to a SHA naming the byte-identical tree (a squash, or a rebase onto an unmoved `main`) and only when that SHA has no run of its own — a SHA's own runs decide its state — where the gate would run on the same bytes, so "once per SHA" never means "once per branch."

    **The bar does not move.** Every gate that blocks today still blocks. What changes is who runs it and how often — never whether it must pass. **A declared gate with no record at the SHA, or at a SHA naming its tree, is an unrun gate, and `gate-ledger check` reports it `missing` and exits 3.** Detecting that absence requires walking the declared list; nothing that reads only the records produced can do it.

14. **CI environment readiness before the first push** — the implementer surfaces Node-version, native-binding, env-var/secret, and codegen gaps the plan didn't cover so they're resolved before handoff, preventing the common 3-4-CI-failures-on-first-push pattern. Detail: `references/team-dispatch-reference.md` §Execute — Detail.

15. **Batch fixes during rapid review cycles.** When multiple small issues are found in quick succession, the implementer batches the fixes into a single commit; the team lead pushes once, after senior re-review — each push triggers a ~30-50 minute CI run, so batching avoids queueing multiple runs behind each other.

16. **Sync the Jira checkbox per completed task.** Exact procedure (read, update, write back, verify — Jira MCP calls sequential, never batched): `references/team-dispatch-reference.md` §Execute — Detail. Skipped with no Jira.

17. **The team lead NEVER implements code directly.** The team lead coordinates, unblocks, and dispatches — never writes code, makes commits, or pushes to branches. If an implementer is stuck, the team lead provides guidance via SendMessage, not by writing the fix themselves.

18. **The team lead checks a teammate's proof rather than re-deriving it.** When an implementer or the senior has recorded a command, its output, and the state it ran against, read that record — do not re-run the command to confirm what it already shows. An **incomplete** record — a claim with no command, or a command with no output — is not yours to complete: send it back to whoever owns it, the same as any other missing requirement. Re-run only on one of three triggers, and name every trigger that fired: **inconsistent** (the output doesn't support the claim, or names a different state than the one under review); **contradicted** (by anything you can see, in the diff or in the tree — not only by something else in the diff); or **superseded** (the record was produced against an earlier state than the one under review, and commits between the two touch the record's stated scope — check with `git diff "<record-sha>..<reviewed-sha>" --name-only` intersected with that scope; non-empty means re-run). **This covers a teammate's own recorded proof only — the axis is who generated the fact, not who wrote it down.** A teammate who re-runs a gate or command themselves and records it has produced a genuine proof, covered by this rule. A teammate who merely quotes or pastes a third party's output — a bot finding, CI's own report, an "it does X at runtime" assertion — is transcribing someone else's fact, not recording their own, and that transcription is still reproduced before anyone acts on or dismisses it, per `skills/code-review/references/review-rules.md`'s **Verify Against Reality** section. This rule is the single canonical statement of single derivation; every other site that applies it — to review and to the lead's own verification — cites this step rather than restating it. Measured via `claude-usage --per-ticket --all` (N=162 tickets, 520 sessions — the full local usage history as of 2026-08-24), the lead and senior together account for 37% of per-ticket token spend (lead 30%, senior 7%) while writing no code. *What* that spend buys is not something that command measures, and is not claimed here as a measurement: the design premise is that a large share of it is commands re-run and diffs re-read that a teammate had already run and recorded — the redundant derivation this rule removes. **The lead's pre-push gate is not covered by this, and is not a re-run of the implementer's** — it is `gate-ledger check` at the SHA being pushed (step 13), which reads the records rather than reproducing them. When the tree has moved past what the implementer recorded, the check reports the gates `missing` and they genuinely run again; when it has not (the same SHA, or a new SHA naming the identical tree), the records stand.

19. **Process improvement check-ins:** after an implementer completes a significant task (or group of tasks), invoke the **Process Improvement Notes** skill (`workflow:process-improvement-notes`) in **check-in** mode.

20. **Senior engineer review, when all implementation tasks are complete:** **Dashboard** (required when the board is present; no-ops only if the CLI is absent) — at the start of every review round, once its senior's spawn is recorded, re-enter the same node as step 3 with phase `review-round-<n>`, where `<n>` is the round that spawn was recorded under, so the board shows which round is running: `TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1` then `dashboard session enter --phase "review-round-<n>" ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}`, both in one shell invocation. Resolve the key fresh each round, the same way step 3 did — do **not** reuse step 3's `TICKET_NODE_KEY` value: it is long out of shell scope by the time review starts, and a restart between step 3 and here would have moved the node to `<TICKET-ID>-resumed` anyway (`skills/board/references/dashboard-protocol.md` §1, *The ticket node key*). PR Lifecycle's re-review rounds reuse this step's respawn procedure but not this re-enter. Senior review is an automated gate, not a user decision, so do **not** post a `--type approval` item for it. **Driving the review to convergence is your job**, not the user's: never take review length to the user, and never relay a length-based escalation on the senior's behalf. **The team lead MUST SendMessage the senior engineer** to begin review — do not rely on polling. **Do not freeze the branch — pin the review instead.** Before picking the pin, confirm the implementer's last reported commit is an ancestor of it — `git merge-base --is-ancestor "<reported-sha>" "<pin>"` — and choose a pin at or after that commit; a pin that predates the implementer's own report sends the senior to review work the implementer never claimed to have finished. Tell the senior the SHA to review and have it read that commit's contents directly (`git show "<sha>:<path>"`) rather than the working tree, and report back which SHA its findings are against. The implementer keeps committing throughout; a freeze buys the reviewer a stable target at the cost of idling the one role that is producing work, and pinning buys the same stability for nothing. **The pin has two halves — git-tracked and not.** A diff is git-tracked and pins by SHA as above. A PR body, a gitignored plan or process-notes file, or anything else gitignored or living outside the repo has no SHA to pin to; the lead supplies its path together with the expected sha256 and byte count, and the senior verifies both before reading it and reports back which hash its findings are against, the same way it reports the SHA. A mismatch is not a finding to work around — the artifact moved mid-round, so the senior stops and asks the lead for a fresh pin rather than reviewing content that changed under it. **Obligations come with it.** First, when findings arrive, check whether anything landed after the reviewed SHA that touches the same files — `git diff "<reviewed-sha>..HEAD" --name-only` — and send a finding against superseded text back to the senior rather than on to the implementer; a stale finding costs a full round to discover downstream. A finding can be stale two ways: its text moved, or its **scope died** — a task reverted, work dropped from the branch. The diff above catches the first. For the second, record the disposition as a **predicate that re-runs**, never as a list of finding IDs — "dead because `git diff origin/main -- "<path>"` is empty" answers correctly from a cold context, where a list of IDs is state you have to still be holding when the finding comes back, and is the first thing a session summary drops. Second, **do not dispatch new instructions into a round that is already in flight.** Wait for the implementer's report, or expect your message and its commits to cross — which produces exactly the rework the freeze was there to prevent, in the phase the freeze never covered. Third, **the pin does not survive to the push.** Senior approval covers the SHA it reviewed, and the implementer keeps committing after it lands — before pushing, `git diff "<approved-sha>..HEAD"` must be empty, or the delta beyond the approved SHA goes back for re-review rather than shipping unreviewed. The same holds for a hash-pinned artifact, and it needs its own predicate rather than recollection: before posting, re-hash the artifact and compare to the sha256 the senior approved — the PR body most of all, which keeps changing right up to the moment it is posted. A mismatch means the content is unreviewed and goes back for re-review, exactly as a non-empty `git diff "<approved-sha>..HEAD"` does. Every push is the exception in form, not in substance: PR Lifecycle step 2 squashes the unpushed commits and rebases onto `origin/main` before each one, which moves HEAD off the approved SHA by construction, so that step's equivalence check stands in for the empty-diff check there — equal means the approved change, unequal means a delta round. Fourth, **every senior the round spawned is shut down and recorded before the round is closed, and the round is closed on every round end — the approved and terminal one included.** A round with a replacement senior owes more than one teardown: record each outstanding agent id's own shutdown with its own `review-ledger senior shutdown --ticket "<TICKET-ID>" --round "<n>" --agent-id "<id>"` call before closing, then close the round:

    - **Every round end, whether another round follows or the round is approved or otherwise terminal** → `review-ledger next-round --ticket "<TICKET-ID>" --reviewed-sha "<the SHA that round's senior reviewed>" --stance "<adversarial|cleanup>"`. It closes the round *and* advances the counter, in one call. There is no separate terminal verb: `review-ledger round-close` is a deprecated alias for this same command and behaves identically, so a terminal round closes and advances too — the counter simply moves to a round nobody opens.

    Run the close once per round. The two names are one command, so running the second after the first does not close anything again: the counter has already advanced, and the round the second call would stamp is the fresh one, so it refuses in either order. Before any of that: `closeRound` opens with `readLedger(ticket)`, and a `StoreUnreadableError` there reaches stdout as JSON `{error, code}` through review-ledger's `runGuarded` — exit 26 itself is the distinguishing signal, since no refusal below uses it — read the path and errno from that JSON before re-running the close. Past that, which code depends on what that fresh round carries: **exit 20** while it holds no senior, no finding and no review start, which is the state a re-run typed straight after the close finds it in; **exit 21** once that round carries any mark — a senior recorded for it, a finding raised in it, or a review start — because the sha the second call passes is then still the one the closed round already stamped. **Either command name refuses with exit 20** on a round carrying no senior, no finding raised in it and no review start — an instruction dispatched in the round is not a review mark, because it means you typed, not that anyone reviewed. When an exit 20 is wrong and the round really was reviewed, `review-ledger senior shutdown --ticket "<TICKET-ID>" --round N --agent-id X` clears it and, once every outstanding senior on the round has its own shutdown recorded, the exit-17 refusal too — one call per outstanding agent id, not one call per round; `senior spawned` clears exit 20 as well, and leaves that senior owing a teardown, but the close is then subject to the remaining guards in order, so which refusal the retry meets depends on the sha it passes, the review its senior has or hasn't recorded, and the stance it computes. On a ledger armed by a `review start`, a round refused with exit 20 also meets exit 27 on retry, which the `--senior-condition`/`--senior-reason` pair licenses. **Either command refuses with exit 27** on a ledger where any round has a `review start`, when the round being closed has no `review complete` from its senior. Wait for it, because until it lands the round's findings may be a partial set. When the senior is genuinely gone first, the `--senior-condition` with `--senior-reason` pair that licenses exit 17 licenses this too, and is recorded on the round's close. **Either command also refuses with exit 21** when it would stamp the round with a sha some earlier round already recorded, once that round carries a mark — the sha check ignores the marks, but exit 20 refuses an unmarked round before it runs. One cause is the stray re-run of a close still in your scrollback, after a prior close advanced past the round it names; `--sha-reuse-reason` licenses the other, a re-review of a sha that did not move because the previous round's findings were all ruled invalid. The refusal cannot tell them apart, so the licence is a flag you pass rather than something it infers. **Exit 19 is a refusal with a remedy of its own:** the round is already closed and the counter never moved off it, which is a ledger wedged by a close made before every close advanced — `review-ledger round-advance --ticket "<TICKET-ID>" --reason "<why the counter is moving without a close>"` appends the one missing advance and repairs nothing else. None of these guards catches a genuinely reviewed round closed at a new but *wrong* sha: on a ledger whose senior recorded its review, `reviews["<n>"].sha` in `review-ledger show` is the sha to compare against — but nothing compares it automatically, so it is a data error rather than a wedge, and `review-ledger show` read against the commits the round actually reviewed is what finds it. Both close flags are required — together they stamp the round being *closed*, which is what the next round's delta tiers and re-arming predicate (`skills/code-review/references/checklist.md` §Review Stance) measure against; an optional flag would let a round close with nothing recorded and no way to back-fill it. `--stance` is `adversarial` when that round re-examined the whole surface and `cleanup` when it was scoped to a fix-up pass over prior findings. **Either command refuses with exit 17** while any senior on that round has a recorded spawn and no recorded shutdown, naming every agent id it is still waiting on — a lead who simply forgot has no licence, and that refusal is the only thing standing between a forgotten teardown and a senior that stays running unnoticed. When a senior is genuinely gone — it terminated before the handshake reached it, or the shutdown request came back unreachable — `--senior-condition` with `--senior-reason` closes over every senior on the round still outstanding, in one call, sharing one condition and one reason, and records it on the ledger as each one's shutdown. Those flags are for a senior that is actually gone, never a way past a guard that is merely inconvenient. **Either command refuses with exit 6** when no `--reason` licenses the declared stance, and it arrives in two shapes that must be read apart. Where a computed stance exists and contradicts the declaration, the refusal carries both, and the question is which of the two is wrong. Where `computeStance` instead hit a failure that `STANCE_FAILURE_REFUSES_DECLARATION` classifies as refusing, there is no computed stance at all and the refusal carries none — **the absent computed value is itself the signal**, not a contradiction to weigh, and what needs fixing is the failure the error names rather than your declaration. That `Record` is the source of truth for which failures refuse; this step does not re-enumerate it. **Exit 9 is the only refusal here that is not about the round's contents:** another caller already holds the round's advance claim, so this close appends nothing rather than two callers both stamping the round and both advancing past it. Normally it is self-clearing — the winning caller completed its appends, the round genuinely advanced, and re-reading the ledger shows the new round to act on. **The one case that never clears itself** is a winning caller killed between claiming and appending: nothing releases the claim, the round never advances, and every retry re-reads the same stuck round and exits 9 again indefinitely. That one is not fixed by re-reading blindly: read the pid the `round-<N>.advance-claim` file (under the ticket's store dir) holds, confirm that process is no longer running, and confirm `review-ledger show` still has the round un-advanced — only then delete that file and either command can proceed. If the round did advance, the claim is `claimRoundAdvance`'s permanent record: leave it, and re-read the ledger to act on the new round instead. The senior engineer follows the **Code Review skill** (`workflow:code-review`) — reading artifacts, detecting work type, running the checklist, reporting issues, the re-review loop — and parallelizes via its own sub-agents for large diffs. **If approved:** the senior notifies the team lead via SendMessage; append review-friction observations to the process improvement notes; and apply **real-artifact acceptance before approval when applicable** — for visual/UX work the acceptance artifact is a frame from the real booted app, looked at by an `artifact-viewer` subagent rather than by the orchestrator (`skills/workflow-guide/references/routing.md` §Artifact Delegation), not a green CI run; for assistant/config/transport/codegen work the gate is an empirical run against the real running artifact, with a named owner for any check deferred to post-deploy. Local-green is never the acceptance gate for these work types — if the story has no visual/transport surface, state that explicitly rather than silently skipping the gate.

    > **Fifth, apply the round's record notes — they are yours, not the implementer's.**
    > `review-ledger show --ticket "<TICKET-ID>"` lists open notes under `notes`. A `pr-body` or
    > `jira-description` note you fix directly in the PR body or the Jira description; a
    > `commit-message` note the implementer applies when it writes the next squash message (PR
    > Lifecycle step 2) — a note about a commit already pushed is moot, since a pushed commit's
    > message is never rewritten. Then `review-ledger note done --ticket "<TICKET-ID>"
    > --id "<id>"`. A note never fails a round, never gates a push, and is never re-verified by a
    > later senior — the next round's senior reads the open notes and does not re-read a record one
    > names.

    > **Spawn a fresh senior for each review round, and shut it down when the round ends.** A senior's
    > context climbs across rounds and then compacts, and a compacted round carries nothing round N
    > actually needs — round N's inputs are the diff and the ledger, both on disk, not the senior's own
    > memory of earlier rounds. Per round:
    >
    > 1. Spawn a new `workflow:senior-engineer`. Pass it the pinned SHA, the review-standards path(s) —
    >    the same set step 11 defines: the launch-dir file, plus the per-repo
    >    `<repo-root>/.claude/review-standards.md` where one exists — the plan path, the ticket id, and
    >    the round number it is being spawned for. The ticket id is what
    >    it reads the ledger with; the round number is passed alongside it rather than left for the
    >    senior to derive from the ledger, because the round number is exactly what tells it apart from
    >    a corrupted or wrong-ticket ledger in the one case where the ledger itself is unreadable — see
    >    `skills/code-review/SKILL.md` step 1's exit-8 handling.
    > 2. **Record the spawn:** `review-ledger senior spawned --ticket "<TICKET-ID>" --round "<n>"
    >    --agent-id "<the id the spawn returned>"`. It goes after the spawn rather than before it
    >    because the agent id does not exist until the spawn returns. This record is the one the
    >    round-end guard reads: a senior spawned without it is a senior `review-ledger next-round`
    >    has nothing to account for, and the omission that guard exists to catch goes back to
    >    changing no state anything can read. If the round's senior dies mid-round and you spawn a
    >    replacement to finish it, record that spawn the same way, under the same round — it gets its
    >    own entry, and its own teardown once it shuts down; the round-end guard then names both
    >    agent ids until both are accounted for. Only in a round this step itself opened — a
    >    re-review run from PR Lifecycle or PR Feedback skips this — re-enter the board with phase
    >    `review-round-<n>` now, per this step's **Dashboard** sentence.
    > 3. `SendMessage` it to begin review. Dispatch fixes from the round's findings only once
    >    `review-ledger show` reports that round's `reviews` entry `complete`. Before then the
    >    finding set may be partial.
    > 4. Shut it down once it has **no live sub-agents**, not simply once its verdict lands —
    >    `SendMessage` it `{type: "shutdown_request"}`. The senior parallelizes review through its own
    >    sub-agents (`agents/senior-engineer.md` §Parallelizing Large Reviews) and its verdict can land
    >    while one is still running; shutting the parent down at that moment discards the live
    >    sub-agent and whatever it was about to return, silently — no error, no record, and the round
    >    reads as complete while part of the review is gone. Confirm nothing it spawned is still
    >    running before you send the shutdown, even if that means dispatching fixes starts later than
    >    the verdict landing. A senior kept alive after that point is carrying exactly the history this
    >    step exists to drop.
    >
    > **This is not the short-lived-agent exception** in `skills/workflow-guide/references/routing.md`
    > §Research Delegation — a per-round senior is a durable role with a per-round lifetime, and it is
    > shut down at the end of *its round*, not at teardown. The roster obligation still applies: record
    > each round's senior in the durable agent-ID roster as you spawn it (`skills/team-cleanup/SKILL.md`
    > §4. Shut Down Team Members), so a round whose shutdown fails is still visible at teardown.
    > `review-ledger senior spawned` is the machine-readable half of that record and the roster entry
    > the prose half; neither replaces the other. The ledger covers seniors, and the roster covers
    > every other agent anyone on the team spawns.
    >
    > **Route each finding to the ledger, not only to a message** (required when the ledger is
    > present; no-ops only if the `review-ledger` CLI is absent). When the senior reports, its findings
    > are already on the ledger; dispatch fixes from `review-ledger show --ticket "<TICKET-ID>"`, following
    > the finding form `agents/senior-engineer.md` §How You Work step 6 binds this dispatch to, and when a
    > fix lands, `review-ledger finding status --ticket "<TICKET-ID>" --id "<id>" --status fixed --fix-commit
    > "<sha>"`. When you decide a finding is not a defect, record it — `--status withdrawn --reason "<why>"`
    > — rather than dropping it silently: a withdrawal with a reason is what stops the next round's fresh
    > senior re-raising it, and the reason is the only thing that survives into a context that never saw
    > the discussion.
    >
    > **Open a routed line before disposing of it** (required when the ledger is present; no-ops only
    > if the `review-ledger` CLI is absent) — the same ledger obligation as ordinary findings, applied
    > to a routed line, which starts off the ledger entirely: it arrives as file, symbol, one sentence,
    > and whether it violates a user review standard (`skills/code-review/references/checklist.md`
    > §Routed lines) — the senior states that last fact, not you. **The termination condition
    > (`skills/code-review/references/checklist.md` §What Is In Scope) governs first, mark or no
    > mark**: a line whose defect is outside the diff, is true, and is not work is reported to you and
    > let go, never opened
    > — being marked as violating a user review standard does not route it around that gate, any more
    > than it routes around the gate for a defect that genuinely needs fixing outside the diff. Every
    > other line marked as violating a user review standard gets `review-ledger finding open
    > --ticket "<TICKET-ID>" --file "<path>" --symbol "<symbol>" --summary "<the senior's one
    > sentence>" --origin team-lead` before any disposition. `finding open` classifies the path the
    > same way it does for the senior (`skills/code-review/references/checklist.md` §What Is In
    > Scope): a trigger-1 line can genuinely name a path outside the diff against `origin/main`,
    > and then it is not opened at all — exit 16 — and that refusal discharges the must-open duty: a
    > record defect becomes `review-ledger note add`, a check file is filed only with `--check`, and
    > anything else is a process note. Then dispose of
    > it with the same `finding status` calls used for any senior-reported finding — `finding status`
    > refuses an id that was never opened (exit 5), so the open must land first: `fixed` with
    > `--fix-commit` once a fix lands, `withdrawn` with `--reason` when you decide it is not a defect.
    > Every other routed line stays discretionary — a ticket, a finding, or nothing, your call, with
    > no *must-open* obligation; a finding you do choose to open goes on the ledger like any other.

21. **PR Lifecycle (BLOCKING — do not proceed until complete).** After senior approval, invoke the **PR Lifecycle** skill (`workflow:pr-lifecycle`), passing: branch name and worktree path; PR title (`<type>: [<TICKET-ID>] <description>`; no `[<TICKET-ID>] ` with no ticket — `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket) and body (see `skills/pr-lifecycle/SKILL.md`, the PR-creation step, for what the body is for); repo owner/name; Jira ticket ID; process improvement notes file path; whether this ticket is an epic story entered earlier this session or the dashboard root; whether this ticket produces multiple PRs (default no). The key itself is never passed in — PR Lifecycle resolves it with `dashboard session key --ticket "<TICKET-ID>"` (`skills/board/references/dashboard-protocol.md` §1, *The ticket node key*). **STOP HERE** — this step blocks until the PR is merged or the user explicitly says they're done; do NOT proceed to cleanup until one of those events occurs. The team stays alive during the entire wait — do NOT shut down any durable team member (implementers, senior engineer) while waiting for PR feedback (a common failure: shutting down the team immediately after the draft PR, before review or merge — this is WRONG). Short-lived question-answering agents sit outside that rule — a researcher or a review sub-agent still shuts down when its answer lands, per `skills/workflow-guide/references/routing.md` §Research Delegation. **The per-round senior respawn in step 20 is not an exception to this rule, and does not need one** — this rule forbids the team going idle, unstaffed, while feedback could arrive; it says nothing about one process persisting. The senior *role* stays filled for the whole wait, by a fresh spawn each round, per step 20's respawn procedure.

22. **Cleanup, only after PR merge or user confirmation.** Precondition: the PR has been merged (detected by the PR monitor) OR the user has explicitly confirmed the work is complete — if neither, you are still in **PR Lifecycle**. Invoke the **Team Cleanup** skill (`workflow:team-cleanup`), passing: worktree path(s) and branch name(s); repo root path; team member names/IDs; process improvement notes file path; epic context (the epic key, if this story belongs to one — Team Cleanup derives the remaining stories live from Jira rather than taking a list from here).

23. **One story at a time.** This skill handles a single story. The Architecture skill sequences multiple stories. NEVER batch multiple stories into one worktree, team, or PR — each story gets its own worktree, its own team, and its own draft PR. If the epic has 3 stories, that means 3 separate worktrees, 3 separate teams, and 3 separate PRs executed serially.

Long-form guidance, completeness checks, operational rules, and error handling: read `references/team-dispatch-reference.md` — mandatory before your first run of this skill in a session.
