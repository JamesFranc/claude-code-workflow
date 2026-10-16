# No People's Names — write about the work, not the people

A workflow artifact describes the problem, the solution, and the technology. It never names a
person. This file is the single authoritative statement of that rule. Consumer skills state the
obligation at the point where they produce or check an artifact and point here for the rest.

## Where the rule binds

The prose of every one of these, in full — title, body, headings, examples, and quoted text:

- a PRD
- an architecture doc
- a bug summary or change summary
- an implementation plan
- a PR title or PR body
- a commit message — subject and body

## What is banned

A person's name, username, or handle in any form: a first or full name, a GitHub `@handle`, a chat
display name, an email address. "Per X's request", "X found that…", "as X suggested", and
"@handle flagged…" are all the same defect.

## What to write instead

State what the person said or did as a fact about the work. "A reviewer noted the cache is never
invalidated" becomes "The cache is never invalidated." "Requested by X" becomes the requirement
itself. Where a role genuinely changes the meaning — who is affected, who has to act — name the
role, never the person: "the user", "a reviewer", "on-call", "the API's consumers".

**A quoted literal keeps its evidence and loses the name.** Error text, log lines, and paths that
carry a username (`/Users/<name>/…`, `owner: <handle>`) are redacted to a placeholder such as
`<user>`. Everything else in the literal stays — redaction removes the name, never the content the
reader came for.

## Not covered

- **Metadata the tooling owns** — Jira assignee and reporter, git author and committer, the
  `Co-Authored-By:` and `Claude-Session:` trailers, PR author. These are structured fields, not
  prose, and this rule never asks for one to be added, stripped, or rewritten.
- **Product, tool, and bot names** — CodeRabbit, Renovate, GitHub Actions. These are technology,
  not people.
- **Channels outside the list above** — Jira tickets, memories, dashboard items, and replies in the
  terminal.
- **Existing artifacts** — the rule binds what is written from now on; it is not a mandate to
  rewrite merged docs, PRs, or history.
