---
name: claude-usage
description: Check how much of the Claude subscription's usage limits remain (the rolling 5-hour window and the weekly 7-day window) and when they reset. Use before starting a large or long-running task, periodically during long autonomous work, when deciding whether to take on more work or spawn many subagents, and whenever the user asks about remaining Claude usage, limits, quota or reset times.
---

# Claude usage limits

The `claude-usage` command reports how much of the 5-hour and weekly usage limits
of the Claude subscription (the one Claude Code is logged in to) is left.
If the `get_claude_usage` MCP tool is available, it returns the same report.

## Checking

```bash
claude-usage --oneline
# 5h: 77% left (resets in 2h19m) | 7d: 59% left (resets in 3d17h)

claude-usage --json   # full report
```

Fields of the JSON report:

- `ok`: false when no data could be obtained; `error.message` and `error.hint` say why.
- `five_hour.remaining_percent`, `seven_day.remaining_percent`: 0-100 (`null` if unknown).
- `five_hour.resets_in_seconds`, `seven_day.resets_in_seconds`: time until the window resets.
- `stale`: true when the numbers could not be refreshed recently; treat them as approximate.
- `other_windows`: extra limits such as `seven_day_sonnet`, or `spend_limit` behind a gateway.

To gate a step on the remaining usage, use the exit status:

```bash
claude-usage --min-5h 10 --min-7d 5 --oneline   # 0 = enough left, 1 = below a threshold, 2 = unknown
```

A check is cheap (usually answered from a cache, otherwise it takes 1-3 seconds and
consumes no usage), but there is no need to check more than every few minutes.

## Acting on the result

- **5-hour window above ~30% left**: work normally.
- **10-30% left**: finish the current task before starting new large ones, avoid fanning
  out many parallel subagents, and commit or save work more often.
- **Below ~10% left**: wrap up. Finish the current step, commit or save the work, write a
  short note of what is done and what remains, and tell the user when the window resets.
- **Weekly window below ~10% left**: tell the user; it can take days to reset.
- **`ok` is false**: carry on with the task. Mention that usage could not be checked only
  if it matters for the decision at hand; do not try to repair the user's login.
