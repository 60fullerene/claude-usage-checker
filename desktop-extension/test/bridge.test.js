import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { applyReport, createBridge, needRefresh, sanitizeReport } from '../server/lib/bridge.js';
import { Store } from '../server/lib/store.js';

const NOW = 1_790_000_000_000;
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

test('needRefresh', () => {
  assert.equal(needRefresh(null, null, NOW), true);
  assert.equal(needRefresh({ attempted_at: NOW - 10_000, fetched_at: null }, null, NOW), false, 'just tried');
  assert.equal(needRefresh({ attempted_at: NOW - 60_000, fetched_at: null }, null, NOW), true, 'no data yet');
  const fresh = { attempted_at: NOW - 60_000, fetched_at: NOW - 60_000 };
  assert.equal(needRefresh(fresh, null, NOW), false);
  assert.equal(needRefresh(fresh, NOW - 5_000, NOW), true, 'Claude asked for newer data');
  assert.equal(needRefresh(fresh, NOW - 120_000, NOW), false, 'demand already served');
  assert.equal(needRefresh({ attempted_at: NOW - 60_000, fetched_at: NOW - 200_000 }, null, NOW), true, 'periodic refresh');
});

test('sanitizeReport keeps only known fields and bounded strings', () => {
  const report = sanitizeReport(
    {
      fetched_at: NOW + 999_999,
      via: 'direct',
      extension_version: '0.2.0',
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

test('applyReport keeps the last good reading when a refresh fails', () => {
  const good = applyReport(null, sanitizeReport({ fetched_at: NOW - 1000, orgs: [{ uuid: 'u', usage: { limits: [] } }] }, NOW), NOW);
  assert.equal(good.fetched_at, NOW - 1000);
  assert.equal(good.error, null);
  const failed = applyReport(good, sanitizeReport({ orgs: [], error: { code: 'LOGIN', message: 'sign in' } }, NOW + 60_000), NOW + 60_000);
  assert.equal(failed.fetched_at, NOW - 1000);
  assert.equal(failed.orgs.length, 1);
  assert.deepEqual(failed.error, { code: 'LOGIN', message: 'sign in' });
  assert.equal(failed.attempted_at, NOW + 60_000);
  const empty = applyReport(good, sanitizeReport({ orgs: [{ uuid: 'c', name: 'Console', error: 'HTTP 403' }] }, NOW), NOW);
  assert.equal(empty.error.code, 'NO_USAGE');
  assert.match(empty.error.message, /Console: HTTP 403/);
});

let tmp;
let store;
let bridges = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-bridge-'));
  store = new Store(tmp);
});
afterEach(async () => {
  await Promise.all(bridges.map((bridge) => bridge.close()));
  bridges = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function startBridge(port = 0) {
  // Port 0 is not allowed by the manifest but lets the OS pick a free port for tests.
  const bridge = createBridge({ port: await freePort(port), store, version: 'test', clock: () => NOW });
  bridges.push(bridge);
  await waitFor(() => bridge.listening);
  return bridge;
}

function freePort(port) {
  if (port) return port;
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address();
      probe.close(() => resolve(picked));
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

function request(port, { method = 'GET', path: urlPath = '/v1/state', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('bridge answers state checks and stores reports from extensions', async () => {
  const port = await freePort();
  await startBridge(port);
  const state = await request(port, { headers: { origin: EXTENSION } });
  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { service: 'claude-usage-checker', version: 'test', need_refresh: true });
  assert.equal(store.readBridgeSeenAt(), NOW);

  const report = { fetched_at: NOW, orgs: [{ uuid: 'u', name: 'Personal', usage: { limits: [{ kind: 'session', percent: 5 }] } }] };
  const posted = await request(port, { method: 'POST', path: '/v1/report', headers: { origin: EXTENSION }, body: report });
  assert.equal(posted.status, 204);
  assert.equal(store.readSnapshot().orgs[0].name, 'Personal');
  assert.equal((await request(port, { headers: { origin: EXTENSION } })).body.need_refresh, false);
});

test('bridge rejects web pages, foreign hosts, anonymous reports and junk', async () => {
  const port = await freePort();
  await startBridge(port);
  assert.equal((await request(port, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(port, { headers: { origin: 'null' } })).status, 403);
  assert.equal((await request(port, { headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await request(port, { method: 'POST', path: '/v1/report', body: { orgs: [] } })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/v1/report', headers: { origin: EXTENSION }, body: '{nope' })).status, 400);
  assert.equal((await request(port, { method: 'POST', path: '/v1/report', headers: { origin: EXTENSION }, body: '"x"' })).status, 400);
  assert.equal((await request(port, { path: '/other' })).status, 404);
  const big = { orgs: [{ usage: { pad: 'x'.repeat(1 << 20) } }] };
  assert.equal((await request(port, { method: 'POST', path: '/v1/report', headers: { origin: EXTENSION }, body: big })).status, 413);
  assert.equal(store.readSnapshot(), null);
});

test('a second copy waits for the port instead of failing', async () => {
  const port = await freePort();
  const first = await startBridge(port);
  const second = createBridge({ port, store, version: 'test' });
  bridges.push(second);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(first.listening, true);
  assert.equal(second.listening, false);
});

test('an unwritable cache does not take the state endpoint down', async () => {
  const port = await freePort();
  const failing = Object.assign(Object.create(Store.prototype), store, {
    writeBridgeSeenAt() {
      throw new Error('read-only file system');
    },
  });
  const bridge = createBridge({ port, store: failing, version: 'test', clock: () => NOW });
  bridges.push(bridge);
  await waitFor(() => bridge.listening);
  const state = await request(port, { headers: { origin: EXTENSION } });
  assert.equal(state.status, 200);
  assert.equal(state.body.need_refresh, true);
});
