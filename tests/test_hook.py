import json

from claude_usage_checker.hook import run_hook
from claude_usage_checker.usage import Window, build_report, error_report

from .helpers import NOW, TempStoreCase


def report_with(five_left, seven_left=80.0, five_resets=NOW + 3600, observed_at=NOW):
    windows = {
        "five_hour": Window(100.0 - five_left, five_resets, observed_at, "statusline"),
        "seven_day": Window(100.0 - seven_left, NOW + 86400, observed_at, "statusline"),
    }
    return build_report(windows, None, NOW, 120)


class RunHookTest(TempStoreCase):
    def hook(self, report, event="PostToolUse", session="s1", **kwargs):
        calls = []

        def get_report(**options):
            calls.append(options)
            return report

        stdin = json.dumps({"hook_event_name": event, "session_id": session})
        output = run_hook(stdin, store=self.store, clock=lambda: NOW, get_report=get_report, **kwargs)
        self.calls = calls
        if output is None:
            return None
        data = json.loads(output)["hookSpecificOutput"]
        self.assertEqual(data["hookEventName"], event)
        return data["additionalContext"]

    def test_always_reports_without_threshold(self):
        text = self.hook(report_with(76.5), event="SessionStart", source="cache", max_age=30)
        self.assertEqual(text, "Claude usage limits: 5h: 76.5% left (resets in 1h0m) | 7d: 80% left (resets in 1d0h).")
        self.assertEqual(self.calls[0]["source"], "cache")
        self.assertEqual(self.calls[0]["max_age"], 30)

    def test_ignores_events_without_context(self):
        for event in ("Stop", "Notification", None):
            self.assertIsNone(self.hook(report_with(5), event=event))

    def test_silent_when_usage_is_unavailable(self):
        self.assertIsNone(self.hook(error_report("no_data", "nothing", NOW), event="SessionStart"))

    def test_silent_on_invalid_input(self):
        self.assertIsNone(run_hook("not json", store=self.store, get_report=lambda **_: report_with(5)))
        self.assertIsNone(run_hook("[]", store=self.store, get_report=lambda **_: report_with(5)))

    def test_warn_below_only_when_low(self):
        self.assertIsNone(self.hook(report_with(50), warn_below=20))
        text = self.hook(report_with(15), warn_below=20)
        self.assertIn("running low: 5-hour limit has 15% left (resets in 1h0m)", text)
        self.assertIn("Current status: 5h: 15% left", text)

    def test_warns_once_then_again_every_5_points(self):
        remaining = {left: self.hook(report_with(left), warn_below=20) for left in (15, 14, 12, 10, 9.5, 5)}
        self.assertEqual([left for left, text in remaining.items() if text], [15, 10, 5])

    def test_warns_again_for_a_new_window(self):
        self.assertIsNotNone(self.hook(report_with(15), warn_below=20))
        self.assertIsNone(self.hook(report_with(15, five_resets=NOW + 3600 + 60), warn_below=20))  # jitter
        self.assertIsNotNone(self.hook(report_with(15, five_resets=NOW + 5 * 3600), warn_below=20))

    def test_sessions_are_independent(self):
        self.assertIsNotNone(self.hook(report_with(15), warn_below=20, session="a"))
        self.assertIsNotNone(self.hook(report_with(15), warn_below=20, session="b"))
        self.assertIsNone(self.hook(report_with(15), warn_below=20, session="a"))

    def test_weekly_window_warning(self):
        text = self.hook(report_with(60, seven_left=8), warn_below=10)
        self.assertIn("7-day limit has 8% left", text)
        self.assertNotIn("5-hour limit has", text)

    def test_mentions_stale_data(self):
        text = self.hook(report_with(50, observed_at=NOW - 900), event="UserPromptSubmit")
        self.assertTrue(text.endswith("(The last reading is 15m old.)"))
