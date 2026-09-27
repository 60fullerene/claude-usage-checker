"""``claude-usage hook``: put the remaining usage into the agent's context.

Configured as a Claude Code hook, it answers with
``hookSpecificOutput.additionalContext``, which Claude Code hands to the model.
Without ``--warn-below`` it always reports (meant for SessionStart or
UserPromptSubmit); with it, it only speaks up when a window runs low, once per
session and again for every further 5 points used (meant for PostToolUse).
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import claude_source, service
from .store import HOOK_FILE, Store
from .usage import PRIMARY_WINDOWS, fmt_duration, fmt_percent, label_for, parse_number, parse_timestamp

# Events whose additionalContext reaches the model without changing what Claude
# Code does next (for Stop it would keep the agent going, so it is excluded).
CONTEXT_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
}
REWARN_DROP = 5.0  # warn again once another 5 points are used
SAME_RESET_TOLERANCE = 300.0  # seconds; reset times of one window can jitter slightly
STATE_TTL = 2 * 24 * 3600


def run_hook(
    stdin_text: str,
    warn_below: Optional[float] = None,
    source: str = "auto",
    max_age: float = service.DEFAULT_MAX_AGE,
    timeout: float = claude_source.DEFAULT_TIMEOUT,
    store: Optional[Store] = None,
    clock: Callable[[], float] = time.time,
    get_report: Callable[..., Dict[str, Any]] = service.get_report,
) -> Optional[str]:
    """Return the hook's JSON output, or None to stay silent."""
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        return None
    event = payload.get("hook_event_name")
    if event not in CONTEXT_EVENTS:
        return None
    store = store if store is not None else Store()
    report = get_report(source=source, max_age=max_age, timeout=timeout, store=store, clock=clock)
    if not report.get("ok"):
        return None

    if warn_below is None:
        text = f"Claude usage limits: {report['summary']}."
    else:
        low = [
            (name, report[name])
            for name in PRIMARY_WINDOWS
            if _remaining(report.get(name)) is not None and _remaining(report[name]) < warn_below
        ]
        if not low or not _should_warn(store, str(payload.get("session_id") or ""), low, clock()):
            return None
        details = "; ".join(_describe(name, window) for name, window in low)
        text = (
            f"Claude usage is running low: {details}. Current status: {report['summary']}. "
            "Prioritize finishing and saving the current work (commit, write notes) before starting "
            "anything large."
        )
    if report.get("stale"):
        age = max(report[name]["age_seconds"] for name in PRIMARY_WINDOWS if report.get(name))
        text += f" (The last reading is {fmt_duration(age)} old.)"
    return json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})


def _remaining(window: Any) -> Optional[float]:
    return window.get("remaining_percent") if isinstance(window, dict) else None


def _describe(name: str, window: Dict[str, Any]) -> str:
    text = f"{label_for(name)} limit has {fmt_percent(window['remaining_percent'])}% left"
    if window.get("resets_in_seconds") is not None:
        text += f" (resets in {fmt_duration(window['resets_in_seconds'])})"
    return text


def _same_reset(previous: Any, current: Any) -> bool:
    before, after = parse_timestamp(previous), parse_timestamp(current)
    if before is None or after is None:
        return before is None and after is None
    return abs(before - after) <= SAME_RESET_TOLERANCE


def _should_warn(store: Store, session_id: str, low: List[Tuple[str, Dict[str, Any]]], now: float) -> bool:
    state = store.read(HOOK_FILE)
    sessions = state.get("sessions")
    sessions = sessions if isinstance(sessions, dict) else {}
    entry = sessions.get(session_id)
    entry = entry if isinstance(entry, dict) else {}

    def needs_warning(name: str, window: Dict[str, Any]) -> bool:
        previous = entry.get(name)
        if not isinstance(previous, dict) or not _same_reset(previous.get("resets_at"), window.get("resets_at")):
            return True
        last = parse_number(previous.get("remaining"))
        return last is None or window["remaining_percent"] <= last - REWARN_DROP

    if not any(needs_warning(name, window) for name, window in low):
        return False
    for name, window in low:
        entry[name] = {"remaining": window["remaining_percent"], "resets_at": window.get("resets_at")}
    entry["at"] = now
    sessions[session_id] = entry
    for key, value in list(sessions.items()):
        if not isinstance(value, dict) or now - (parse_timestamp(value.get("at")) or 0) > STATE_TTL:
            del sessions[key]
    try:
        store.write(HOOK_FILE, {"version": 1, "sessions": sessions})
    except OSError:
        pass
    return True
