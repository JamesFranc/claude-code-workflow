# Notification Protocol — Document Hosting + Delivery

This file is the single authoritative statement of the "opening for review" flow every design-doc-producing skill uses: host the document in Notion, then notify the user. It is also the authority for hosting any other local file a review cites as evidence (§Evidence files). Consumer skills keep only their parameters here — do not re-copy this text into a skill file.

This process runs in three steps: **(0) validate** every fenced `mermaid` block and **render** every fenced `d2` block in the document, then **(1) host** it in Notion, then **(2) notify** the user.

## Parameters by doc type

| Skill | Doc type | `dashboard link add --kind` | `--label` | File suffix |
|---|---|---|---|---|
| `workflow:jtbd` | PRD | `prd` | `PRD` | `1-prd.md` |
| `workflow:architecture` | Architecture | `architecture` | `Architecture` | `2-arch.md` |
| `workflow:systematic-debugging` | Bug Summary | `architecture` | `Bug Summary` | `1-bug.md` |
| `workflow:quick-change` | Change Summary | `prd` | `Change Summary` | `1-change.md` |

A new unit of work is expressed by JTBD starting a fresh dashboard root (`dashboard session enter`, no `--key`) — not by a notification-channel flag.

## Phase 0 — Validate and render diagrams (before hosting)

Before hosting or notifying, validate every fenced `mermaid` block and render every fenced `d2`
block in the local document, so a broken diagram is never discovered live in the user's review:

```bash
validate-mermaid --file "docs/plans/YYYY-MM-DD-<topic>-<suffix>"
render-diagrams --file "docs/plans/YYYY-MM-DD-<topic>-<suffix>"
```

- Exit 0 from both → every mermaid block parses and every d2 block rendered; proceed to Phase 1.
  No doc type requires a diagram, so a document with no diagrams passes.
- `render-diagrams` writes `diagram-<n>.svg`, `diagram-<n>.webp`, and `hosted.md` to
  `<doc-basename>.assets/` beside the document, and prints the `hosted.md` path as `hosted` in its
  JSON. `hosted.md` is the document with its frontmatter removed and each `d2` block replaced by its
  image; Phase 1 hosts that file, not the document itself.
- Non-zero → `render-diagrams` writes nothing for a failing document. Read which shape it is:
  - stdout JSON with `ok: false` → fix the blocks listed in its `failures`; stderr prints each as
    `<file>: d2 block #N (line L): <error>`, and a d2 error starts with its line and column within
    the block. `validate-mermaid` prints `<file>: mermaid block #N (line L): <error>` for its blocks.
  - no JSON, and stderr names the document's `diagram-palette` value → fix that in the local file;
    if it names a `--file` path that does not exist → fix the path you passed.
  - anything else, `render-diagrams bug:` included, is a tool or environment failure: do not edit
    the document; report it.

  Re-run until both exit 0 **before** hosting or notifying.
  **Do not host or notify a document with a failing diagram.**

This step runs regardless of whether Notion is configured — it guards the local file the user
reviews whether or not it is hosted in Notion. How to write the diagrams themselves:
`diagrams.md` in this directory.

## Phase 1 — Document hosting (Notion)

Use the saved `notion` state from the parsed `check-tools` result to determine Notion intent.

If `notion` is `configured`:

1. Check the local file for YAML frontmatter containing `notion-page-id` — or the legacy
   `notion_page_id`. Both spellings mean the same thing; read whichever one is present.
   If a file somehow carries both, use `notion-page-id` and leave both keys untouched.
   The content you will send in step 2 or 3b is Phase 0's `hosted.md`, not the document itself.
   Then rewrite local images and videos in that content. Notion cannot read a local path, so an
   image it embeds from disk (`![...](./shot.png)`, or a rendered
   `![Diagram 1](doc.assets/diagram-1.webp)`; every relative path in `hosted.md` resolves against
   the source document's directory, not `hosted.md`'s) renders broken once hosted: upload each such
   file per §Evidence files step 1 and replace its reference in that content with the upload's
   `markdown_source`. A local `.mp4` (`![Walkthrough](doc.walkthrough.mp4)`) is uploaded the same
   way, and its whole line is replaced with `<video src="<markdown_source>"></video>`, which is also
   the upload response's `suggested_markdown`. A file over 20 MiB is not uploaded; replace its
   reference with a line naming the local path and saying it was too large to host. The local file
   keeps its local references; only the hosted copy is rewritten, and it is rewritten on every
   re-host.
2. **If either key exists:** Update the existing Notion page using `notion-update-page` with `command: "replace_content"` and the content from step 1, never with its prose still hard-wrapped. Use the stored page ID.
   If the page has child pages, such as an architecture page's walkthrough script, fetch it first
   and keep each child's `<page url="...">` tag, exactly as fetched, in the content you send.
   `replace_content` refuses content that would delete a child page.
   Save the Notion page URL for notification delivery. **Leave the key spelled exactly as you found it** — do not rewrite `notion_page_id` to `notion-page-id`.
3. **If neither key exists:**
   a. Use `notion-fetch` with the `NOTION_PAGE_URL` env var to resolve the parent page ID. (The env var is guaranteed to be set because `check-tools` reported Notion as `configured`.)
   b. Create a child page using `notion-create-pages` with `parent: { page_id: "<resolved-id>" }`. Set `properties: { title: "<document title>" }` and `content` to the content from step 1, never with its prose still hard-wrapped.
   c. Add `notion-page-id: <new-page-id>` to the file's YAML frontmatter. If the file has no frontmatter, add a `---` block at the top.
   d. Save the Notion page URL for notification delivery.

**The legacy `notion_page_id` branch is permanent — never remove it as a cleanup.** This protocol
runs as a plugin skill in every repo, so plan docs carrying the old key exist far beyond any one
repo's `docs/plans/` and were deliberately not migrated (FLOW-189). Dropping the legacy read would
make every one of those documents create a *duplicate* Notion page instead of updating in place.

If `notion` is `unconfigured`: skip hosting. The document remains local; notification delivery (Phase 2) will surface the local path in-session (it is never opened automatically).

**Dashboard (required when the board is present; no-ops only if the CLI is absent):** If a Notion page URL was saved above, register it as a link using this doc type's `--kind`/`--label` from the parameters table:
```bash
# The doc belongs on its ticket's own node: that ticket's key when it has one (the work runs as a
# story under an epic root), else the root, which is the usual case for all four callers.
TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
dashboard link add --kind "<kind>" --label "<label>" --url "<notion-url>" "${TICKET_NODE[@]}"
```

Do NOT call `open` on the Notion URL — notification delivery (Phase 2) handles how the user is notified.

## Phase 2 — Notification delivery

After the document is hosted (or kept local if Notion is unavailable), the dashboard is how the
user is notified — the board carries the link, and the session waits. **The workflow never opens a
document for the user** — no browser, no local app launch, no Notion launch, under any condition.

### When the board is present

Phase 1 registered the hosted document as a `dashboard link` (only when a Notion URL was saved).
Post the question/approval item for this doc per the skill's protocol. **When that item is the
approval**, it is an **advancement** approval: post it only once no open question could change this
document, and otherwise hold the approval and post it as your next action when that question
resolves (`skills/board/references/dashboard-protocol.md` §3.1). **A question is never
held** (§2) — it goes up the moment you have it. Then tell the user in-session that
the document is ready for review **on the dashboard**, and wait for their feedback. The open item is
what keeps the Stop hook watching — no other signal is needed.

### When there is no board (dashboard CLI absent)

There is nothing to open. Tell the user in-session where the document is — the Notion URL if one was
saved in Phase 1, otherwise the local path `docs/plans/YYYY-MM-DD-<topic>-<suffix>` — and wait for
their feedback. Do **not** call `open`. Be ready to revise — re-save and re-sync to Notion after
changes.

## Evidence files — hosting what a review cites

A board item, approval, or in-session review that cites a local file — a screenshot, a rendered
frame, a PDF, an HTML report, any non-document artifact — cites something the user cannot open: the
review tool runs in a browser, and browsers refuse `file://` links. When `notion` is `configured`,
host the file and cite the hosted page instead:

1. `notion-create-file-upload` with the file's `filename` (omit `content_type`; it is inferred from
   the extension). Then send the file in one multipart POST to the returned `upload_url`, with the
   file in the `file` field and every header in `upload_headers`:
   `curl -sS -X POST "<upload_url>" -H "<header>: <value>" -F "file=@<path>"` (one `-H` per header).
   A file over 20 MiB is not uploaded and skips steps 2–3: cite its local path and say it was too
   large to host.
2. Take `markdown_source` from the upload response and put it on a Notion page of its own. An
   upload not attached to a page expires, so this step is not optional. Create the page with
   `notion-create-pages` as a child of `NOTION_PAGE_URL`, resolved as Phase 1 step 3a resolves it,
   titled for the item it supports. Never put evidence on or under a hosted design doc's page:
   Phase 1 re-hosts that page with `replace_content`, which deletes appended content and fails on a
   child page the new content does not reference. Several files for one item go on one page.
3. Cite that page's URL in the evidence, never the local path. When the evidence belongs to a board
   node rather than a single item, also `dashboard link add` it there.

If `notion` is `unconfigured`, nothing is hosted: cite the local path, in the board item and in-session, and say it is local.
If a configured upload or page call fails, stop and report Notion as broken — do not fall back to the
local path.

**Configuration:** Set `NOTION_PAGE_URL` in `.claude/settings.local.json` under `env`.
