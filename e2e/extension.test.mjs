// End-to-end: the unpacked browser extension in Chromium, a mock claude.ai
// (cookie-authenticated, like the real one) and the real Claude Desktop
// extension server, driven over MCP like Claude Desktop would.
//
// Needs Playwright with Chromium: `npm i --no-save playwright && npx playwright install chromium`
// (or a global install). Skipped otherwise.

import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
// Point these at unpacked dist/ files to test the release artifacts instead of the sources.
const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR || path.join(ROOT, 'browser-extension');
const SERVER_ENTRY = process.env.E2E_SERVER_ENTRY || path.join(ROOT, 'desktop-extension', 'server', 'index.js');
const SESSION = 'test-session-cookie';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const paths of [undefined, [execSync('npm root -g').toString().trim()]]) {
    try {
      return require(require.resolve('playwright', paths && { paths }));
    } catch {
      // try the next location
    }
  }
  return null;
}
const playwright = loadPlaywright();
const skip = !playwright && 'Playwright not installed';

const freePort = () =>
  new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, { timeout = 20_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// ---- mock claude.ai ------------------------------------------------------------

const seen = []; // every request claude.ai received
function startMockClaude(port) {
  const usage = () => {
    const now = Date.now();
    const at = (ms) => new Date(now + ms).toISOString();
    return {
      five_hour: { utilization: 35, resets_at: at(2 * 3600_000) },
      seven_day: { utilization: 60, resets_at: at(3 * 86400_000) },
      limits: [
        { kind: 'session', group: 'session', percent: 35, severity: 'normal', resets_at: at(2 * 3600_000), scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 60, severity: 'normal', resets_at: at(3 * 86400_000), scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 80, severity: 'warning', resets_at: at(3 * 86400_000), scope: { model: { display_name: 'Fable' } } },
      ],
    };
  };
  const server = http.createServer((req, res) => {
    const signedIn = (req.headers.cookie || '').includes(`sessionKey=${SESSION}`);
    seen.push({ path: req.url, signedIn });
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url.startsWith('/api/') && !signedIn) return json(401, { error: 'unauthorized' });
    if (req.url === '/api/organizations') {
      return json(200, [
        { uuid: 'org-1', name: 'Personal', capabilities: ['chat', 'claude_max'] },
        { uuid: 'org-console', name: 'Console', capabilities: ['api'] },
      ]);
    }
    if (req.url === '/api/organizations/org-1/usage') return json(200, usage());
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ---- the Claude Desktop extension server, spoken to over stdio -------------------

function startDesktopServer(port, cacheDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, CLAUDE_USAGE_PORT: String(port), CLAUDE_USAGE_CACHE_DIR: cacheDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let id = 0;
  child.rpc = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  child.usage = async (args = {}) => (await child.rpc('tools/call', { name: 'get_claude_usage', arguments: args })).result.structuredContent;
  child.ready = child.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  return child;
}

function connectedBrowsers(port) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: '/v1/status' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body).connected));
      })
      .on('error', () => resolve(0));
  });
}

// ---- the test ------------------------------------------------------------------

let context;
let desktop;
let mock;
let tmp;
let worker;
let bridgePort;
let mockPort;

before(async () => {
  if (!playwright) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-e2e-'));
  [bridgePort, mockPort] = [await freePort(), await freePort()];
  mock = await startMockClaude(mockPort);
  desktop = startDesktopServer(bridgePort, path.join(tmp, 'cache'));
  await desktop.ready;

  context = await playwright.chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', // the full browser in new headless mode, which can load extensions
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // The chrome.* APIs are bound to the worker a moment after it starts.
  await until(() => worker.evaluate(() => typeof chrome.storage === 'object'), { what: 'extension APIs' });
  await context.addCookies([{ name: 'sessionKey', value: SESSION, url: `http://127.0.0.1:${mockPort}`, sameSite: 'Lax', httpOnly: true }]);
  // Point the extension at the test port and the mock claude.ai; it reconnects on the change.
  await worker.evaluate(
    ([port, origin]) => chrome.storage.local.set({ settings: { port, claudeOrigin: origin } }),
    [bridgePort, `http://127.0.0.1:${mockPort}`],
  );
});

after(async () => {
  await context?.close();
  desktop?.kill();
  mock?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('connected, and claude.ai is left alone until Claude asks', { skip }, async () => {
  await until(async () => (await connectedBrowsers(bridgePort)) === 1, { what: 'the extension to connect' });
  await sleep(3000);
  assert.deepEqual(seen, [], 'no background reads of claude.ai');
});

test('Claude asks: the browser reads claude.ai right then and the answer comes back', { skip }, async () => {
  const started = Date.now();
  const report = await desktop.usage();
  assert.ok(Date.now() - started < 5000, 'answered within seconds');
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.stale, false);
  assert.equal(report.five_hour.remaining_percent, 65);
  assert.equal(report.seven_day.remaining_percent, 40);
  assert.equal(report.model_windows.Fable.remaining_percent, 20);
  assert.equal(report.organization.name, 'Personal');
  // One list + one usage request, with the sign-in cookie; the API-only org was skipped.
  assert.deepEqual(seen.map((r) => r.path), ['/api/organizations', '/api/organizations/org-1/usage']);
  assert.ok(seen.every((r) => r.signedIn));
});

test('asking again right away reuses the reading; max_age_seconds 0 reads again', { skip }, async () => {
  await desktop.usage();
  assert.equal(seen.length, 2);
  await desktop.usage({ max_age_seconds: 0 });
  assert.equal(seen.length, 4);
});

test('the popup shows the connection and reads on demand', { skip }, async () => {
  const extensionId = new URL(worker.url()).host;
  const before = seen.length;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(async () => (await page.locator('#desktop').getAttribute('class')) === 'ok', { what: 'desktop status' });
  assert.match(await page.locator('#desktop').innerText(), /Connected to Claude Desktop/);
  await until(async () => (await page.locator('.org').count()) === 1, { what: 'org card' });
  assert.match(await page.locator('.org').innerText(), /Personal[\s\S]*65% left[\s\S]*40% left/);
  await until(async () => /sent to Claude Desktop/.test(await page.locator('#claude').innerText()), { what: 'delivery note' });
  assert.ok(seen.length > before, 'opening the popup read claude.ai');
  await page.close();
});

test('signed out of claude.ai: Claude is told why and gets the last reading', { skip }, async () => {
  await context.clearCookies();
  const report = await desktop.usage({ max_age_seconds: 0 });
  assert.equal(report.ok, true);
  assert.equal(report.stale, true);
  assert.match(report.warnings.join(' '), /HTTP 401[\s\S]*Sign in to claude\.ai/);
  await context.addCookies([{ name: 'sessionKey', value: SESSION, url: `http://127.0.0.1:${mockPort}`, sameSite: 'Lax' }]);
});

test('Claude Desktop closed: the extension notices, and claude.ai is never read', { skip }, async () => {
  desktop.stdin.end();
  await new Promise((resolve) => desktop.once('exit', resolve));
  await until(async () => (await worker.evaluate(() => chrome.storage.local.get('status'))).status?.desktop === 'disconnected', { what: 'disconnected status' });
  const before = seen.length;
  await worker.evaluate(() => chrome.alarms.create('reconnect', { when: Date.now() + 50, periodInMinutes: 1 }));
  await sleep(2000);
  assert.equal(seen.length, before);
});

test('Claude Desktop back: the extension reconnects on its own', { skip }, async () => {
  desktop = startDesktopServer(bridgePort, path.join(tmp, 'cache'));
  await desktop.ready;
  await worker.evaluate(() => chrome.alarms.create('reconnect', { when: Date.now() + 50, periodInMinutes: 1 }));
  await until(async () => (await connectedBrowsers(bridgePort)) === 1, { what: 'reconnection' });
  const report = await desktop.usage({ max_age_seconds: 0 });
  assert.equal(report.stale, false);
  assert.equal(report.five_hour.remaining_percent, 65);
});

test('changing the port while a connection attempt is in flight ends up on the new port', { skip }, async () => {
  // A fresh browser profile, so no earlier connection's retry timer can paper over the race.
  const fresh = await playwright.chromium.launchPersistentContext(path.join(tmp, 'profile-race'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  // A listener that keeps the extension's first connection check busy for 2 s.
  const slowPort = await freePort();
  const slow = http.createServer((req, res) => setTimeout(() => res.end('{}'), 2000));
  await new Promise((resolve) => slow.listen(slowPort, '127.0.0.1', resolve));
  try {
    const sw = fresh.serviceWorkers()[0] ?? (await fresh.waitForEvent('serviceworker'));
    await until(() => sw.evaluate(() => typeof chrome.storage === 'object'), { what: 'extension APIs' });
    const setPort = (port) => sw.evaluate((p) => chrome.storage.local.set({ settings: { port: p } }), port);
    const before = await connectedBrowsers(bridgePort);
    await setPort(slowPort);
    await sleep(300);
    await setPort(bridgePort); // while the check against slowPort is still running
    await until(async () => (await connectedBrowsers(bridgePort)) === before + 1, { timeout: 10_000, what: 'connection on the new port' });
  } finally {
    slow.close();
    await fresh.close();
  }
});
