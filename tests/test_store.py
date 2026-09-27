import json
import os
import unittest
from pathlib import Path
from unittest import mock

from claude_usage_checker.store import (
    CLAUDE_FILE,
    STATUSLINE_FILE,
    default_cache_dir,
    parse_statusline_rate_limits,
)
from claude_usage_checker.usage import ClaudeSnapshot, Window

from .helpers import AMBIENT_VARS, NOW, TempStoreCase, posix_only, statusline_payload


@posix_only
class DefaultCacheDirTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"HOME": "/home/tester", "XDG_CACHE_HOME": "/xdg"})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in AMBIENT_VARS:
            os.environ.pop(name, None)

    def test_xdg_cache_home(self):
        self.assertEqual(default_cache_dir(), Path("/xdg/claude-usage-checker"))

    def test_relative_xdg_is_ignored(self):
        os.environ["XDG_CACHE_HOME"] = "relative/dir"
        self.assertEqual(default_cache_dir(), Path("/home/tester/.cache/claude-usage-checker"))

    def test_override(self):
        os.environ["CLAUDE_USAGE_CACHE_DIR"] = "/somewhere/else"
        self.assertEqual(default_cache_dir(), Path("/somewhere/else"))

    def test_other_claude_config_dirs_get_their_own_cache(self):
        os.environ["CLAUDE_CONFIG_DIR"] = "/home/tester/.claude/"
        self.assertEqual(default_cache_dir(), Path("/xdg/claude-usage-checker"))
        os.environ["CLAUDE_CONFIG_DIR"] = "/work/claude"
        work = default_cache_dir()
        os.environ["CLAUDE_CONFIG_DIR"] = "/personal/claude"
        personal = default_cache_dir()
        self.assertEqual(work.parent, Path("/xdg/claude-usage-checker"))
        self.assertTrue(work.name.startswith("config-"))
        self.assertNotEqual(work, personal)


class ParseStatuslineTest(unittest.TestCase):
    def test_parses_windows(self):
        payload = statusline_payload(spend_limit={"used_percentage": 120, "resets_at": NOW + 5})
        self.assertEqual(
            parse_statusline_rate_limits(payload),
            {"five_hour": (20.0, NOW + 3600), "seven_day": (40.0, NOW + 86400), "spend_limit": (120.0, NOW + 5)},
        )

    def test_ignores_malformed(self):
        for payload in (None, [], {}, {"rate_limits": None}, {"rate_limits": {"five_hour": "x"}},
                        {"rate_limits": {"five_hour": {"resets_at": NOW}}}):  # fmt: skip
            self.assertEqual(parse_statusline_rate_limits(payload), {}, payload)


class RecordStatuslineTest(TempStoreCase):
    def record(self, now, **kwargs):
        return self.store.record_statusline(statusline_payload(**kwargs), now)

    def stored(self, name="five_hour"):
        return self.store.statusline_windows()[name]

    def test_records_windows(self):
        windows = self.record(NOW)
        self.assertEqual(windows["five_hour"], Window(20.0, NOW + 3600, NOW, "statusline"))
        self.assertEqual(self.stored("seven_day"), Window(40.0, NOW + 86400, NOW, "statusline"))

    def test_repeated_reading_keeps_its_age(self):
        self.record(NOW)
        windows = self.record(NOW + 300)
        self.assertEqual(windows["five_hour"].observed_at, NOW)
        self.assertEqual(self.stored().observed_at, NOW)

    def test_new_api_response_refreshes_the_reading(self):
        self.record(NOW, api_ms=1000)
        self.record(NOW + 300, api_ms=2000)
        self.assertEqual(self.stored().observed_at, NOW + 300)

    def test_changed_numbers_refresh_the_reading(self):
        self.record(NOW)
        self.record(NOW + 300, five=(25.0, NOW + 3600))
        self.assertEqual(self.stored(), Window(25.0, NOW + 3600, NOW + 300, "statusline"))

    def test_idle_session_does_not_override_newer_data(self):
        self.record(NOW, session="idle", five=(20.0, NOW + 3600))
        self.record(NOW + 100, session="active", api_ms=5000, five=(30.0, NOW + 3600))
        self.record(NOW + 200, session="idle", five=(20.0, NOW + 3600))
        self.assertEqual(self.stored(), Window(30.0, NOW + 3600, NOW + 100, "statusline"))

    def test_payload_without_rate_limits_writes_nothing(self):
        self.assertEqual(self.store.record_statusline({"session_id": "x"}, NOW), {})
        self.assertFalse((self.store.directory / STATUSLINE_FILE).exists())

    def test_unchanged_reading_does_not_rewrite_the_file(self):
        self.record(NOW)
        path = self.store.directory / STATUSLINE_FILE
        os.utime(path, (1, 1))
        self.record(NOW + 60)
        self.assertEqual(path.stat().st_mtime, 1)

    def test_old_sessions_are_pruned(self):
        self.record(NOW - 8 * 86400, session="old")
        self.record(NOW, session="new", api_ms=2)
        sessions = json.loads((self.store.directory / STATUSLINE_FILE).read_text())["sessions"]
        self.assertEqual(list(sessions), ["new"])

    @posix_only
    def test_cache_files_are_private(self):
        self.record(NOW)
        mode = (self.store.directory / STATUSLINE_FILE).stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_corrupt_files_are_ignored(self):
        self.store.directory.mkdir(parents=True)
        (self.store.directory / STATUSLINE_FILE).write_text("{not json")
        (self.store.directory / CLAUDE_FILE).write_text('["not", "an", "object"]')
        self.assertEqual(self.store.statusline_windows(), {})
        self.assertIsNone(self.store.load_claude_snapshot())
        self.record(NOW)
        self.assertEqual(self.stored().used_percent, 20.0)


class ClaudeSnapshotStoreTest(TempStoreCase):
    def test_roundtrip(self):
        snapshot = ClaudeSnapshot(
            observed_at=NOW,
            windows={"five_hour": Window(1.0, NOW + 10, NOW, "claude"), "seven_day": Window(2.0, None, NOW, "claude")},
            model_windows={"Fable": Window(3.0, NOW + 20, NOW, "claude")},
            extra_usage={"is_enabled": True, "monthly_limit": 50},
            subscription_type="max",
        )
        self.store.save_claude_snapshot(snapshot)
        self.assertEqual(self.store.load_claude_snapshot(), snapshot)


if __name__ == "__main__":
    unittest.main()
