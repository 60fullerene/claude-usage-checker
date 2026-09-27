import io
import json
import unittest

from claude_usage_checker.mcp_server import PROTOCOL_VERSIONS, TOOL_NAME, Server, serve

REPORT = {"ok": True, "summary": "5h: 80% left | 7d: 60% left", "five_hour": {"remaining_percent": 80.0}}


def request(method, params=None, request_id=1):
    message = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return message


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.report = REPORT

        def get_report(**options):
            self.calls.append(options)
            if isinstance(self.report, Exception):
                raise self.report
            return self.report

        self.server = Server(max_age=60, timeout=5, get_report=get_report)

    def initialize(self, version="2025-06-18"):
        return self.server.handle(request("initialize", {"protocolVersion": version, "capabilities": {}}))["result"]

    def call(self, arguments=None, name=TOOL_NAME):
        return self.server.handle(request("tools/call", {"name": name, "arguments": arguments or {}}))

    def test_initialize_negotiates_the_version(self):
        result = self.initialize("2025-06-18")
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertEqual(result["capabilities"], {"tools": {"listChanged": False}})
        self.assertEqual(result["serverInfo"]["name"], "claude-usage-checker")
        self.assertEqual(self.initialize("1999-01-01")["protocolVersion"], PROTOCOL_VERSIONS[0])

    def test_tools_list(self):
        [tool] = self.server.handle(request("tools/list"))["result"]["tools"]
        self.assertEqual(tool["name"], TOOL_NAME)
        self.assertEqual(tool["inputSchema"]["type"], "object")
        self.assertTrue(tool["annotations"]["readOnlyHint"])

    def test_call_returns_the_report(self):
        self.initialize("2025-06-18")
        result = self.call()["result"]
        self.assertFalse(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"]), REPORT)
        self.assertEqual(result["structuredContent"], REPORT)
        self.assertEqual(self.calls, [{"source": "auto", "max_age": 60, "timeout": 5, "store": None}])

    def test_no_structured_content_for_old_clients(self):
        self.initialize("2024-11-05")
        self.assertNotIn("structuredContent", self.call()["result"])

    def test_arguments_are_passed_on(self):
        self.call({"source": "cache", "max_age_seconds": 5})
        self.assertEqual(self.calls[0]["source"], "cache")
        self.assertEqual(self.calls[0]["max_age"], 5.0)

    def test_invalid_arguments(self):
        for arguments in ({"source": "web"}, {"max_age_seconds": -1}, {"max_age_seconds": "soon"}, {"extra": 1}):
            result = self.call(arguments)["result"]
            self.assertTrue(result["isError"], arguments)
        self.assertEqual(self.calls, [])

    def test_unavailable_usage_is_a_tool_error(self):
        self.report = {"ok": False, "summary": "Claude usage unavailable: no login"}
        self.assertTrue(self.call()["result"]["isError"])

    def test_internal_errors_are_reported(self):
        self.report = RuntimeError("boom")
        result = self.call()["result"]
        self.assertTrue(result["isError"])
        self.assertIn("boom", result["content"][0]["text"])

    def test_protocol_errors(self):
        self.assertEqual(self.call(name="other")["error"]["code"], -32602)
        self.assertEqual(self.server.handle(request("resources/list"))["error"]["code"], -32601)
        self.assertEqual(self.server.handle("junk")["error"]["code"], -32600)
        self.assertEqual(self.server.handle(request("ping"))["result"], {})

    def test_notifications_and_responses_get_no_reply(self):
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "id": 7, "result": {}}))


class ServeTest(unittest.TestCase):
    def test_line_protocol(self):
        lines = [
            json.dumps(request("initialize", {"protocolVersion": "2025-06-18"}, 1)),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            "",
            "{broken",
            json.dumps([request("ping", request_id=2), request("tools/list", request_id=3)]),
        ]
        stdout = io.StringIO()
        serve(io.StringIO("\n".join(lines) + "\n"), stdout, get_report=lambda **_: REPORT)
        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["id"], 1)
        self.assertEqual(replies[1]["error"]["code"], -32700)
        self.assertEqual([r["id"] for r in replies[2]], [2, 3])


if __name__ == "__main__":
    unittest.main()
