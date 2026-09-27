"""Choose between cached readings and a live query, and build the report."""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Mapping, Optional

from . import claude_source
from .claude_source import SourceError
from .store import Store
from .usage import PRIMARY_WINDOWS, ClaudeSnapshot, Window, build_report, error_report

#: auto: cached readings while fresh, otherwise ask Claude Code (falling back to
#: stale readings if that fails). cache: cached readings only, never spawns
#: anything. claude: always ask Claude Code.
SOURCES = ("auto", "cache", "claude")
DEFAULT_MAX_AGE = 120.0

STATUSLINE_HINT = (
    "Set `claude-usage statusline` as your Claude Code status line (see README), "
    "or drop --source cache to ask Claude Code directly."
)


def merge_windows(statusline: Mapping[str, Window], snapshot: Optional[ClaudeSnapshot]) -> Dict[str, Window]:
    """Per window, keep whichever reading was observed last."""
    merged = dict(statusline)
    if snapshot is not None:
        for name, window in snapshot.windows.items():
            current = merged.get(name)
            if current is None or window.observed_at >= current.observed_at:
                merged[name] = window
    return merged


def is_fresh(windows: Mapping[str, Window], snapshot: Optional[ClaudeSnapshot], now: float, max_age: float) -> bool:
    if snapshot is not None and 0 <= now - snapshot.observed_at <= max_age:
        return True
    for name in PRIMARY_WINDOWS:
        window = windows.get(name)
        if window is None or now - window.observed_at > max_age:
            return False
        if window.resets_at is not None and window.resets_at <= now:
            return False
    return True


def get_report(
    source: str = "auto",
    max_age: float = DEFAULT_MAX_AGE,
    timeout: float = claude_source.DEFAULT_TIMEOUT,
    store: Optional[Store] = None,
    query: Optional[Callable[..., ClaudeSnapshot]] = None,
    clock: Callable[[], float] = time.time,
) -> Dict[str, Any]:
    if source not in SOURCES:
        raise ValueError(f"unknown source {source!r}; expected one of {', '.join(SOURCES)}")
    store = store if store is not None else Store()
    query = query or claude_source.query_claude
    statusline = store.statusline_windows()
    snapshot = store.load_claude_snapshot()
    warnings: List[str] = []
    refresh_error: Optional[SourceError] = None

    if source == "claude" or (
        source == "auto" and not is_fresh(merge_windows(statusline, snapshot), snapshot, clock(), max_age)
    ):
        try:
            snapshot = query(timeout=timeout)
        except SourceError as exc:
            refresh_error = exc
        else:
            try:
                store.save_claude_snapshot(snapshot)
            except OSError as exc:
                warnings.append(f"Could not write the cache in {store.directory}: {exc}")

    now = clock()
    if refresh_error is not None and source == "claude":
        return error_report(refresh_error.code, refresh_error.message, now, refresh_error.hint)

    windows = merge_windows(statusline, snapshot)
    if not any(name in windows for name in PRIMARY_WINDOWS):
        if refresh_error is not None:
            return error_report(refresh_error.code, refresh_error.message, now, refresh_error.hint)
        if source == "cache":
            return error_report("no_data", "No cached usage readings yet.", now, STATUSLINE_HINT)
        return error_report("no_data", "Claude Code returned no 5-hour or weekly usage data.", now)

    if refresh_error is not None:
        warnings.insert(
            0,
            f"Could not refresh from Claude Code ({refresh_error.code}): {refresh_error.message} "
            "Showing the last cached reading.",
        )
    return build_report(windows, snapshot, now, max_age, warnings)
