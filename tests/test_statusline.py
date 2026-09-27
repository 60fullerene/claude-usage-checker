import json
import os
import unittest
from unittest import mock

from claude_usage_checker.statusline import render_segment, run_statusline

from .helpers import NOW, TempStoreCase, posix_only, statusline_payload


class RunStatuslineTest(TempStoreCase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("NO_COLOR", None)

    def run_line(self, payload, **kwargs):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        kwargs.setdefault("color", False)
        return run_statusline(text, NOW, store=self.store, **kwargs)

    def test_prints_and_records(self):
        line = self.run_line(statusline_payload(five=(23.5, NOW + 3600)))
        self.assertEqual(line, "5h 76% left (resets in 1h0m) | 7d 60% left (resets in 1d0h)")
        self.assertEqual(self.store.statusline_windows()["five_hour"].used_percent, 23.5)

    def test_colors_by_remaining(self):
        line = self.run_line(statusline_payload(five=(90.0, NOW + 60), seven=(10.0, NOW + 60)), color=True)
        self.assertIn("\033[31m5h 10% left", line)
        self.assertIn("\033[32m7d 90% left", line)
        os.environ["NO_COLOR"] = "1"
        self.assertNotIn("\033[", self.run_line(statusline_payload(), color=True))

    def test_missing_or_invalid_input(self):
        for payload in ({"session_id": "x"}, "{not json", "", "[1, 2]"):
            self.assertEqual(self.run_line(payload), "5h -- | 7d --")
        self.assertEqual(self.store.statusline_windows(), {})

    def test_spend_limit_and_reset_window(self):
        payload = statusline_payload(five=(80.0, NOW - 1), spend_limit={"used_percentage": 62.8, "resets_at": NOW + 7200})
        self.assertEqual(self.run_line(payload), "5h 100% left | 7d 60% left (resets in 1d0h) | spend 37% left (resets in 2h0m)")

    def test_cache_errors_do_not_break_the_line(self):
        class BrokenStore:
            def record_statusline(self, payload, now):
                raise OSError("read-only file system")

        line = run_statusline(json.dumps(statusline_payload()), NOW, store=BrokenStore(), color=False)
        self.assertTrue(line.startswith("5h 80% left"))

    @posix_only
    def test_wrap_existing_command(self):
        payload = json.dumps({"model": {"display_name": "Opus"}, **statusline_payload()})
        command = "python3 -c \"import json,sys; print('[' + json.load(sys.stdin)['model']['display_name'] + ']')\""
        self.assertEqual(self.run_line(payload, wrap=command), "[Opus]")
        self.assertEqual(
            self.run_line(payload, wrap=command, append=True),
            "[Opus]\n5h 80% left (resets in 1h0m) | 7d 60% left (resets in 1d0h)",
        )
        self.assertIn("five_hour", self.store.statusline_windows())

    @posix_only
    def test_failing_wrapped_command(self):
        payload = statusline_payload()
        self.assertEqual(self.run_line(payload, wrap="exit 3"), "")
        self.assertEqual(self.run_line(payload, wrap="exit 3", append=True), render_segment({
            "five_hour": (20.0, NOW + 3600), "seven_day": (40.0, NOW + 86400)}, NOW, color=False))


if __name__ == "__main__":
    unittest.main()
