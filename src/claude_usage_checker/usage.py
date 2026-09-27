"""Usage-limit windows: parsing, reports and formatting."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional

#: The rolling 5-hour window and the weekly window, which apply to every plan.
PRIMARY_WINDOWS = ("five_hour", "seven_day")

LABELS = {
    "five_hour": "5-hour",
    "seven_day": "7-day",
    "seven_day_opus": "7-day Opus",
    "seven_day_sonnet": "7-day Sonnet",
    "seven_day_oauth_apps": "7-day OAuth apps",
    "spend_limit": "Spend limit",
}

SHORT_LABELS = {"five_hour": "5h", "seven_day": "7d"}

SOURCE_NAMES = {"statusline": "status line", "claude": "Claude Code query"}

# Anything later than this is garbage rather than a timestamp.
_MAX_EPOCH = 32503680000.0  # year 3000

_ISO_FRACTION = re.compile(r"(T\d{2}:\d{2}:\d{2})\.(\d+)")
_ISO_COMPACT_OFFSET = re.compile(r"([+-]\d{2})(\d{2})$")


def label_for(name: str) -> str:
    return LABELS.get(name) or name.replace("_", " ")


def parse_number(value: Any) -> Optional[float]:
    """Return ``value`` as a finite float, or None if it is not a number."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def parse_timestamp(value: Any) -> Optional[float]:
    """Parse epoch seconds, epoch milliseconds or an ISO 8601 string.

    Returns epoch seconds, or None when ``value`` is not a usable timestamp.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if not math.isfinite(ts) or ts <= 0:
            return None
        if ts > 1e11:  # milliseconds
            ts /= 1000.0
        return ts if ts < _MAX_EPOCH else None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        return parse_timestamp(float(text))
    except ValueError:
        pass
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    # Python < 3.11 only accepts 3 or 6 fractional digits and "+HH:MM" offsets.
    text = _ISO_FRACTION.sub(lambda m: f"{m.group(1)}.{m.group(2)[:6].ljust(6, '0')}", text)
    text = _ISO_COMPACT_OFFSET.sub(r"\1:\2", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def isoformat(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Window:
    """One reading of a usage-limit window."""

    used_percent: Optional[float]  # 0-100; a spend limit can go above 100
    resets_at: Optional[float]  # epoch seconds
    observed_at: float  # epoch seconds when the reading was current
    source: str  # "statusline" or "claude"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "used_percent": self.used_percent,
            "resets_at": self.resets_at,
            "observed_at": self.observed_at,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, data: Any) -> Optional["Window"]:
        if not isinstance(data, Mapping):
            return None
        observed_at = parse_timestamp(data.get("observed_at"))
        if observed_at is None:
            return None
        used = parse_number(data.get("used_percent"))
        resets_at = parse_timestamp(data.get("resets_at"))
        if used is None and resets_at is None:
            return None
        source = data.get("source")
        return cls(used, resets_at, observed_at, source if isinstance(source, str) else "unknown")


@dataclass
class ClaudeSnapshot:
    """The plan usage data Claude Code returned for a ``get_usage`` request."""

    observed_at: float
    windows: Dict[str, Window]
    model_windows: Dict[str, Window] = field(default_factory=dict)
    extra_usage: Optional[Dict[str, Any]] = None
    subscription_type: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "observed_at": self.observed_at,
            "windows": {name: w.to_dict() for name, w in self.windows.items()},
            "model_windows": {name: w.to_dict() for name, w in self.model_windows.items()},
            "extra_usage": self.extra_usage,
            "subscription_type": self.subscription_type,
        }

    @classmethod
    def from_dict(cls, data: Any) -> Optional["ClaudeSnapshot"]:
        if not isinstance(data, Mapping):
            return None
        observed_at = parse_timestamp(data.get("observed_at"))
        if observed_at is None:
            return None
        extra = data.get("extra_usage")
        sub = data.get("subscription_type")
        return cls(
            observed_at=observed_at,
            windows=windows_from(data.get("windows")),
            model_windows=windows_from(data.get("model_windows")),
            extra_usage=dict(extra) if isinstance(extra, Mapping) else None,
            subscription_type=sub if isinstance(sub, str) else None,
        )


def windows_from(data: Any) -> Dict[str, Window]:
    """Deserialize a ``{name: window dict}`` mapping, dropping invalid entries."""
    windows: Dict[str, Window] = {}
    if isinstance(data, Mapping):
        for name, raw in data.items():
            window = Window.from_dict(raw)
            if window is not None:
                windows[str(name)] = window
    return windows


# ---------------------------------------------------------------------------
# Reports


def window_report(window: Window, now: float) -> Dict[str, Any]:
    """Describe ``window`` as seen at ``now`` (JSON-ready)."""
    expired = window.resets_at is not None and window.resets_at <= now
    # A window that reset after the reading starts over: usage since the reset
    # is unknown, so report the fresh window as unused and flag it.
    used = 0.0 if expired else window.used_percent
    resets_at = None if expired else window.resets_at
    used_r: Optional[float] = None
    remaining_r: Optional[float] = None
    if used is not None:
        used_r = round(max(0.0, used), 1)
        remaining_r = round(max(0.0, 100.0 - used_r), 1)
    report: Dict[str, Any] = {
        "used_percent": used_r,
        "remaining_percent": remaining_r,
        "resets_at": isoformat(resets_at),
        "resets_in_seconds": None if resets_at is None else max(0, int(resets_at - now)),
        "observed_at": isoformat(window.observed_at),
        "age_seconds": max(0, int(now - window.observed_at)),
        "source": window.source,
    }
    if expired:
        report["estimated"] = True
    return report


def build_report(
    windows: Mapping[str, Window],
    snapshot: Optional[ClaudeSnapshot],
    now: float,
    max_age: float,
    warnings: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Build the JSON report agents consume."""
    warnings = list(warnings or [])
    primary: Dict[str, Optional[Dict[str, Any]]] = {}
    stale = False
    for name in PRIMARY_WINDOWS:
        window = windows.get(name)
        if window is None:
            primary[name] = None
            continue
        entry = window_report(window, now)
        if entry.get("estimated"):
            warnings.append(
                f"The {label_for(name)} window reset at {isoformat(window.resets_at)}, after the last "
                "reading; its usage is reported as 0% until new data arrives."
            )
        if now - window.observed_at > max_age:
            stale = True
        primary[name] = entry

    report: Dict[str, Any] = {"ok": True, "summary": ""}
    report.update(primary)
    report["stale"] = stale
    report["warnings"] = warnings

    others = {
        name: window_report(window, now)
        for name, window in sorted(windows.items())
        if name not in PRIMARY_WINDOWS
    }
    if others:
        report["other_windows"] = others
    if snapshot is not None:
        if snapshot.model_windows:
            report["model_windows"] = {
                name: window_report(window, now) for name, window in sorted(snapshot.model_windows.items())
            }
        if snapshot.extra_usage is not None:
            report["extra_usage"] = snapshot.extra_usage
        if snapshot.subscription_type:
            report["subscription_type"] = snapshot.subscription_type
    report["generated_at"] = isoformat(now)
    report["summary"] = summary_line(report)
    return report


def error_report(code: str, message: str, now: float, hint: Optional[str] = None) -> Dict[str, Any]:
    error: Dict[str, Any] = {"code": code, "message": message}
    if hint:
        error["hint"] = hint
    return {
        "ok": False,
        "summary": f"Claude usage unavailable: {message}",
        "error": error,
        "five_hour": None,
        "seven_day": None,
        "generated_at": isoformat(now),
    }


# ---------------------------------------------------------------------------
# Formatting


def fmt_percent(value: float) -> str:
    text = f"{value:.1f}"
    return text[:-2] if text.endswith(".0") else text


def fmt_duration(seconds: float) -> str:
    total = max(0, int(seconds))
    if total < 60:
        return f"{total}s"
    minutes = total // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h{minutes}m"
    days, hours = divmod(hours, 24)
    return f"{days}d{hours}h"


def fmt_clock(ts: float, now: float) -> str:
    """Local wall-clock time of ``ts``, as short as is unambiguous."""
    when = datetime.fromtimestamp(ts).astimezone()
    today = datetime.fromtimestamp(now).astimezone().date()
    days_ahead = (when.date() - today).days
    if days_ahead == 0:
        return when.strftime("%H:%M")
    if 0 < days_ahead < 7:
        return when.strftime("%a %H:%M")
    return when.strftime("%Y-%m-%d %H:%M")


def summary_line(report: Mapping[str, Any]) -> str:
    parts = []
    for name in PRIMARY_WINDOWS:
        label = SHORT_LABELS[name]
        window = report.get(name)
        if not window or window.get("remaining_percent") is None:
            parts.append(f"{label}: unknown")
            continue
        text = f"{label}: {fmt_percent(window['remaining_percent'])}% left"
        if window.get("resets_in_seconds") is not None:
            text += f" (resets in {fmt_duration(window['resets_in_seconds'])})"
        elif window.get("estimated"):
            text += " (window reset since last reading)"
        parts.append(text)
    return " | ".join(parts)


def progress_bar(remaining: float, width: int = 10) -> str:
    filled = min(width, max(0, int(round(remaining / 100.0 * width))))
    return "[" + "#" * filled + "." * (width - filled) + "]"


def render_text(report: Mapping[str, Any], now: float) -> str:
    """Multi-line, human-readable rendering of a report."""
    if not report.get("ok"):
        error = report.get("error") or {}
        lines = [f"Claude usage: unavailable ({error.get('code', 'error')})", f"  {error.get('message', '')}"]
        if error.get("hint"):
            lines.append(f"  hint: {error['hint']}")
        return "\n".join(lines)

    rows = [(label_for(name), report.get(name)) for name in PRIMARY_WINDOWS]
    rows += [(label_for(name), w) for name, w in (report.get("other_windows") or {}).items()]
    rows += [(f"7-day ({name})", w) for name, w in (report.get("model_windows") or {}).items()]
    width = max(len(label) for label, _ in rows)

    lines = ["Claude usage limits"]
    for label, window in rows:
        if not window or window.get("remaining_percent") is None:
            lines.append(f"  {label.ljust(width)}  unknown")
            continue
        remaining = window["remaining_percent"]
        line = (
            f"  {label.ljust(width)}  {progress_bar(remaining)} {fmt_percent(remaining):>5}% left"
            f"  ({fmt_percent(window['used_percent'])}% used)"
        )
        resets_at = parse_timestamp(window.get("resets_at"))
        if resets_at is not None:
            line += f", resets {fmt_clock(resets_at, now)} (in {fmt_duration(window['resets_in_seconds'])})"
        elif window.get("estimated"):
            line += ", reset since the last reading"
        lines.append(line)

    observed = [report.get(name) for name in PRIMARY_WINDOWS if report.get(name)]
    if observed:
        sources = sorted({SOURCE_NAMES.get(w["source"], w["source"]) for w in observed})
        age = max(w["age_seconds"] for w in observed)
        status = "  (stale)" if report.get("stale") else ""
        lines.append(f"  source: {', '.join(sources)}, {fmt_duration(age)} old{status}")
    for warning in report.get("warnings") or []:
        lines.append(f"  warning: {warning}")
    return "\n".join(lines)
