import json
import os
import shlex
import sys
import tempfile
import unittest
from pathlib import Path

from claude_usage_checker.store import Store

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
FAKE_CLAUDE = HERE / "fake_claude.py"
NOW = 1_790_000_000.0

# Environment variables of the surrounding session that would change behaviour.
AMBIENT_VARS = ("CLAUDE_CODE_REMOTE", "CLAUDE_CONFIG_DIR", "CLAUDE_USAGE_CACHE_DIR", "CLAUDE_USAGE_CLAUDE_BIN",
                "NO_COLOR", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_PAYLOAD", "FAKE_CLAUDE_LOG")

posix_only = unittest.skipIf(os.name == "nt", "uses POSIX shell scripts")


def make_fake_claude(directory) -> str:
    """Write an executable `claude` that runs tests/fake_claude.py."""
    path = os.path.join(str(directory), "claude")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(FAKE_CLAUDE))} "$@"\n')
    os.chmod(path, 0o755)
    return path


def read_calls(log_path):
    if not os.path.exists(log_path):
        return []
    with open(log_path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def statusline_payload(session="s1", api_ms=1000, five=(20.0, NOW + 3600), seven=(40.0, NOW + 86400), **extra):
    rate_limits = {}
    if five is not None:
        rate_limits["five_hour"] = {"used_percentage": five[0], "resets_at": five[1]}
    if seven is not None:
        rate_limits["seven_day"] = {"used_percentage": seven[0], "resets_at": seven[1]}
    rate_limits.update(extra)
    return {"session_id": session, "cost": {"total_api_duration_ms": api_ms}, "rate_limits": rate_limits}


class TempStoreCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.store = Store(self.tmp / "cache")
