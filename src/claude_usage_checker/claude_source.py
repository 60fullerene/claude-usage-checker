"""Ask Claude Code itself for the plan usage data behind ``/usage``.

Claude Code answers a ``get_usage`` control request on its stream-json
interface (the Agent SDK exposes it as the experimental
``usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()``). Claude Code
does the login, token refresh and request to Anthropic itself. No prompt is
sent, so no model call is made and no usage is consumed.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from .usage import ClaudeSnapshot, Window, parse_number, parse_timestamp

DEFAULT_TIMEOUT = 30.0

# Variables that bind a process to a running Claude Code session. Claude Code
# drops the same ones when it launches a fresh `claude` process itself.
SESSION_ENV_VARS = (
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
)

# Credentials that outrank the /login subscription login in `claude -p` but can
# never report plan limits (API keys, gateway tokens, and inference-only tokens
# from `claude setup-token`). Without them the helper uses the /login login.
CREDENTIAL_ENV_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")

# Keys of the get_usage ``rate_limits`` object that are not usage windows.
NON_WINDOW_KEYS = {"extra_usage", "model_scoped"}

LOGIN_HINT = "Run `claude auth status` to check that Claude Code works and is logged in."


class SourceError(Exception):
    def __init__(self, code: str, message: str, hint: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


def find_claude() -> Optional[str]:
    """Locate the Claude Code executable (hooks and MCP hosts may run with a thin PATH)."""
    override = os.environ.get("CLAUDE_USAGE_CLAUDE_BIN")
    if override:
        return override
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    names = ("claude.exe", "claude") if os.name == "nt" else ("claude",)
    for directory in (home / ".local" / "bin", home / ".claude" / "local", Path("/opt/homebrew/bin"), Path("/usr/local/bin")):
        for name in names:
            candidate = directory / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def child_env() -> Dict[str, str]:
    env = dict(os.environ)
    for name in SESSION_ENV_VARS + CREDENTIAL_ENV_VARS:
        env.pop(name, None)
    return env


def query_claude(timeout: float = DEFAULT_TIMEOUT, executable: Optional[str] = None) -> ClaudeSnapshot:
    """Run ``claude -p`` in stream-json mode and send it a ``get_usage`` request."""
    if os.environ.get("CLAUDE_CODE_REMOTE", "").lower() in ("1", "true"):
        # A nested `claude` would inherit the cloud session's IPC settings.
        raise SourceError(
            "unsupported_environment",
            "Asking Claude Code for usage is not supported inside a Claude Code on the web session.",
            hint="Use claude-usage on a machine where you run Claude Code locally.",
        )
    exe = executable or find_claude()
    if not exe:
        raise SourceError(
            "claude_not_found",
            "The `claude` command (Claude Code) was not found.",
            hint="Install Claude Code and log in with your Claude subscription, "
            "or set CLAUDE_USAGE_CLAUDE_BIN to the path of the claude executable.",
        )
    request_id = f"claude-usage-checker-{uuid.uuid4().hex[:12]}"
    request = {
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": "get_usage", "skip_behaviors": True},
    }
    try:
        workdir = tempfile.TemporaryDirectory(prefix="claude-usage-")
    except OSError as exc:
        raise SourceError("claude_error", f"Could not create a temporary directory: {exc}") from None
    with workdir as tmp:
        # Keep the helper session inert: no hooks (which could also re-enter this
        # tool) and no MCP servers. Passed as files to avoid shell-quoting JSON.
        settings = os.path.join(tmp, "settings.json")
        mcp_config = os.path.join(tmp, "mcp.json")
        try:
            with open(settings, "w", encoding="utf-8") as fh:
                json.dump({"disableAllHooks": True}, fh)
            with open(mcp_config, "w", encoding="utf-8") as fh:
                json.dump({"mcpServers": {}}, fh)
        except OSError as exc:
            raise SourceError("claude_error", f"Could not write temporary settings: {exc}") from None
        command = [
            exe, "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config", mcp_config,
            "--settings", settings,
        ]  # fmt: skip
        child = _Child(command)
        try:
            child.send(request)
            payload = _await_response(child, request_id, time.monotonic() + timeout, timeout)
        finally:
            child.close()
    return parse_usage_response(payload, observed_at=time.time())


def parse_usage_response(payload: Mapping[str, Any], observed_at: float) -> ClaudeSnapshot:
    """Turn a ``get_usage`` response into a snapshot, or raise SourceError."""
    subscription = payload.get("subscription_type")
    subscription = subscription if isinstance(subscription, str) else None
    rate_limits = payload.get("rate_limits")
    if not isinstance(rate_limits, Mapping):
        if payload.get("rate_limits_available") is False:
            raise SourceError(
                "rate_limits_unavailable",
                "Claude Code has no Claude subscription login that can report plan usage limits.",
                hint="Log in to Claude Code with your Claude Pro/Max/Team/Enterprise account (run `claude`, "
                "then /login). API keys, Bedrock/Vertex/gateways and `claude setup-token` tokens (which lack "
                "the user:profile scope) cannot report plan limits.",
            )
        raise SourceError(
            "no_data",
            "Claude Code returned no plan usage data (the usage service may be busy or rate limited).",
            hint="Try again in a minute.",
        )

    windows: Dict[str, Window] = {}
    for name, raw in rate_limits.items():
        if name in NON_WINDOW_KEYS or not isinstance(raw, Mapping):
            continue
        window = _window(raw, observed_at)
        if window is not None:
            windows[str(name)] = window

    model_windows: Dict[str, Window] = {}
    scoped = rate_limits.get("model_scoped")
    for item in scoped if isinstance(scoped, list) else []:
        if not isinstance(item, Mapping) or not isinstance(item.get("display_name"), str):
            continue
        window = _window(item, observed_at)
        if window is not None:
            model_windows[item["display_name"]] = window

    extra = rate_limits.get("extra_usage")
    return ClaudeSnapshot(
        observed_at=observed_at,
        windows=windows,
        model_windows=model_windows,
        extra_usage=dict(extra) if isinstance(extra, Mapping) else None,
        subscription_type=subscription,
    )


def _window(raw: Mapping[str, Any], observed_at: float) -> Optional[Window]:
    used = parse_number(raw.get("utilization"))
    resets_at = parse_timestamp(raw.get("resets_at"))
    if used is None and resets_at is None:
        return None
    return Window(used, resets_at, observed_at, "claude")


def _await_response(child: "_Child", request_id: str, deadline: float, timeout: float) -> Dict[str, Any]:
    while True:
        try:
            message = child.next_message(deadline)
        except queue.Empty:
            raise SourceError(
                "timeout",
                f"Claude Code did not answer within {timeout:g} seconds.",
                hint=LOGIN_HINT + " On a slow machine, raise --timeout.",
            ) from None
        if message is None:  # stdout closed
            break
        if message.get("type") != "control_response":
            continue
        response = message.get("response")
        if not isinstance(response, dict) or response.get("request_id") != request_id:
            continue
        if response.get("subtype") == "success":
            payload = response.get("response")
            if isinstance(payload, dict):
                return payload
            raise SourceError("claude_error", "Claude Code returned an empty get_usage response.")
        error = str(response.get("error") or "unknown error")
        if "unsupported control request" in error.lower():
            raise SourceError(
                "claude_unsupported",
                f"This Claude Code version cannot report usage limits ({error}).",
                hint="Update Claude Code (`claude update`), or use the status line cache (see README).",
            )
        raise SourceError("claude_error", f"Claude Code could not report usage: {error}")

    returncode = child.wait_exit()
    detail = " / ".join(child.diagnostics()[-5:])
    message = "Claude Code exited" + ("" if returncode is None else f" with status {returncode}")
    message += " without reporting usage" + (f": {detail}" if detail else ".")
    raise SourceError("claude_error", message, hint=LOGIN_HINT)


class _Child:
    """A ``claude`` process whose stdout lines are read on a background thread."""

    def __init__(self, command: List[str]) -> None:
        try:
            self.proc = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=child_env(),
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError:
            raise SourceError(
                "claude_not_found",
                f"Could not run {command[0]}: file not found.",
                hint="Set CLAUDE_USAGE_CLAUDE_BIN to the path of the claude executable.",
            ) from None
        except OSError as exc:
            raise SourceError("claude_error", f"Could not run {command[0]}: {exc}") from None
        self._lines: "queue.Queue[Optional[str]]" = queue.Queue()
        self._stray: List[str] = []  # non-protocol output, kept for error messages
        self._stderr: List[str] = []
        self._threads = [
            threading.Thread(target=self._pump, args=(self.proc.stdout, self._lines.put), daemon=True),
            threading.Thread(target=self._pump, args=(self.proc.stderr, self._keep_stderr), daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    @staticmethod
    def _pump(stream: Any, sink: Any) -> None:
        try:
            for line in stream:
                sink(line)
        except (OSError, ValueError):
            pass
        finally:
            sink(None)

    def _keep_stderr(self, line: Optional[str]) -> None:
        if line is not None and line.strip():
            self._stderr = (self._stderr + [line.strip()])[-20:]

    def send(self, message: Mapping[str, Any]) -> None:
        try:
            self.proc.stdin.write(json.dumps(message) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            pass  # it already exited; its output says why

    def next_message(self, deadline: float) -> Optional[Dict[str, Any]]:
        """Next JSON object from stdout; None at EOF; raises queue.Empty at the deadline."""
        while True:
            line = self._lines.get(timeout=max(0.0, deadline - time.monotonic()))
            if line is None:
                return None
            text = line.strip()
            try:
                message = json.loads(text) if text.startswith("{") else None
            except ValueError:
                message = None
            if isinstance(message, dict):
                if message.get("type") == "result" and message.get("is_error"):
                    self._stray.append(str(message.get("result") or "error result"))
                return message
            if text:
                self._stray = (self._stray + [text])[-20:]

    def diagnostics(self) -> List[str]:
        return self._stray + self._stderr

    def wait_exit(self) -> Optional[int]:
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            return None
        self._threads[1].join(timeout=1)
        return self.proc.returncode

    def close(self) -> None:
        # Let Claude Code shut down on its own (end of input, well under a second)
        # so it is never killed halfway through writing its config; escalate
        # (SIGTERM first, which it handles gracefully) only if it hangs.
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass
        for stop in (None, self.proc.terminate, self.proc.kill):
            if stop is not None:
                stop()
            try:
                self.proc.wait(timeout=5)
                break
            except subprocess.TimeoutExpired:
                continue
        for thread in self._threads:
            thread.join(timeout=1)
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
