"""On-disk cache of usage readings.

Readings come from two places and are kept in separate files:

* ``statusline.json``: the ``rate_limits`` Claude Code hands to the status line
  command (written by ``claude-usage statusline``).
* ``claude.json``: the last answer Claude Code gave to a ``get_usage`` request.

The files hold only percentages and timestamps, never credentials.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple

from .usage import ClaudeSnapshot, Window, parse_number, parse_timestamp, windows_from

APP_NAME = "claude-usage-checker"
STATUSLINE_FILE = "statusline.json"
CLAUDE_FILE = "claude.json"
HOOK_FILE = "hook-state.json"

SESSION_TTL = 7 * 24 * 3600
MAX_SESSIONS = 200
SEEN_AT_RESOLUTION = 3600  # refresh a session's seen_at at most hourly to avoid rewrites

Reading = Tuple[float, Optional[float]]  # (used percent, resets_at epoch seconds)


def default_cache_dir() -> Path:
    override = os.environ.get("CLAUDE_USAGE_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        xdg = os.environ.get("XDG_CACHE_HOME")
        base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".cache"
    root = base / APP_NAME
    # Claude Code instances with their own CLAUDE_CONFIG_DIR may be logged in to
    # other accounts, so they get their own cache.
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        resolved = os.path.normcase(os.path.abspath(os.path.expanduser(config_dir)))
        default = os.path.normcase(os.path.abspath(os.path.expanduser("~/.claude")))
        if resolved != default:
            digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:12]
            root = root / f"config-{digest}"
    return root


def parse_statusline_rate_limits(payload: Any) -> Dict[str, Reading]:
    """Extract ``rate_limits`` windows from a Claude Code status line payload."""
    rate_limits = payload.get("rate_limits") if isinstance(payload, Mapping) else None
    readings: Dict[str, Reading] = {}
    if not isinstance(rate_limits, Mapping):
        return readings
    for name, raw in rate_limits.items():
        if not isinstance(raw, Mapping):
            continue
        used = parse_number(raw.get("used_percentage"))
        if used is None:
            continue
        readings[str(name)] = (used, parse_timestamp(raw.get("resets_at")))
    return readings


class Store:
    def __init__(self, directory: Optional[Path] = None) -> None:
        self.directory = Path(directory) if directory is not None else default_cache_dir()

    def read(self, name: str) -> Dict[str, Any]:
        try:
            with open(self.directory / name, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def write(self, name: str, data: Mapping[str, Any]) -> None:
        """Atomically replace ``name`` so concurrent readers never see partial JSON."""
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=str(self.directory))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, separators=(",", ":"))
            os.replace(tmp, self.directory / name)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # -- status line readings -------------------------------------------------

    def record_statusline(self, payload: Mapping[str, Any], now: float) -> Dict[str, Window]:
        """Store the ``rate_limits`` of a status line payload; return its windows.

        Claude Code re-runs the status line for many reasons (a timer, vim mode,
        ...) and keeps passing the numbers from the session's last API response.
        A reading therefore counts as observed when its session last showed new
        data (a changed ``total_api_duration_ms`` or changed numbers), not when
        the status line happened to run. That keeps an idle session from passing
        off old numbers as fresh.
        """
        readings = parse_statusline_rate_limits(payload)
        if not readings:
            return {}
        session_id = str(payload.get("session_id") or "")
        cost = payload.get("cost")
        api_ms = cost.get("total_api_duration_ms") if isinstance(cost, Mapping) else None
        signature = json.dumps([api_ms, sorted([name, used, resets] for name, (used, resets) in readings.items())])

        state = self.read(STATUSLINE_FILE)
        before = json.dumps(state, sort_keys=True)
        sessions = state.get("sessions")
        sessions = sessions if isinstance(sessions, dict) else {}
        stored = state.get("windows")
        stored = stored if isinstance(stored, dict) else {}

        data_at = seen_at = now
        previous = sessions.get(session_id)
        if isinstance(previous, dict) and previous.get("sig") == signature:
            prev_data_at = parse_timestamp(previous.get("data_at"))
            if prev_data_at is not None and prev_data_at <= now:
                data_at = prev_data_at
            prev_seen_at = parse_timestamp(previous.get("seen_at"))
            if prev_seen_at is not None and 0 <= now - prev_seen_at < SEEN_AT_RESOLUTION:
                seen_at = prev_seen_at
        sessions[session_id] = {"sig": signature, "data_at": data_at, "seen_at": seen_at}
        _prune_sessions(sessions, now)

        windows: Dict[str, Window] = {}
        for name, (used, resets_at) in readings.items():
            window = Window(used, resets_at, data_at, "statusline")
            windows[name] = window
            current = Window.from_dict(stored.get(name))
            if current is None or data_at >= current.observed_at:
                stored[name] = window.to_dict()

        state = {"version": 1, "windows": stored, "sessions": sessions}
        if json.dumps(state, sort_keys=True) != before:
            self.write(STATUSLINE_FILE, state)
        return windows

    def statusline_windows(self) -> Dict[str, Window]:
        return windows_from(self.read(STATUSLINE_FILE).get("windows"))

    # -- Claude Code get_usage answers -----------------------------------------

    def save_claude_snapshot(self, snapshot: ClaudeSnapshot) -> None:
        data = {"version": 1}
        data.update(snapshot.to_dict())
        self.write(CLAUDE_FILE, data)

    def load_claude_snapshot(self) -> Optional[ClaudeSnapshot]:
        return ClaudeSnapshot.from_dict(self.read(CLAUDE_FILE))


def _prune_sessions(sessions: Dict[str, Any], now: float) -> None:
    def seen(key: str) -> float:
        entry = sessions[key]
        value = parse_timestamp(entry.get("seen_at")) if isinstance(entry, dict) else None
        return value or 0.0

    for key in [k for k in sessions if now - seen(k) > SESSION_TTL]:
        del sessions[key]
    if len(sessions) > MAX_SESSIONS:
        for key in sorted(sessions, key=seen)[: len(sessions) - MAX_SESSIONS]:
            del sessions[key]
