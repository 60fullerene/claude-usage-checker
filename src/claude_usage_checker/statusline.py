"""``claude-usage statusline``: record Claude Code's rate limits and print a status line.

Claude Code pipes a JSON description of the session to the status line command
on every update; for Claude subscribers it includes ``rate_limits`` (documented,
Claude Code >= 2.1.80). Recording it keeps an always-fresh cache that
``claude-usage`` answers from instantly.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Mapping, Optional

from .store import Reading, Store, parse_statusline_rate_limits
from .usage import fmt_duration

SEGMENTS = (("five_hour", "5h"), ("seven_day", "7d"), ("spend_limit", "spend"))
GREEN, YELLOW, RED, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[0m"


def run_statusline(
    stdin_text: str,
    now: float,
    store: Optional[Store] = None,
    wrap: Optional[str] = None,
    append: bool = False,
    color: bool = True,
) -> str:
    """Record the payload's rate limits and return the text to print."""
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    readings = parse_statusline_rate_limits(payload)
    if readings:
        try:
            (store if store is not None else Store()).record_statusline(payload, now)
        except Exception:  # a cache problem must never break the status line
            pass
    segment = render_segment(readings, now, color and not os.environ.get("NO_COLOR"))
    if not wrap:
        return segment
    wrapped = run_wrapped(wrap, stdin_text)
    if append:
        return f"{wrapped}\n{segment}" if wrapped else segment
    return wrapped


def render_segment(readings: Mapping[str, Reading], now: float, color: bool = True) -> str:
    parts = []
    for name, label in SEGMENTS:
        reading = readings.get(name)
        if reading is None:
            if name != "spend_limit":  # only exists behind a Claude apps gateway
                parts.append(f"{label} --")
            continue
        used, resets_at = reading
        if resets_at is not None and resets_at <= now:
            used, resets_at = 0.0, None
        remaining = max(0.0, 100.0 - used)
        text = f"{label} {int(remaining)}% left"  # rounded down: never overstate what is left
        if resets_at is not None:
            text += f" (resets in {fmt_duration(resets_at - now)})"
        if color:
            shade = GREEN if remaining >= 50 else YELLOW if remaining >= 20 else RED
            text = f"{shade}{text}{RESET}"
        parts.append(text)
    return " | ".join(parts)


def run_wrapped(command: str, stdin_text: str, timeout: float = 10.0) -> str:
    """Run the user's own status line command with the same input; return its output."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            input=stdin_text,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.rstrip("\n")
