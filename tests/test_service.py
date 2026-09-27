import unittest

from claude_usage_checker.claude_source import SourceError
from claude_usage_checker.service import get_report, merge_windows
from claude_usage_checker.usage import ClaudeSnapshot, Window

from .helpers import NOW, TempStoreCase, statusline_payload


class FakeQuery:
    def __init__(self, snapshot=None, error=None):
        self.snapshot = snapshot
        self.error = error
        self.calls = 0

    def __call__(self, timeout):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.snapshot


def claude_snapshot(observed_at, five=30.0, seven=60.0):
    windows = {}
    if five is not None:
        windows["five_hour"] = Window(five, observed_at + 3600, observed_at, "claude")
    if seven is not None:
        windows["seven_day"] = Window(seven, observed_at + 86400, observed_at, "claude")
    return ClaudeSnapshot(observed_at, windows, subscription_type="max")


MUST_NOT_RUN = SourceError("unexpected", "the live query should not have run")


class GetReportTest(TempStoreCase):
    def report(self, now, query, **kwargs):
        return get_report(store=self.store, query=query, clock=lambda: now, **kwargs)

    def test_fresh_cache_answers_without_a_query(self):
        self.store.record_statusline(statusline_payload(), NOW)
        query = FakeQuery(error=MUST_NOT_RUN)
        report = self.report(NOW + 10, query)
        self.assertEqual(query.calls, 0)
        self.assertTrue(report["ok"])
        self.assertFalse(report["stale"])
        self.assertEqual(report["five_hour"]["source"], "statusline")
        self.assertEqual(report["five_hour"]["remaining_percent"], 80.0)

    def test_stale_cache_triggers_a_query(self):
        self.store.record_statusline(statusline_payload(), NOW)
        query = FakeQuery(claude_snapshot(NOW + 500))
        report = self.report(NOW + 500, query)
        self.assertEqual(query.calls, 1)
        self.assertEqual(report["five_hour"]["source"], "claude")
        self.assertEqual(report["five_hour"]["used_percent"], 30.0)
        self.assertEqual(report["subscription_type"], "max")
        self.assertEqual(self.store.load_claude_snapshot().observed_at, NOW + 500)

    def test_window_past_its_reset_triggers_a_query(self):
        self.store.record_statusline(statusline_payload(five=(90.0, NOW + 50)), NOW)
        query = FakeQuery(claude_snapshot(NOW + 60))
        self.report(NOW + 60, query)
        self.assertEqual(query.calls, 1)

    def test_recent_query_counts_as_fresh(self):
        self.store.save_claude_snapshot(claude_snapshot(NOW, five=None))
        query = FakeQuery(error=MUST_NOT_RUN)
        report = self.report(NOW + 30, query)
        self.assertEqual(query.calls, 0)
        self.assertIsNone(report["five_hour"])
        self.assertEqual(report["seven_day"]["used_percent"], 60.0)

    def test_failed_refresh_falls_back_to_the_cache(self):
        self.store.record_statusline(statusline_payload(), NOW)
        report = self.report(NOW + 500, FakeQuery(error=SourceError("timeout", "Too slow.")))
        self.assertTrue(report["ok"])
        self.assertTrue(report["stale"])
        self.assertIn("(timeout): Too slow.", report["warnings"][0])
        self.assertEqual(report["five_hour"]["age_seconds"], 500)

    def test_failed_refresh_without_cache_is_an_error(self):
        error = SourceError("claude_not_found", "No claude.", hint="Install it.")
        report = self.report(NOW, FakeQuery(error=error))
        self.assertFalse(report["ok"])
        self.assertEqual(report["error"], {"code": "claude_not_found", "message": "No claude.", "hint": "Install it."})

    def test_query_without_primary_windows(self):
        report = self.report(NOW, FakeQuery(claude_snapshot(NOW, five=None, seven=None)))
        self.assertEqual(report["error"]["code"], "no_data")

    def test_cache_source_never_queries(self):
        query = FakeQuery(error=MUST_NOT_RUN)
        empty = self.report(NOW, query, source="cache")
        self.assertEqual(empty["error"]["code"], "no_data")
        self.store.record_statusline(statusline_payload(), NOW)
        old = self.report(NOW + 9999, query, source="cache")
        self.assertTrue(old["ok"])
        self.assertTrue(old["stale"])
        self.assertEqual(query.calls, 0)

    def test_claude_source_always_queries(self):
        self.store.record_statusline(statusline_payload(), NOW)
        query = FakeQuery(claude_snapshot(NOW + 1))
        self.assertEqual(self.report(NOW + 1, query, source="claude")["five_hour"]["source"], "claude")
        self.assertEqual(query.calls, 1)
        failed = self.report(NOW + 2, FakeQuery(error=SourceError("timeout", "Too slow.")), source="claude")
        self.assertFalse(failed["ok"])

    def test_unknown_source(self):
        with self.assertRaises(ValueError):
            self.report(NOW, FakeQuery(), source="web")


class MergeWindowsTest(unittest.TestCase):
    def test_latest_reading_wins(self):
        statusline = {"five_hour": Window(10.0, None, NOW + 100, "statusline")}
        older = ClaudeSnapshot(NOW, {"five_hour": Window(20.0, None, NOW, "claude")})
        newer = ClaudeSnapshot(NOW + 200, {"five_hour": Window(30.0, None, NOW + 200, "claude")})
        self.assertEqual(merge_windows(statusline, older)["five_hour"].used_percent, 10.0)
        self.assertEqual(merge_windows(statusline, newer)["five_hour"].used_percent, 30.0)
        self.assertEqual(merge_windows(statusline, None), statusline)


if __name__ == "__main__":
    unittest.main()
