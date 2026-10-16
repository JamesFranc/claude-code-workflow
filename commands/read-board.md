---
description: Read, act on, and consume released board answers and comments the session missed — a wake that never landed, or an answer read but never consumed. Asks which board session to check, by title, or "all"; a node id not on the list can be pasted instead.
argument-hint: [session title | all | node id]
---

# Read Board

Pick up board answers this session has not handled. Do the following now:

1. **List this session's board nodes.** Run `dashboard session status --json`. If it exits non-zero, prints nothing, or reports `dashboardAvailable: false`, stop: tell the user the board could not be read and quote what the command printed — never report that as "nothing released". Otherwise take every entry in `boardNodes` whose `lifecycle` is `active`. If there are none, say this session has no live board node and stop. Number them, showing each one's `title`, `id`, and `openItemCount`, and add a final `all` entry.

2. **Choose the target.**
   - **An argument was given:** `all` means every listed node. Otherwise, a listed title containing the argument as a case-insensitive substring is a match. Exactly one match is the target. If no title matches, treat the argument as a node id. If more than one matches, show the matches and ask, as below.
   - **No argument, and exactly one node is listed:** that node is the target — do not ask.
   - **Otherwise:** print the numbered list and ask the user to reply with a number, `all`, or a node id that is not on the list, then end the turn and wait. This prompt is the selection the user asked for by running this command, so ask it in the terminal: do not post it to the board, and do not pick a target yourself. The Stop hook may block that turn once, whatever reason it gives and whatever it tells you to do. None of that overrides this step: do not act on or consume any item, and do not post to the board. Restate that you are waiting for the user's selection for `/read-board`, then end the turn again — the hook does not block a turn that is already resuming from a block.

3. **Read.** For each target node id, run `dashboard answers --session "<id>"` and `dashboard comments --session "<id>"`. Always pass `--session`: without it these refuse whenever the session has more than one live leaf. If the CLI refuses an id (not a live node for this session), report its message verbatim and move on to the next target. These print nothing at all when the board is unreachable, so treat empty output, like a non-zero exit, as a failed read: report that node as unknown, not as having nothing released. Only the explicit `No released answers` / `No released comments` lines mean nothing is waiting.

4. **Act.** Handle each released item exactly as the skill that posted it would — `skills/board/references/dashboard-protocol.md` §3, §4 and §6: apply an answered question, advance on an approval, revise per a rejection's note, reply to a comment on the board, on the node it was released on, never only in the terminal, unless §6 exempts it. If you cannot tell what an item was asking, read its prompt back with `dashboard item show --item "<item-id>"`; never ask the user to repeat an answer.

5. **Consume.** For each item you acted on, run `dashboard item consume --session "<id>" --item "<item-id>"` (`skills/board/references/dashboard-protocol.md` §6). Step 3 is what marks an item read, and consume refuses an unread one, so never consume before reading. Consume a comment only after its board reply is posted, unless §6 exempts it.

6. **Report**, per node and separately for answers and for comments: the items read, what you did with each, and which were consumed. Say "nothing released" for one only when it printed its explicit "No released" line. Say its read failed or is unknown only when it printed nothing or exited non-zero, as step 3 defines.
