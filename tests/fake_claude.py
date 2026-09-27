"""Stand-in for the `claude` CLI that speaks its stream-json control protocol.

FAKE_CLAUDE_MODE picks the behaviour:
  success      answer get_usage with FAKE_CLAUDE_PAYLOAD (JSON) or a default payload
  noise        print unrelated output first, then answer like success
  unavailable  answer with rate_limits_available: false
  unsupported  reject the request like a Claude Code without get_usage
  exit         print a login error and exit 1 without answering
  hang         read input until it ends, never answering
Each run appends {"argv": [...], "env": {...}} to FAKE_CLAUDE_LOG if set.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

LOGGED_ENV = ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "KEEP_ME")


def iso_in(seconds):
    return datetime.fromtimestamp(time.time() + seconds, tz=timezone.utc).isoformat()


def default_payload():
    return {
        "session": {"total_cost_usd": 0, "total_api_duration_ms": 0, "total_duration_ms": 12,
                    "total_lines_added": 0, "total_lines_removed": 0, "model_usage": {}},
        "subscription_type": "max",
        "rate_limits_available": True,
        "rate_limits": {
            "five_hour": {"utilization": 12.0, "resets_at": iso_in(3 * 3600)},
            "seven_day": {"utilization": 34.0, "resets_at": iso_in(4 * 86400)},
            "seven_day_opus": None,
            "seven_day_sonnet": {"utilization": 3.0, "resets_at": iso_in(4 * 86400)},
            "model_scoped": [{"display_name": "Fable", "utilization": 21.0, "resets_at": iso_in(4 * 86400)}],
            "extra_usage": {"is_enabled": False, "monthly_limit": None, "used_credits": None,
                            "utilization": None, "currency": None},
        },
        "behaviors": None,
    }


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    mode = os.environ.get("FAKE_CLAUDE_MODE", "success")
    log = os.environ.get("FAKE_CLAUDE_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in LOGGED_ENV}}) + "\n")

    if mode == "exit":
        print("Invalid API key · Please run /login", flush=True)
        print("stderr detail", file=sys.stderr, flush=True)
        return 1

    for line in sys.stdin:
        message = json.loads(line)
        if message.get("type") != "control_request" or mode == "hang":
            continue
        request_id = message["request_id"]
        if mode == "noise":
            print("this is not JSON", flush=True)
            emit({"type": "system", "subtype": "commands_changed", "commands": []})
            emit({"type": "control_response",
                  "response": {"subtype": "success", "request_id": "someone-else", "response": {}}})
        if mode == "unsupported" or message["request"].get("subtype") != "get_usage":
            emit({"type": "control_response", "response": {
                "subtype": "error", "request_id": request_id,
                "error": f"Unsupported control request subtype: {message['request'].get('subtype')}"}})
            continue
        if "FAKE_CLAUDE_PAYLOAD" in os.environ:
            payload = json.loads(os.environ["FAKE_CLAUDE_PAYLOAD"])
        else:
            payload = default_payload()
        if mode == "unavailable":
            payload.update(subscription_type=None, rate_limits_available=False, rate_limits=None)
        emit({"type": "control_response",
              "response": {"subtype": "success", "request_id": request_id, "response": payload}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
