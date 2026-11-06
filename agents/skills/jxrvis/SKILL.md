---
name: jxrvis
description: Handle feedback a player speaks in a VR/MR headset (jXRvis). Use when the user says "watch the feedback", "read the feedback", or mentions headset takes, feedback/inbox or status.txt.
---

## Headset feedback (jXRvis)

The player tests this app in a VR/MR headset and speaks feedback while playing. Each take is a folder `feedback/inbox/<id>/` on this PC:

- `view.png`: what the player saw as they started talking (the status label and menu are left out; in passthrough the room is grey).
- `voice.*`: the recording. `transcript.txt`: its transcript, when a transcriber runs; it can be missing or misheard.
- `context.json`: what the app was doing (`summary`, `app`), head position and direction, the page, the last console errors, the take's length.
- `status.txt`: yours to write. Each line you add shows in the player's view as "Agent: <line>".

Takes are personal data. Never move, delete, upload or commit them; `feedback/` stays out of git.

### Live mode ("watch the feedback")

Get takes one at a time, while the player keeps the headset on: call the MCP tool `next_feedback` in a loop, or run `npx jxrvis-watch` and act on each `FEEDBACK <id> [<summary>]: <transcript>` line it prints.

For each take:

1. Look at the view and the context before deciding what the player meant. The transcript alone is often not enough.
2. At once, write `On it: <what you understood>`.
3. **Small, safe fix** (wording, colour, size, position, timing, an obvious bug in one place, something the tests cover): make it without waiting for a go, run the checks, then write `Done: <what changed>, reload to see`.
4. **Large, risky or ambiguous** (several systems, deleting things, data or dependencies, a design choice, unclear meaning, an unreadable transcript): write `Question: <short question>`, ask the same in your chat with what you saw, and change nothing for that take until you get an answer.
5. Not acting on it (not a problem, a duplicate, out of scope): write `Skipped: <why>`.

Status lines: one line each, under 70 characters, in plain words the player can read in the headset. No file paths or code. `Done` and `Skipped` end a take; the headset stops checking it.

The dev server reloads the page when code changes, so the player may see a reload on its own. Do not restart or reconfigure the dev server during live mode without asking: that drops the player's session.

When the session ends (or when asked), write a fix note, `feedback/notes/<date>_<time>.md`, one section per take: a short title with the take id, the view (`![view](../inbox/<id>/view.png)`), what was said, what you saw, the cause, the fix and its outcome. Then commit the code fixes, never the inbox or the notes, if this project lets you commit.

### Review mode ("read the feedback")

Outside live mode, write the fix note for every take not yet in one, with a proposed fix, how it will be checked, its risk, and `Decision: go / change / skip` per item. Change nothing until the user gives the go, per item or for the whole note.
