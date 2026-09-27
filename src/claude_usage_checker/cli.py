"""Command line interface: ``claude-usage [show|statusline|hook|mcp]``."""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from typing import Any, Dict, List, Optional

from . import __version__, claude_source, mcp_server, service
from .hook import run_hook
from .statusline import run_statusline
from .usage import SHORT_LABELS, fmt_percent, render_text

COMMANDS = ("show", "statusline", "hook", "mcp")
EXIT_OK, EXIT_LOW, EXIT_ERROR = 0, 1, 2


def main(argv: Optional[List[str]] = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if not args_list or args_list[0] not in COMMANDS + ("-h", "--help", "--version"):
        args_list.insert(0, "show")
    _relax_stdio()
    args = build_parser().parse_args(args_list)
    return args.func(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="claude-usage",
        description="Check how much of Claude's 5-hour and weekly usage limits remain.",
        epilog="Without a command, `show` is run. Exit status of show: 0 ok, "
        "1 below a --min-5h/--min-7d threshold, 2 no data or error.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")

    show = commands.add_parser("show", help="print the remaining usage (default)")
    output = show.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", help="print a JSON report (for agents and scripts)")
    output.add_argument("--oneline", action="store_true", help="print a one-line summary")
    _add_fetch_options(show)
    show.add_argument("--min-5h", type=_percent, metavar="PCT", help="exit 1 if the 5-hour window has less than PCT%% left")
    show.add_argument("--min-7d", type=_percent, metavar="PCT", help="exit 1 if the weekly window has less than PCT%% left")
    show.set_defaults(func=cmd_show)

    statusline = commands.add_parser(
        "statusline", help="status line command for Claude Code: records the rate limits it receives"
    )
    statusline.add_argument(
        "--wrap", metavar="COMMAND", help="run your existing status line COMMAND with the same input and print its output"
    )
    statusline.add_argument("--append", action="store_true", help="with --wrap, add the usage as an extra line")
    statusline.add_argument("--no-color", action="store_true", help="do not use ANSI colors")
    statusline.set_defaults(func=cmd_statusline)

    hook = commands.add_parser("hook", help="Claude Code hook that adds the remaining usage to the agent's context")
    hook.add_argument(
        "--warn-below", type=_percent, metavar="PCT", help="stay silent unless a window has less than PCT%% left"
    )
    _add_fetch_options(hook)
    hook.set_defaults(func=cmd_hook)

    mcp = commands.add_parser("mcp", help="run an MCP server (stdio) providing the get_claude_usage tool")
    _add_fetch_options(mcp, source=False)
    mcp.set_defaults(func=cmd_mcp)
    return parser


def _add_fetch_options(parser: argparse.ArgumentParser, source: bool = True) -> None:
    if source:
        parser.add_argument(
            "--source",
            choices=service.SOURCES,
            default="auto",
            help="auto (default): cached reading if fresh, else ask Claude Code; "
            "cache: cached readings only; claude: always ask Claude Code",
        )
    parser.add_argument(
        "--max-age",
        type=_non_negative,
        default=service.DEFAULT_MAX_AGE,
        metavar="SECONDS",
        help=f"oldest cached reading accepted in auto mode (default {service.DEFAULT_MAX_AGE:g})",
    )
    parser.add_argument(
        "--timeout",
        type=_positive,
        default=claude_source.DEFAULT_TIMEOUT,
        metavar="SECONDS",
        help=f"how long to wait for Claude Code (default {claude_source.DEFAULT_TIMEOUT:g})",
    )


def cmd_show(args: argparse.Namespace) -> int:
    report = service.get_report(source=args.source, max_age=args.max_age, timeout=args.timeout)
    status = EXIT_OK if report.get("ok") else EXIT_ERROR
    minimums = {"five_hour": args.min_5h, "seven_day": args.min_7d}
    if report.get("ok") and any(value is not None for value in minimums.values()):
        check = report["check"] = check_thresholds(report, minimums)
        if not check["passed"]:
            status = EXIT_ERROR if check.get("unknown") else EXIT_LOW

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return status
    if args.oneline:
        text = report["summary"] + (" [stale]" if report.get("stale") else "")
        if "check" in report:
            text += " " + check_text(report["check"])
    else:
        text = render_text(report, time.time())
        if "check" in report:
            text += "\n" + check_text(report["check"])
    print(text, file=sys.stdout if report.get("ok") else sys.stderr)
    return status


def check_thresholds(report: Dict[str, Any], minimums: Dict[str, Optional[float]]) -> Dict[str, Any]:
    failures: List[Dict[str, Any]] = []
    unknown: List[str] = []
    for name, minimum in minimums.items():
        if minimum is None:
            continue
        window = report.get(name)
        remaining = window.get("remaining_percent") if window else None
        if remaining is None:
            unknown.append(name)
        elif remaining < minimum:
            failures.append({"window": name, "remaining_percent": remaining, "min_remaining_percent": minimum})
    check: Dict[str, Any] = {"passed": not failures and not unknown, "failures": failures}
    if unknown:
        check["unknown"] = unknown
    return check


def check_text(check: Dict[str, Any]) -> str:
    if check["passed"]:
        return "check: ok"
    parts = [
        f"{SHORT_LABELS[f['window']]} {fmt_percent(f['remaining_percent'])}% < {fmt_percent(f['min_remaining_percent'])}%"
        for f in check["failures"]
    ]
    parts += [f"{SHORT_LABELS[name]} unknown" for name in check.get("unknown", [])]
    return f"check: {'LOW' if check['failures'] else 'UNKNOWN'} ({', '.join(parts)})"


def cmd_statusline(args: argparse.Namespace) -> int:
    try:
        text = run_statusline(
            _read_stdin(), time.time(), wrap=args.wrap, append=args.append, color=not args.no_color
        )
    except Exception:  # the status line must always render something
        text = ""
    _write_utf8(text + "\n" if text else "")
    return 0


def cmd_hook(args: argparse.Namespace) -> int:
    try:
        output = run_hook(
            _read_stdin(), warn_below=args.warn_below, source=args.source, max_age=args.max_age, timeout=args.timeout
        )
    except Exception:  # never disturb the session
        output = None
    if output:
        _write_utf8(output + "\n")
    return 0


def cmd_mcp(args: argparse.Namespace) -> int:
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    return mcp_server.serve(max_age=args.max_age, timeout=args.timeout)


def _read_stdin() -> str:
    """Claude Code sends UTF-8 JSON whatever the local code page is."""
    if sys.stdin is None or sys.stdin.isatty():
        return ""
    return sys.stdin.buffer.read().decode("utf-8", errors="replace")


def _write_utf8(text: str) -> None:
    sys.stdout.flush()
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def _relax_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def _number(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError(f"not a finite number: {text!r}")
    return value


def _non_negative(text: str) -> float:
    value = _number(text)
    if value < 0:
        raise argparse.ArgumentTypeError(f"must not be negative: {text!r}")
    return value


def _positive(text: str) -> float:
    value = _number(text)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be positive: {text!r}")
    return value


def _percent(text: str) -> float:
    value = _number(text)
    if not 0 <= value <= 100:
        raise argparse.ArgumentTypeError(f"must be between 0 and 100: {text!r}")
    return value
