// Runs the real entry point: a tool call asks the (fake) browser extension
// over the WebSocket, and the answer comes back through MCP.

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
import { connectWs } from './ws-client.js';

const ENTRY = new URL('../server/index.js', import.meta.url).pathname;

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let child;
let port;
let tmp;
let rpc;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-server-'));
  port = await freePort();
  child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, CLAUDE_USAGE_CACHE_DIR: tmp, CLAUDE_USAGE_PORT: String(port), CLAUDE_USAGE_ORGANIZATION: '${user_config.organization}' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  rpc = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
});

after(() => {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const usageCall = async (args = {}) => (await rpc('tools/call', { name: 'get_claude_usage', arguments: args })).result;

test('end to end: Claude asks, the browser reads, the answer comes back', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'claude-usage');

  const alone = await usageCall();
  assert.equal(alone.isError, true);
  assert.equal(alone.structuredContent.error.code, 'browser_not_connected');

  // The browser extension connects and answers refresh requests.
  const browser = await until(() => connectWs(port));
  let reads = 0;
  browser.listeners.push((message) => {
    if (message.type !== 'refresh') return;
    reads += 1;
    const now = Date.now();
    browser.send({
      type: 'report',
      id: message.id,
      fetched_at: now,
      via: 'direct',
      orgs: [{ uuid: 'org-1', name: 'Personal', usage: { limits: [
        { kind: 'session', percent: 42, resets_at: new Date(now + 3_600_000).toISOString() },
        { kind: 'weekly_all', percent: 10, resets_at: new Date(now + 86_400_000).toISOString() },
      ] } }],
    });
  });

  const first = await usageCall();
  assert.equal(first.isError, false);
  // The placeholder organization setting was ignored rather than used as a filter.
  assert.equal(first.structuredContent.organization.name, 'Personal');
  assert.equal(first.structuredContent.five_hour.remaining_percent, 58);
  assert.equal(first.structuredContent.seven_day.remaining_percent, 90);
  assert.equal(first.structuredContent.stale, false);
  assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
  assert.equal(reads, 1);

  await usageCall();
  assert.equal(reads, 1, 'a reading from moments ago is reused');
  await usageCall({ max_age_seconds: 0 });
  assert.equal(reads, 2, 'max_age_seconds: 0 reads claude.ai again');

  browser.socket.end();
  const gone = await until(async () => {
    const result = await usageCall({ max_age_seconds: 0 });
    return result.structuredContent.stale && result;
  });
  assert.equal(gone.isError, false, 'the last reading is still returned');
  assert.match(gone.structuredContent.warnings.join(' '), /not connected/);
});

test('exits and frees the port when Claude Desktop closes stdin', async () => {
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.end();
  assert.equal(await exited, 0);
  await new Promise((resolve, reject) => {
    const probe = http.createServer().once('error', reject).listen(port, '127.0.0.1', () => probe.close(resolve));
  });
});

test('tool handler: validates arguments, reuses fresh readings, refreshes old ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-tool-'));
  const store = new Store(dir);
  const now = 5_000_000_000;
  const refreshes = [];
  const handler = createToolHandler({
    store,
    port: 1234,
    clock: () => now,
    refresh: async (port) => {
      refreshes.push(port);
      return { status: 'no_extension' };
    },
  });
  const server = new McpServer({ info: { name: 't', version: '0' }, instructions: '', tools: [TOOL], callTool: handler });
  const call = async (args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_claude_usage', arguments: args } })).result;

  for (const bad of [{ bogus: 1 }, { max_age_seconds: -1 }, { max_age_seconds: 'soon' }, { organization: 5 }]) {
    assert.equal((await call(bad)).isError, true, JSON.stringify(bad));
  }
  assert.deepEqual(refreshes, [], 'invalid calls do not reach the browser');

  store.write('browser-usage.json', { fetched_at: now - 30_000, orgs: [{ uuid: 'u', name: 'P', usage: { limits: [{ kind: 'session', percent: 1 }] } }] });
  assert.equal((await call({})).structuredContent.stale, false);
  assert.deepEqual(refreshes, [], '30 s old is fresh enough by default');
  const old = (await call({ max_age_seconds: 10 })).structuredContent;
  assert.deepEqual(refreshes, [1234]);
  assert.equal(old.stale, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
