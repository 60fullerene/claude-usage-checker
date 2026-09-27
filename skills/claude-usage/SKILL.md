---
name: claude-usage
description: Check how much of the Claude subscription's usage limits remain (the rolling 5-hour window and the weekly 7-day window) and when they reset. Use before starting a large or long-running task, periodically during long autonomous work, when deciding whether to take on more work or spawn many subagents, and whenever the user asks about remaining Claude usage, limits, quota or reset times.
---

# Claude usage limits

Check how much of the 5-hour and weekly usage limits is left:

- **`get_claude_usage` tool** (the "Claude Usage" extension in Claude Desktop): call it with no
  arguments. Pass `organization` only if the report lists several organizations and the user
  means another one.
- **`claude-usage` command** (command-line version): `claude-usage --json`, or
  `claude-usage --oneline` for a one-line summary.

Both return the same main fields:

- `ok`: false when no data could be obtained; `error.message` and `error.hint` say why.
- `summary`: one line, e.g. `5h: 77% left (resets in 2h19m) | 7d: 59% left (resets in 3d17h)`.
- `five_hour.remaining_percent`, `seven_day.remaining_percent`: 0-100 (`null` if the plan has no such limit).
- `five_hour.resets_in_seconds`, `seven_day.resets_in_seconds`: time until the window resets.
- `model_windows`: weekly limits for specific models, if the plan has them.
- `stale`: true when fresh numbers could not be read just now and an older reading is shown
  (`warnings` says why); treat them as approximate.

A check takes a few seconds and consumes no usage, but there is no need to check more than every few
minutes.

## Acting on the result

- **5-hour window above ~30% left**: work normally.
- **10-30% left**: finish the current task before starting new large ones, avoid fanning out
  many parallel subagents, and save or commit work more often.
- **Below ~10% left**: wrap up. Finish the current step, save or commit the work, write a short
  note of what is done and what remains, and tell the user when the window resets.
- **Weekly window below ~10% left**: tell the user; it can take days to reset.
- **A model's weekly window is low**: mention it before relying on that model for a long task.
- **`ok` is false**: carry on with the task. Mention that usage could not be checked only if it
  matters for the decision at hand, and pass on `error.hint` if the user asks how to fix it.
