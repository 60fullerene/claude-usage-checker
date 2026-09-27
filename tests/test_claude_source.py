import json
import os
import tempfile
import time
import unittest
from unittest import mock

from claude_usage_checker.claude_source import SourceError, find_claude, parse_usage_response, query_claude
from claude_usage_checker.usage import Window

from .helpers import AMBIENT_VARS, NOW, make_fake_claude, posix_only, read_calls


def usage_payload(**rate_limits):
    return {"subscription_type": "pro", "rate_limits_available": True, "rate_limits": rate_limits}


class ParseUsageResponseTest(unittest.TestCase):
    def test_windows_models_and_extras(self):
        payload = usage_payload(
            five_hour={"utilization": 33.0, "resets_at": "2026-04-11T07:00:00.528743+00:00"},
            seven_day={"utilization": 13.0, "resets_at": "2026-04-17T00:59:59.951713+00:00"},
            seven_day_opus=None,
            seven_day_cowork={"utilization": 2.5, "resets_at": None},  # unknown future window
            model_scoped=[{"display_name": "Fable", "utilization": 40.0, "resets_at": None}, {"bogus": 1}],
            extra_usage={"is_enabled": False, "utilization": None},
        )
        snapshot = parse_usage_response(payload, observed_at=NOW)
        self.assertEqual(sorted(snapshot.windows), ["five_hour", "seven_day", "seven_day_cowork"])
        self.assertEqual(snapshot.windows["five_hour"].used_percent, 33.0)
        self.assertAlmostEqual(snapshot.windows["five_hour"].resets_at, 1775890800.528743, places=5)
        self.assertEqual(snapshot.windows["seven_day_cowork"], Window(2.5, None, NOW, "claude"))
        self.assertEqual(snapshot.model_windows, {"Fable": Window(40.0, None, NOW, "claude")})
        self.assertEqual(snapshot.extra_usage, {"is_enabled": False, "utilization": None})
        self.assertEqual(snapshot.subscription_type, "pro")
        self.assertEqual(snapshot.observed_at, NOW)

    def test_empty_windows_are_skipped(self):
        snapshot = parse_usage_response(
            usage_payload(five_hour={"utilization": None, "resets_at": None}, seven_day={"utilization": 0}), NOW
        )
        self.assertEqual(list(snapshot.windows), ["seven_day"])

    def test_limits_not_available(self):
        with self.assertRaises(SourceError) as ctx:
            parse_usage_response({"subscription_type": None, "rate_limits_available": False, "rate_limits": None}, NOW)
        self.assertEqual(ctx.exception.code, "rate_limits_unavailable")
        self.assertIn("setup-token", ctx.exception.hint)

    def test_no_data(self):
        with self.assertRaises(SourceError) as ctx:
            parse_usage_response({"rate_limits_available": True, "rate_limits": None}, NOW)
        self.assertEqual(ctx.exception.code, "no_data")


@posix_only
class QueryClaudeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.exe = make_fake_claude(tmp.name)
        self.log = os.path.join(tmp.name, "calls.jsonl")
        patcher = mock.patch.dict(
            os.environ,
            {
                "FAKE_CLAUDE_LOG": self.log,
                "CLAUDECODE": "1",
                "CLAUDE_CODE_SESSION_ID": "parent",
                "ANTHROPIC_API_KEY": "sk-ant-api-test",
                "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-test",
                "KEEP_ME": "yes",
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in AMBIENT_VARS:
            if name != "FAKE_CLAUDE_LOG":
                os.environ.pop(name, None)

    def query(self, mode="success", timeout=20.0):
        os.environ["FAKE_CLAUDE_MODE"] = mode
        return query_claude(timeout=timeout, executable=self.exe)

    def query_error(self, mode, timeout=20.0):
        with self.assertRaises(SourceError) as ctx:
            self.query(mode, timeout)
        return ctx.exception

    def test_success(self):
        before = time.time()
        snapshot = self.query()
        self.assertEqual(snapshot.windows["five_hour"].used_percent, 12.0)
        self.assertEqual(snapshot.windows["seven_day"].used_percent, 34.0)
        self.assertEqual(snapshot.windows["seven_day_sonnet"].used_percent, 3.0)
        self.assertNotIn("seven_day_opus", snapshot.windows)
        self.assertEqual(snapshot.model_windows["Fable"].used_percent, 21.0)
        self.assertEqual(snapshot.subscription_type, "max")
        self.assertGreaterEqual(snapshot.observed_at, before)

    def test_helper_session_is_inert_and_detached(self):
        self.query()
        [call] = read_calls(self.log)
        argv = call["argv"]
        for flag in ("-p", "--verbose", "--no-session-persistence", "--strict-mcp-config"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--input-format") + 1], "stream-json")
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertTrue(argv[argv.index("--settings") + 1].endswith("settings.json"))
        self.assertTrue(argv[argv.index("--mcp-config") + 1].endswith("mcp.json"))
        # Not tied to the calling session, and forced onto the /login subscription login.
        for name in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"):
            self.assertIsNone(call["env"][name], name)
        self.assertEqual(call["env"]["KEEP_ME"], "yes")

    def test_unrelated_output_is_skipped(self):
        self.assertEqual(self.query("noise").windows["five_hour"].used_percent, 12.0)

    def test_payload_is_passed_through(self):
        os.environ["FAKE_CLAUDE_PAYLOAD"] = json.dumps(usage_payload(five_hour={"utilization": 99.5, "resets_at": None}))
        self.assertEqual(self.query().windows["five_hour"].used_percent, 99.5)

    def test_limits_not_available(self):
        self.assertEqual(self.query_error("unavailable").code, "rate_limits_unavailable")

    def test_old_claude_code(self):
        error = self.query_error("unsupported")
        self.assertEqual(error.code, "claude_unsupported")
        self.assertIn("claude update", error.hint)

    def test_exit_without_answer(self):
        error = self.query_error("exit")
        self.assertEqual(error.code, "claude_error")
        self.assertIn("status 1", error.message)
        self.assertIn("Please run /login", error.message)

    def test_timeout(self):
        started = time.monotonic()
        error = self.query_error("hang", timeout=1.0)
        self.assertEqual(error.code, "timeout")
        self.assertLess(time.monotonic() - started, 10)

    def test_missing_executable(self):
        with self.assertRaises(SourceError) as ctx:
            query_claude(timeout=5, executable=os.path.join(os.path.dirname(self.log), "no-such-claude"))
        self.assertEqual(ctx.exception.code, "claude_not_found")

    def test_refuses_to_run_inside_claude_code_on_the_web(self):
        os.environ["CLAUDE_CODE_REMOTE"] = "true"
        self.assertEqual(self.query_error("success").code, "unsupported_environment")
        self.assertEqual(read_calls(self.log), [])

    def test_find_claude_honours_override(self):
        os.environ["CLAUDE_USAGE_CLAUDE_BIN"] = self.exe
        self.assertEqual(find_claude(), self.exe)


if __name__ == "__main__":
    unittest.main()
