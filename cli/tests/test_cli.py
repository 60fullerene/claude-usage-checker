"""End-to-end runs of `python -m claude_usage_checker` against the fake `claude`."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from .helpers import AMBIENT_VARS, SRC, make_fake_claude, posix_only, read_calls


@posix_only
class CliTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.log = str(self.tmp / "calls.jsonl")
        self.env = {k: v for k, v in os.environ.items() if k not in AMBIENT_VARS}
        self.env.update(
            PYTHONPATH=str(SRC),
            CLAUDE_USAGE_CACHE_DIR=str(self.tmp / "cache"),
            CLAUDE_USAGE_CLAUDE_BIN=make_fake_claude(self.tmp),
            FAKE_CLAUDE_LOG=self.log,
        )

    def run_cli(self, *args, stdin="", **env):
        return subprocess.run(
            [sys.executable, "-m", "claude_usage_checker", *args],
            input=stdin,
            capture_output=True,
            text=True,
            env=dict(self.env, **env),
            timeout=60,
        )

    def test_json_report_from_claude_code_then_cache(self):
        first = self.run_cli("--json")
        self.assertEqual(first.returncode, 0, first.stderr)
        report = json.loads(first.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["five_hour"]["remaining_percent"], 88.0)
        self.assertEqual(report["seven_day"]["remaining_percent"], 66.0)
        self.assertEqual(report["five_hour"]["source"], "claude")
        self.assertEqual(report["model_windows"]["Fable"]["used_percent"], 21.0)
        second = json.loads(self.run_cli("--json").stdout)
        self.assertEqual(second["five_hour"]["remaining_percent"], 88.0)
        self.assertEqual(len(read_calls(self.log)), 1)  # the second answer came from the cache

    def test_threshold_exit_codes(self):
        passed = self.run_cli("--oneline", "--min-5h", "50", "--min-7d", "50")
        self.assertEqual(passed.returncode, 0)
        self.assertEqual(passed.stdout.strip().split(" check: ")[1], "ok")
        low = self.run_cli("--oneline", "--min-5h", "90")
        self.assertEqual(low.returncode, 1)
        self.assertIn("check: LOW (5h 88% < 90%)", low.stdout)
        checked = json.loads(self.run_cli("--json", "--min-7d", "70").stdout)["check"]
        self.assertEqual(checked["failures"], [{"window": "seven_day", "remaining_percent": 66.0, "min_remaining_percent": 70.0}])

    def test_errors(self):
        failed = self.run_cli("--min-5h", "10", FAKE_CLAUDE_MODE="unavailable")
        self.assertEqual(failed.returncode, 2)
        self.assertEqual(failed.stdout, "")
        self.assertIn("rate_limits_unavailable", failed.stderr)
        as_json = self.run_cli("--json", FAKE_CLAUDE_MODE="unavailable")
        self.assertEqual(as_json.returncode, 2)
        self.assertEqual(json.loads(as_json.stdout)["error"]["code"], "rate_limits_unavailable")
        self.assertEqual(self.run_cli("--min-5h", "150").returncode, 2)  # bad argument

    def test_text_output(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0)
        self.assertIn("Claude usage limits", result.stdout)
        self.assertIn("88% left", result.stdout)
        self.assertIn("7-day (Fable)", result.stdout)

    def test_statusline_feeds_the_cache(self):
        now = time.time()
        payload = {
            "session_id": "s1",
            "cwd": "/tmp/プロジェクト",  # non-ASCII input must be fine
            "cost": {"total_api_duration_ms": 10},
            "rate_limits": {
                "five_hour": {"used_percentage": 42.0, "resets_at": int(now) + 3600},
                "seven_day": {"used_percentage": 10.0, "resets_at": int(now) + 86400},
            },
        }
        line = self.run_cli("statusline", "--no-color", stdin=json.dumps(payload, ensure_ascii=False))
        self.assertEqual(line.returncode, 0)
        self.assertTrue(line.stdout.startswith("5h 58% left (resets in "), line.stdout)
        report = json.loads(self.run_cli("--json", "--source", "cache").stdout)
        self.assertEqual(report["five_hour"]["source"], "statusline")
        self.assertEqual(report["five_hour"]["remaining_percent"], 58.0)
        self.assertEqual(read_calls(self.log), [])

    def test_hook(self):
        result = self.run_cli("hook", stdin=json.dumps({"hook_event_name": "SessionStart", "session_id": "x"}))
        self.assertEqual(result.returncode, 0)
        context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertTrue(context.startswith("Claude usage limits: 5h: 88% left"), context)
        quiet = self.run_cli("hook", "--warn-below", "10", stdin=json.dumps({"hook_event_name": "PostToolUse"}))
        self.assertEqual((quiet.returncode, quiet.stdout), (0, ""))

    def test_mcp_server(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_claude_usage", "arguments": {}}},
        ]  # fmt: skip
        result = self.run_cli("mcp", stdin="".join(json.dumps(m) + "\n" for m in messages))
        self.assertEqual(result.returncode, 0, result.stderr)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2])
        self.assertEqual(replies[1]["result"]["structuredContent"]["five_hour"]["remaining_percent"], 88.0)

    def test_version(self):
        result = self.run_cli("--version")
        self.assertEqual(result.returncode, 0)
        self.assertRegex(result.stdout, r"^claude-usage \d+\.\d+\.\d+")


if __name__ == "__main__":
    unittest.main()
