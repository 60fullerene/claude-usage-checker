// Runs the real entry point: HTTP report in, MCP tool call out.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';

import { McpServer } from '../server/lib/mcp.js';
import { Store } from '../server/lib/store.js';
import { createToolHandler, TOOL } from '../server/lib/tool.js';

const ENTRY = new URL('../server/index.js', import.meta.url).pathname;
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/v1/report', headers: { origin: EXTENSION, 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let child;
let port;
let tmp;
let replies;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-server-'));
  port = await freePort();
  child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, CLAUDE_USAGE_CACHE_DIR: tmp, CLAUDE_USAGE_PORT: String(port), CLAUDE_USAGE_ORGANIZATION: '${user_config.organization}' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  replies = (id) => new Promise((resolve) => pending.set(id, resolve));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
});

after(() => {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function rpc(id, method, params) {
  const reply = replies(id);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return reply;
}

test('end to end: browser report in, get_claude_usage out', async () => {
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'claude-usage');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const before = await rpc(2, 'tools/call', { name: 'get_claude_usage', arguments: {} });
  assert.equal(before.result.isError, true);
  assert.equal(before.result.structuredContent.error.code, 'no_data');

  const now = Date.now();
  const usage = {
    limits: [
      { kind: 'session', percent: 42, resets_at: new Date(now + 3_600_000).toISOString() },
      { kind: 'weekly_all', percent: 10, resets_at: new Date(now + 86_400_000).toISOString() },
    ],
  };
  // The placeholder organization setting above must be ignored, not treated as a filter.
  assert.equal(await until(() => post(port, { fetched_at: now, via: 'direct', orgs: [{ uuid: 'org-1', name: 'Personal', usage }] })), 204);

  const after = await rpc(3, 'tools/call', { name: 'get_claude_usage', arguments: {} });
  const report = after.result.structuredContent;
  assert.equal(after.result.isError, false);
  assert.equal(report.five_hour.remaining_percent, 58);
  assert.equal(report.seven_day.remaining_percent, 90);
  assert.equal(report.organization.name, 'Personal');
  assert.deepEqual(JSON.parse(after.result.content[0].text), report);
});

test('exits and frees the port when Claude Desktop closes stdin', async () => {
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.end();
  assert.equal(await exited, 0);
  await new Promise((resolve, reject) => {
    const probe = http.createServer().once('error', reject).listen(port, '127.0.0.1', () => probe.close(resolve));
  });
});

test('tool handler validates arguments and records demand for fresher data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-tool-'));
  const store = new Store(dir);
  const server = new McpServer({ info: { name: 't', version: '0' }, instructions: '', tools: [TOOL], callTool: createToolHandler({ store, clock: () => 5_000_000 }) });
  const call = async (args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_claude_usage', arguments: args } })).result;
  for (const bad of [{ bogus: 1 }, { max_age_seconds: -1 }, { max_age_seconds: 'soon' }, { organization: 5 }]) {
    assert.equal((await call(bad)).isError, true, JSON.stringify(bad));
  }
  assert.equal(store.readDemandAt(), null);
  await call({});
  assert.equal(store.readDemandAt(), 5_000_000);
  fs.rmSync(dir, { recursive: true, force: true });
});
