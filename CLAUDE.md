# Claude Code Workflow

A Claude Code workflow plugin: skills, hooks, agents, commands, and TypeScript CLI tools.

## Project Structure

- `skills/` — Markdown skill files
- `hooks/` — Claude Code hooks
- `agents/` — Agent definitions
- `commands/` — Slash commands
- `tools/` — TypeScript CLI tool packages (pnpm workspace)
- `bin/` — Shell wrappers for CLI tools
- `scripts/` — Standalone scripts too large to be a `bin/` wrapper (launched through one)
- `docs/plans/` — Design docs and implementation plans (gitignored; local to each checkout)

## Development

- **Package manager:** pnpm
- **TypeScript tools run via:** `node --experimental-transform-types`
- **CLI framework:** Stricli (`@stricli/core`)
- **Typecheck:** `pnpm typecheck`
- **Lint:** `pnpm lint`
- **Publish check:** `pnpm publish-check` scans what `git archive HEAD` would publish and refuses
  private content, a missing licence or notice, and excluded paths. It needs a `.private-terms.json`
  list of private terms, which is never published; without one it exits 2 (could not run). The
  source repository runs it on every pull request.
- **Publish snapshot:** a release publishes itself. When release-please creates a release, the
  `publish-snapshot` job in `.github/workflows/release-please.yml` runs
  `pnpm publish-snapshot --to denormans/claude-code-workflow` on the released commit, pushing with the
  `SNAPSHOT_DEPLOY_KEY` secret. Despite its name, it holds a fine-grained token, not a deploy key,
  with Contents and Workflows read/write on that repository only. To publish by hand, for example
  after the job failed on an expired token, run the same command from a released commit (the tip of
  `origin/main`, clean, tagged `claude-workflow-v<version>`). A release whose job refused because
  `main` moved cannot be published by hand either, since the tip is no longer the commit its tag
  names: the snapshot catches up when the next release publishes. It runs the publish check, then
  replaces the snapshot repo's tree with the export set as one `release: v<version>` commit and tag.
  It never changes the snapshot repo's visibility. To check a snapshot clone, run
  `pnpm publish-check --repo "<clone>" --terms "<source>/.private-terms.json"` from a source
  checkout, since the snapshot carries no terms file.
- **Test:** `pnpm test` — `tools/cli`'s suite is capped at 4 concurrent workers on hosts with 5 or
  more cores, and at Node's own `availableParallelism() - 1`, never below 1, on smaller ones.
  Several agent worktrees run this suite at once, and an inherited default means each one sizes
  itself to the whole machine.
- **Raising the cap:** `TEST_CONCURRENCY=8 pnpm test` — an explicit override is used verbatim and is
  never clamped, so it may exceed the ceiling. Raise it for a one-off local run that owns the
  machine. The ceiling and the formula live in `tools/cli/src/test-concurrency/cap.ts`, the
  `Report runner parallelism and resolved cap` step in `.github/workflows/ci.yml` prints the
  runner's size and the cap it resolves to, and `hooks/test-test-concurrency-cap.sh` tests the
  cap the modules resolve.
- **Simulating an I/O failure in a test:** not with permission bits, unless the test skips under
  root — root ignores mode bits, so the fixture never produces the failure there, and the test ends
  up passing, or failing for the wrong reason, either way not the one under test. Put the wrong kind
  of object at the path instead: a directory where a file goes (`EISDIR`), or a regular file where a
  parent directory goes (`ENOTDIR`) — but `ENOTDIR` only fails a create or write under that path; a
  read through it comes back as absent rather than unreadable, since `workflow-store`'s
  `EXISTENCE_CONFIRMING_CODES` (`store.ts`) excludes `ENOTDIR`, so it cannot simulate an unreadable
  file. Where no such shape produces the failure, skip under root with `process.getuid?.() === 0`
  and say why in the skip reason.

## Naming Conventions

**No lowercase snake_case for any name we own.** Lowercase snake_case appears in this repo only
where an external contract or the language itself imposes it; everything we name ourselves uses the
casings in the table below.

SCREAMING_SNAKE_CASE is deliberately *not* covered by that rule. It is snake_case with capitals, it
is ours to use for module-level literal constants and environment variables, and every statement of
the rule on this page means **lowercase** snake_case specifically. Read it that way throughout.

A module-level string is not a literal constant in that sense just because it never changes. A
short value that names or selects something — a tool name, a key, a mode — is one. A sentence, a
message or an instruction stored so it can be reused is ordinary text, and its name is camelCase.

| Kind | Casing |
|---|---|
| YAML frontmatter keys | kebab-case (`notion-page-id`) |
| CLI flags, file names | kebab-case |
| String-literal values naming a state, mode, or event | kebab-case (`'rate-limited'`, `'ci-failed'`) |
| Module-level literal constants — numbers, enum-like values, names — and environment variables | SCREAMING_SNAKE_CASE (`DASHBOARD_INVOKE_TIMEOUT_MS`) |
| Module-level reused text — a message, instruction or other prose kept in a variable to avoid repeating it | camelCase (a reused message such as a `retryHint`) |
| TypeScript/JavaScript identifiers and object keys | camelCase |
| JSON/config keys we define | camelCase |
| Shell variables and functions | snake_case — idiomatic in bash, keep it |

**Enum members depend on the language — and TypeScript shouldn't have them at all.**

- **TypeScript** — don't use `enum`. Use a union of `const` strings with kebab-case values
  (`type Status = 'rate-limited' | 'paused'`), which is the state/mode/event row above. This repo
  already does this everywhere; there are no `enum` declarations in it.
- **GraphQL** — camelCase enum values (`rateLimited`). Kebab-case is not available: the spec's Name
  is `/[_A-Za-z][_0-9A-Za-z]*/`, so a hyphen is a parse error.
- **Python** — SCREAMING_SNAKE for the member name, kebab-case for its value
  (`RATE_LIMITED = "rate-limited"`). The name follows PEP 8; the value follows the state/mode/event
  row above.

These are considered departures from the wider norm in each ecosystem, not oversights; do not
"correct" them.

`ChangeType` in `tools/cli/src/pr-monitor/state.ts` carries a standing exception to the TypeScript
rule above: its SCREAMING_SNAKE members are grandfathered, not correct. They stay that way because
`format.ts` emits those literals verbatim on stdout and the skill and command documents match them
by name, so renaming them is a breaking cross-process change, not a cleanup. The exception covers
only what is already there — new members are kebab-case, and it is not a licence to coin new
underscore vocabularies.

Lowercase snake_case stays only where it is **required** by an external contract or **idiomatic** to the
language:

- Claude Code hook payloads and tool params — `session_id`, `tool_name`, `tool_input`,
  `hook_event_name`, `stop_hook_active`, `file_path`, `old_string`, `run_in_background`,
  `shutdown_request` / `shutdown_response` / `plan_approval_response`, `subagent_type`
- MCP tool params — `page_id`, `parent_id`, `account_id`, `assignee_account_id`, `replace_content`
- Third-party APIs and language builtins — `child_process`, `foreign_keys`, `foreign_key_check`
- Bash, in `hooks/*.sh` and the `bin/` wrappers
- The legacy `notion_page_id` frontmatter key, read for backward compatibility — see
  `skills/workflow-guide/references/notification-protocol.md` §Phase 1

An external contract or the language's own idiom is the *only* reason to reach for lowercase
snake_case. "The file next to it does" is not.

## Reference Conventions

**Cite the thing, not its coordinates.** A reference in anything that outlives the branch — a code
comment, a plan under `docs/plans/`, a Jira ticket, a PR body — must resolve to the same answer from
`origin/main` after a squash merge. Symbols and quoted content do. Line numbers, branch shas, and
measured figures with no sample stated do not, and they rot with no signal: nothing fails, nothing
warns, and the artifact goes on asserting the stale value confidently.

This repo squash merges, so every commit on a branch stops being an ancestor of `origin/main` the
moment it lands.

Full rule and what to check: `skills/workflow-guide/references/durable-references.md`. Code review
enforces it — `skills/code-review/references/review-rules.md` §Durable References.

## Artifact Subject Conventions

**Write about the work, never the people.** PRDs, architecture docs, bug and change summaries,
implementation plans, PR titles and bodies, and commit messages describe the problem, the solution,
and the technology. None of them names a person — no names, usernames, or handles.

Full rule: `skills/workflow-guide/references/no-people-names.md`. Code review enforces it —
`skills/code-review/references/review-rules.md` §No People's Names.

## Vendored / Source-of-Truth Files

Some repos contain files that are **copied from an upstream template or generated from a source of truth** — their content is owned elsewhere, so a fix made directly in the copy is lost on the next sync and the real fix belongs upstream. This section is the manifest of such files for this repo. Code review (`workflow:code-review`) consults it and treats every listed path as **out-of-scope-by-policy**: a finding on a listed file is not flagged against the consumer PR — it is routed to the upstream / source-of-truth owner instead.

**Manifest (paths relative to repo root):**

_None currently._

When a vendored or generated-and-committed file is introduced, add its path here with its upstream / source-of-truth owner on the same line, e.g. `- path/to/copy.ts — generated from <source>; fix upstream`.
