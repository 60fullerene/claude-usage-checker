import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { applyReport, createBridge, requestRefresh, sanitizeReport } from '../server/lib/bridge.js';
import { Store } from '../server/lib/store.js';
import { connectWs, EXTENSION } from './ws-client.js';

const NOW = 1_790_000_000_000;
const USAGE = { limits: [{ kind: 'session', percent: 5 }, { kind: 'weekly_all', percent: 7 }] };

test('sanitizeReport keeps only known fields and bounded strings', () => {
  const report = sanitizeReport(
    {
      type: 'report',
      id: 'x',
      fetched_at: NOW + 999_999,
      via: 'direct',
      extension_version: '0.3.0',
      orgs: [{ uuid: 'u', name: 'x'.repeat(500), usage: { limits: [] }, secret: 'nope' }, 'junk', { uuid: 'v', usage: [] }],
    },
    NOW,
  );
  assert.equal(report.fetchedAt, NOW, 'future timestamps are clamped');
  assert.equal(report.orgs.length, 2);
  assert.equal(report.orgs[0].name.length, 200);
  assert.equal('secret' in report.orgs[0], false);
  assert.equal(report.orgs[1].usage, null);
  assert.equal(sanitizeReport([], NOW), null);
});

test('applyReport keeps the last good reading when a read fails', () => {
  const good = applyReport(null, sanitizeReport({ fetched_at: NOW - 1000, orgs: [{ uuid: 'u', usage: { limits: [] } }] }, NOW), NOW);
  assert.equal(good.fetched_at, NOW - 1000);
  assert.equal(good.error, null);
  const failed = applyReport(good, sanitizeReport({ orgs: [], error: { code: 'LOGIN', message: 'sign in' } }, NOW + 60_000), NOW + 60_000);
  assert.equal(failed.fetched_at, NOW - 1000);
  assert.equal(failed.orgs.length, 1);
  assert.deepEqual(failed.error, { code: 'LOGIN', message: 'sign in' });
  const empty = applyReport(good, sanitizeReport({ orgs: [{ uuid: 'c', name: 'Console', error: 'HTTP 403' }] }, NOW), NOW);
  assert.equal(empty.error.code, 'NO_USAGE');
  assert.match(empty.error.message, /Console: HTTP 403/);
});

let tmp;
let store;
let bridges;
let sockets;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-bridge-'));
  store = new Store(tmp);
  bridges = [];
  sockets = [];
});
afterEach(async () => {
  for (const socket of sockets) socket.socket.destroy();
  await Promise.all(bridges.map((bridge) => bridge.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startBridge(options = {}) {
  const port = options.port ?? (await freePort());
  const bridge = createBridge({ port, store: options.store ?? store, version: 'test', clock: () => NOW, ...options });
  bridges.push(bridge);
  await waitFor(() => bridge.listening);
  return { bridge, port };
}

async function extension(port) {
  const socket = await connectWs(port);
  sockets.push(socket);
  socket.send({ type: 'hello', extension_version: '0.3.0' });
  return socket;
}

/** Answer the next refresh request like the browser extension would. */
async function answer(socket, report) {
  const request = await socket.next((m) => m.type === 'refresh');
  socket.send({ type: 'report', id: request.id, ...report });
  return request;
}

function http1(port, { method = 'GET', path: urlPath = '/v1/status', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a refresh asks the connected extension and stores its reading', async () => {
  const { port } = await startBridge();
  const socket = await extension(port);
  const refreshing = requestRefresh(port);
  await answer(socket, { fetched_at: NOW, via: 'direct', orgs: [{ uuid: 'u', name: 'Personal', usage: USAGE }] });
  const result = await refreshing;
  assert.equal(result.status, 'ok');
  assert.equal(result.connected, 1);
  assert.equal(store.readSnapshot().orgs[0].name, 'Personal');
});

test('refresh without a connected extension says so right away', async () => {
  const { port } = await startBridge();
  const result = await requestRefresh(port);
  assert.equal(result.status, 'no_extension');
  assert.equal(result.connected, 0);
});

test('concurrent refreshes share one read of claude.ai', async () => {
  const { port } = await startBridge();
  const socket = await extension(port);
  const results = Promise.all([requestRefresh(port), requestRefresh(port), requestRefresh(port)]);
  const request = await socket.next((m) => m.type === 'refresh');
  await new Promise((r) => setTimeout(r, 200)); // let all three requests reach the server
  socket.send({ type: 'report', id: request.id, fetched_at: NOW, orgs: [{ uuid: 'u', usage: USAGE }] });
  assert.deepEqual((await results).map((r) => r.status), ['ok', 'ok', 'ok']);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(socket.messages.filter((m) => m.type === 'refresh').length, 0, 'only one refresh was sent');
});

test('a read that fails is reported as an error and keeps the old reading', async () => {
  const { port } = await startBridge();
  const socket = await extension(port);
  let refreshing = requestRefresh(port);
  await answer(socket, { fetched_at: NOW, orgs: [{ uuid: 'u', usage: USAGE }] });
  await refreshing;
  refreshing = requestRefresh(port);
  await answer(socket, { orgs: [], error: { code: 'LOGIN', message: 'Sign in to claude.ai in this browser.' } });
  const result = await refreshing;
  assert.equal(result.status, 'error');
  assert.match(result.error, /Sign in/);
  assert.equal(store.readSnapshot().fetched_at, NOW);
});

test('an extension that never answers times out; one that drops out is reported', async () => {
  const { port } = await startBridge({ reportTimeoutMs: 200 });
  const silent = await extension(port);
  assert.equal((await requestRefresh(port)).status, 'timeout');
  silent.messages.length = 0;
  const refreshing = requestRefresh(port);
  await silent.next((m) => m.type === 'refresh');
  silent.socket.end(); // the browser goes away without a close frame
  assert.equal((await refreshing).status, 'disconnected');
});

test('the newest connection is asked first, older ones as a fallback', async () => {
  const { port } = await startBridge({ reportTimeoutMs: 300 });
  const older = await extension(port);
  const newer = await extension(port);
  const refreshing = requestRefresh(port);
  await answer(newer, { orgs: [], error: { code: 'LOGIN', message: 'signed out here' } });
  await answer(older, { fetched_at: NOW, orgs: [{ uuid: 'u', usage: USAGE }] });
  assert.equal((await refreshing).status, 'ok');
});

test('unsolicited reports (popup refresh) are stored too', async () => {
  const { port } = await startBridge();
  const socket = await extension(port);
  socket.send({ type: 'report', id: null, fetched_at: NOW, orgs: [{ uuid: 'u', name: 'P', usage: USAGE }] });
  socket.send({ type: 'ping' });
  await socket.next((m) => m.type === 'pong');
  assert.equal(store.readSnapshot().orgs[0].name, 'P');
});

test('web pages, foreign hosts and non-extensions are turned away', async () => {
  const { port } = await startBridge();
  await assert.rejects(connectWs(port, { origin: 'https://evil.example' }), { status: 403 });
  await assert.rejects(connectWs(port, { origin: null }), { status: 403 });
  await assert.rejects(connectWs(port, { host: `evil.example:${port}` }), { status: 421 });
  await assert.rejects(connectWs(port, { path: '/elsewhere' }), { status: 404 });
  assert.equal((await http1(port, { method: 'POST', path: '/v1/refresh', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await http1(port, { method: 'POST', path: '/v1/refresh', headers: { origin: EXTENSION } })).status, 403);
  assert.equal((await http1(port, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await http1(port, { headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await http1(port, { path: '/other' })).status, 404);
  const status = await http1(port, { headers: { origin: EXTENSION } });
  assert.deepEqual(status.body, { service: 'claude-usage-checker', version: 'test', connected: 0 });
});

test('a second copy waits for the port and refreshes go through the first', async () => {
  const { port } = await startBridge();
  const second = createBridge({ port, store, version: 'test' });
  bridges.push(second);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(second.listening, false);
  assert.equal((await requestRefresh(port)).status, 'no_extension');
});

test('refresh reports a port held by something else', async () => {
  const port = await freePort();
  const other = http.createServer((req, res) => res.end('hello')).listen(port, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  const result = await requestRefresh(port);
  assert.equal(result.status, 'unreachable');
  assert.match(result.error, /not this extension/);
  other.close();
  assert.equal((await requestRefresh(port)).status, 'unreachable', 'nothing listening');
});

test('an unwritable cache does not break refreshes', async () => {
  const failing = Object.assign(Object.create(Store.prototype), store, {
    write() {
      throw new Error('read-only file system');
    },
  });
  const { port } = await startBridge({ store: failing });
  const socket = await extension(port);
  const refreshing = requestRefresh(port);
  await answer(socket, { fetched_at: NOW, orgs: [{ uuid: 'u', usage: USAGE }] });
  assert.equal((await refreshing).status, 'ok');
});
