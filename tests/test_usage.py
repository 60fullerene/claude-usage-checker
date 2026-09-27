import unittest
from datetime import datetime, timezone

from claude_usage_checker.usage import (
    ClaudeSnapshot,
    Window,
    build_report,
    error_report,
    fmt_duration,
    fmt_percent,
    isoformat,
    parse_number,
    parse_timestamp,
    render_text,
    window_report,
)

from .helpers import NOW


class ParseTest(unittest.TestCase):
    def test_epoch_seconds_and_milliseconds(self):
        self.assertEqual(parse_timestamp(1738425600), 1738425600.0)
        self.assertAlmostEqual(parse_timestamp(1738425600123), 1738425600.123)
        self.assertEqual(parse_timestamp("1738425600"), 1738425600.0)

    def test_iso_variants(self):
        expected = datetime(2026, 4, 11, 7, 0, tzinfo=timezone.utc).timestamp()
        for text in (
            "2026-04-11T07:00:00Z",
            "2026-04-11T07:00:00+00:00",
            "2026-04-11T07:00:00.000+00:00",
            "2026-04-11T16:00:00+09:00",
            "2026-04-11T16:00:00+0900",
            "2026-04-11T07:00:00",  # naive: UTC
        ):
            self.assertAlmostEqual(parse_timestamp(text), expected, places=3, msg=text)
        # Fractions of any length (Python < 3.11 only takes 3 or 6 digits).
        self.assertAlmostEqual(parse_timestamp("2026-04-11T07:00:00.528743123+00:00"), expected + 0.528743, places=5)
        self.assertAlmostEqual(parse_timestamp("2026-04-11T07:00:00.5Z"), expected + 0.5, places=5)

    def test_rejects_garbage(self):
        for value in (None, True, "", "soon", float("nan"), float("inf"), -5, 0, {}, [], 1e20):
            self.assertIsNone(parse_timestamp(value), value)

    def test_parse_number(self):
        self.assertEqual(parse_number(23.5), 23.5)
        self.assertEqual(parse_number(7), 7.0)
        self.assertEqual(parse_number(" 12.5 "), 12.5)
        for value in (None, True, "x", float("nan"), [], {}):
            self.assertIsNone(parse_number(value), value)


class WindowReportTest(unittest.TestCase):
    def test_remaining_and_reset(self):
        report = window_report(Window(23.5, NOW + 3600, NOW - 30, "statusline"), NOW)
        self.assertEqual(report["used_percent"], 23.5)
        self.assertEqual(report["remaining_percent"], 76.5)
        self.assertEqual(report["resets_at"], isoformat(NOW + 3600))
        self.assertEqual(report["resets_in_seconds"], 3600)
        self.assertEqual(report["age_seconds"], 30)
        self.assertEqual(report["source"], "statusline")
        self.assertNotIn("estimated", report)

    def test_rounding_is_consistent(self):
        report = window_report(Window(33.333, None, NOW, "claude"), NOW)
        self.assertEqual(report["used_percent"], 33.3)
        self.assertEqual(report["remaining_percent"], 66.7)
        self.assertIsNone(report["resets_at"])
        self.assertIsNone(report["resets_in_seconds"])

    def test_over_the_limit(self):
        report = window_report(Window(120.0, None, NOW, "statusline"), NOW)
        self.assertEqual(report["used_percent"], 120.0)
        self.assertEqual(report["remaining_percent"], 0.0)

    def test_window_that_reset_since_the_reading(self):
        report = window_report(Window(95.0, NOW - 10, NOW - 600, "statusline"), NOW)
        self.assertEqual(report["used_percent"], 0.0)
        self.assertEqual(report["remaining_percent"], 100.0)
        self.assertIsNone(report["resets_at"])
        self.assertTrue(report["estimated"])

    def test_unknown_usage(self):
        report = window_report(Window(None, NOW + 60, NOW, "claude"), NOW)
        self.assertIsNone(report["used_percent"])
        self.assertIsNone(report["remaining_percent"])
        self.assertEqual(report["resets_in_seconds"], 60)


class BuildReportTest(unittest.TestCase):
    def test_full_report(self):
        windows = {
            "five_hour": Window(10.0, NOW + 100, NOW - 5, "statusline"),
            "seven_day": Window(50.0, NOW + 1000, NOW - 5, "statusline"),
            "seven_day_sonnet": Window(5.0, NOW + 1000, NOW - 5, "claude"),
        }
        snapshot = ClaudeSnapshot(
            NOW - 5, {}, {"Fable": Window(20.0, NOW + 1000, NOW - 5, "claude")}, {"is_enabled": False}, "max"
        )
        report = build_report(windows, snapshot, NOW, max_age=120)
        self.assertTrue(report["ok"])
        self.assertFalse(report["stale"])
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["five_hour"]["remaining_percent"], 90.0)
        self.assertEqual(report["seven_day"]["remaining_percent"], 50.0)
        self.assertEqual(list(report["other_windows"]), ["seven_day_sonnet"])
        self.assertEqual(report["model_windows"]["Fable"]["remaining_percent"], 80.0)
        self.assertEqual(report["extra_usage"], {"is_enabled": False})
        self.assertEqual(report["subscription_type"], "max")
        self.assertEqual(report["summary"], "5h: 90% left (resets in 1m) | 7d: 50% left (resets in 16m)")
        self.assertEqual(list(report)[:2], ["ok", "summary"])

    def test_stale_and_missing_windows(self):
        report = build_report({"seven_day": Window(50.0, NOW + 1000, NOW - 500, "statusline")}, None, NOW, 120)
        self.assertTrue(report["stale"])
        self.assertIsNone(report["five_hour"])
        self.assertEqual(report["summary"], "5h: unknown | 7d: 50% left (resets in 16m)")
        self.assertNotIn("other_windows", report)
        self.assertNotIn("model_windows", report)

    def test_reset_window_adds_warning(self):
        windows = {
            "five_hour": Window(90.0, NOW - 60, NOW - 90, "statusline"),
            "seven_day": Window(50.0, NOW + 1000, NOW - 90, "statusline"),
        }
        report = build_report(windows, None, NOW, 120, warnings=["first"])
        self.assertEqual(report["five_hour"]["remaining_percent"], 100.0)
        self.assertEqual(report["warnings"][0], "first")
        self.assertIn("reset", report["warnings"][1])
        self.assertIn("5h: 100% left (window reset since last reading)", report["summary"])

    def test_error_report(self):
        report = error_report("no_data", "Nothing yet.", NOW, hint="Wait.")
        self.assertFalse(report["ok"])
        self.assertEqual(report["error"], {"code": "no_data", "message": "Nothing yet.", "hint": "Wait."})
        self.assertIsNone(report["five_hour"])
        self.assertEqual(report["summary"], "Claude usage unavailable: Nothing yet.")


class FormatTest(unittest.TestCase):
    def test_fmt_duration(self):
        cases = {
            -5: "0s", 0: "0s", 59: "59s", 60: "1m", 3599: "59m", 3600: "1h0m", 8388: "2h19m",
            86400: "1d0h", 3 * 86400 + 17 * 3600 + 5: "3d17h",
        }  # fmt: skip
        for seconds, expected in cases.items():
            self.assertEqual(fmt_duration(seconds), expected, seconds)

    def test_fmt_percent(self):
        self.assertEqual(fmt_percent(76.5), "76.5")
        self.assertEqual(fmt_percent(77.0), "77")
        self.assertEqual(fmt_percent(0.0), "0")
        self.assertEqual(fmt_percent(100.0), "100")

    def test_render_text(self):
        windows = {
            "five_hour": Window(23.5, NOW + 3600, NOW - 30, "statusline"),
            "seven_day": Window(91.0, NOW + 3 * 86400, NOW - 30, "statusline"),
        }
        text = render_text(build_report(windows, None, NOW, 120), NOW)
        self.assertIn("5-hour", text)
        self.assertIn("76.5% left", text)
        self.assertIn("(23.5% used)", text)
        self.assertIn("in 1h0m", text)
        self.assertIn("[#.........]", text)
        self.assertIn("source: status line, 30s old", text)

    def test_render_error(self):
        text = render_text(error_report("timeout", "Too slow.", NOW, hint="Retry."), NOW)
        self.assertEqual(text, "Claude usage: unavailable (timeout)\n  Too slow.\n  hint: Retry.")


if __name__ == "__main__":
    unittest.main()
