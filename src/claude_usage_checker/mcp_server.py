"""``claude-usage mcp``: a minimal MCP server (stdio) with one tool, ``get_claude_usage``."""

from __future__ import annotations

import json
import sys
from typing import Any, Callable, Dict, IO, Optional

from . import __version__, claude_source, service
from .store import Store
from .usage import parse_number

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
STRUCTURED_CONTENT_SINCE = "2025-06-18"

TOOL_NAME = "get_claude_usage"
TOOL: Dict[str, Any] = {
    "name": TOOL_NAME,
    "title": "Claude usage limits",
    "description": (
        "Report how much of the Claude subscription's usage limits remain: the rolling 5-hour window and "
        "the weekly (7-day) window, as used/remaining percentages with reset times (plus per-model weekly "
        "windows when known). Call it before starting a large task and now and then during long autonomous "
        "work, so you can pace yourself and save or commit your work before a limit is reached."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "enum": list(service.SOURCES),
                "description": "auto (default): a cached reading if fresh, otherwise ask Claude Code (1-3 s). "
                "cache: cached readings only (instant, may be stale). claude: always ask Claude Code.",
            },
            "max_age_seconds": {
                "type": "number",
                "minimum": 0,
                "description": "In auto mode, the oldest cached reading to accept (default 120).",
            },
        },
        "additionalProperties": False,
    },
    "annotations": {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
}
INSTRUCTIONS = (
    "Use get_claude_usage to see how much of the Claude usage limits (5-hour and weekly windows) remain "
    "before large tasks and periodically during long-running work."
)


class Server:
    def __init__(
        self,
        max_age: float = service.DEFAULT_MAX_AGE,
        timeout: float = claude_source.DEFAULT_TIMEOUT,
        store: Optional[Store] = None,
        get_report: Callable[..., Dict[str, Any]] = service.get_report,
    ) -> None:
        self.max_age = max_age
        self.timeout = timeout
        self.store = store
        self.get_report = get_report
        self.protocol_version = PROTOCOL_VERSIONS[0]

    def handle(self, message: Any) -> Optional[Dict[str, Any]]:
        """Answer one JSON-RPC message; None for notifications and responses."""
        if not isinstance(message, dict):
            return _error(None, -32600, "Invalid Request")
        method = message.get("method")
        if not isinstance(method, str):
            is_response = "result" in message or "error" in message
            return None if is_response else _error(message.get("id"), -32600, "Invalid Request")
        if "id" not in message:
            return None  # notification (initialized, cancelled, ...)
        request_id = message["id"]
        params = message.get("params")
        params = params if isinstance(params, dict) else {}
        if method == "initialize":
            return _result(request_id, self._initialize(params))
        if method == "ping":
            return _result(request_id, {})
        if method == "tools/list":
            return _result(request_id, {"tools": [TOOL]})
        if method == "tools/call":
            if params.get("name") != TOOL_NAME:
                return _error(request_id, -32602, f"Unknown tool: {params.get('name')}")
            return _result(request_id, self._call(params.get("arguments")))
        return _error(request_id, -32601, f"Method not found: {method}")

    def _initialize(self, params: Dict[str, Any]) -> Dict[str, Any]:
        requested = params.get("protocolVersion")
        self.protocol_version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return {
            "protocolVersion": self.protocol_version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "claude-usage-checker", "version": __version__},
            "instructions": INSTRUCTIONS,
        }

    def _call(self, arguments: Any) -> Dict[str, Any]:
        arguments = arguments if isinstance(arguments, dict) else {}
        unknown = sorted(set(arguments) - set(TOOL["inputSchema"]["properties"]))
        source = arguments.get("source", "auto")
        max_age = parse_number(arguments.get("max_age_seconds", self.max_age))
        if unknown:
            return _tool_error(f"Unknown argument(s): {', '.join(unknown)}")
        if source not in service.SOURCES:
            return _tool_error(f"source must be one of: {', '.join(service.SOURCES)}")
        if max_age is None or max_age < 0:
            return _tool_error("max_age_seconds must be a non-negative number")
        try:
            report = self.get_report(source=source, max_age=max_age, timeout=self.timeout, store=self.store)
        except Exception as exc:  # keep the server alive whatever happens
            return _tool_error(f"Internal error: {exc}")
        result: Dict[str, Any] = {
            "content": [{"type": "text", "text": json.dumps(report, indent=2, ensure_ascii=False)}],
            "isError": not report.get("ok"),
        }
        if self.protocol_version >= STRUCTURED_CONTENT_SINCE:
            result["structuredContent"] = report
        return result


def _result(request_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _tool_error(text: str) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def serve(stdin: Optional[IO[str]] = None, stdout: Optional[IO[str]] = None, **options: Any) -> int:
    """Serve newline-delimited JSON-RPC until stdin closes."""
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    server = Server(**options)
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            reply: Any = _error(None, -32700, "Parse error")
        else:
            if isinstance(message, list):  # JSON-RPC batch (older protocol versions)
                replies = [r for r in (server.handle(m) for m in message) if r is not None]
                reply = replies or None
            else:
                reply = server.handle(message)
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=True) + "\n")
            stdout.flush()
    return 0
