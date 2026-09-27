// End-to-end: the unpacked browser extension in Chromium reads a mock claude.ai
// (cookie-authenticated, like the real one) and reports to the real Claude
// Desktop extension server, which then answers get_claude_usage over MCP.
//
// Needs Playwright with Chromium: `npm i -D playwright && npx playwright install chromium`
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

const freePort = () =>
  new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function until(check, { timeout = 20_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- mock claude.ai --------------------------------------------------------

const seen = [];
function startMockClaude(port) {
  const usage = () => {
    const now = Date.now();
    return {
      five_hour: { utilization: 35, resets_at: new Date(now + 2 * 3600_000).toISOString() },
      seven_day: { utilization: 60, resets_at: new Date(now + 3 * 86400_000).toISOString() },
      limits: [
        { kind: 'session', group: 'session', percent: 35, severity: 'normal', resets_at: new Date(now + 2 * 3600_000).toISOString(), scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 60, severity: 'normal', resets_at: new Date(now + 3 * 86400_000).toISOString(), scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 80, severity: 'warning', resets_at: new Date(now + 3 * 86400_000).toISOString(), scope: { model: { display_name: 'Fable' } } },
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
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ---- Claude Desktop extension server over stdio ------------------------------

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
  child.usage = async () => (await child.rpc('tools/call', { name: 'get_claude_usage', arguments: {} })).result.structuredContent;
  return child;
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
  await desktop.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });

  context = await playwright.chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', // the full browser in new headless mode, which can load extensions
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // The chrome.* APIs are bound to the worker a moment after it starts.
  await until(() => worker.evaluate(() => typeof chrome.storage === 'object'), { what: 'extension APIs' });
  // Point the extension at the mock claude.ai and the test port, then "sign in".
  await worker.evaluate(
    ([port, origin]) => chrome.storage.local.set({ settings: { port, claudeOrigin: origin } }),
    [bridgePort, `http://127.0.0.1:${mockPort}`],
  );
  await context.addCookies([{ name: 'sessionKey', value: SESSION, url: `http://127.0.0.1:${mockPort}`, sameSite: 'Lax', httpOnly: true }]);
});

after(async () => {
  await context?.close();
  desktop?.kill();
  mock?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('alarm tick: Claude Desktop asks, the browser reads claude.ai and delivers', { skip: !playwright && 'Playwright not installed' }, async () => {
  const before = await desktop.usage();
  assert.equal(before.ok, false);
  assert.equal(before.error.code, 'no_data');

  // Fire the periodic alarm now instead of waiting a minute.
  await worker.evaluate(() => chrome.alarms.create('tick', { when: Date.now() + 50, periodInMinutes: 1 }));
  const report = await until(async () => {
    const r = await desktop.usage();
    return r.ok && r;
  }, { what: 'a delivered reading' });

  assert.equal(report.five_hour.remaining_percent, 65);
  assert.equal(report.seven_day.remaining_percent, 40);
  assert.equal(report.model_windows.Fable.remaining_percent, 20);
  assert.equal(report.organization.name, 'Personal');
  assert.equal(report.stale, false);
  // Cookies went along with the service worker's requests; the API-only org was skipped.
  assert.ok(seen.every((request) => request.signedIn), JSON.stringify(seen));
  assert.ok(!seen.some((request) => request.path.includes('org-console')));
});

test('popup shows the connection and refreshes on open', { skip: !playwright && 'Playwright not installed' }, async () => {
  const extensionId = new URL(worker.url()).host;
  const requestsBefore = seen.length;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(async () => (await page.locator('#desktop').getAttribute('class')) === 'ok', { what: 'desktop status' });
  assert.match(await page.locator('#desktop').innerText(), /Claude Desktop connected/);
  await until(async () => (await page.locator('.org').count()) === 1, { what: 'org card' });
  assert.match(await page.locator('.org').innerText(), /Personal[\s\S]*65% left[\s\S]*40% left/);
  assert.match(await page.locator('#claude').innerText(), /sent to Claude Desktop/);
  assert.ok(seen.length > requestsBefore, 'opening the popup read claude.ai again');
  await page.close();
});

test('signed out of claude.ai: Claude gets a clear error, old numbers are kept', { skip: !playwright && 'Playwright not installed' }, async () => {
  await context.clearCookies();
  const page = await context.newPage();
  const extensionId = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(async () => /Sign in to claude\.ai/.test(await page.locator('#claude').innerText()), { what: 'login error in popup' });
  const report = await until(async () => {
    const r = await desktop.usage();
    return r.warnings?.some((w) => /latest refresh failed/.test(w)) && r;
  }, { what: 'failure warning' });
  assert.equal(report.ok, true, 'the last good reading is still served');
  assert.match(report.warnings.join(' '), /Sign in to claude\.ai/);
  await page.close();
});

test('Claude Desktop closed: the popup says so and claude.ai is left alone', { skip: !playwright && 'Playwright not installed' }, async () => {
  desktop.stdin.end();
  await new Promise((resolve) => desktop.once('exit', resolve));
  await context.addCookies([{ name: 'sessionKey', value: SESSION, url: `http://127.0.0.1:${mockPort}`, sameSite: 'Lax' }]);
  const requestsBefore = seen.length;
  await worker.evaluate(() => chrome.alarms.create('tick', { when: Date.now() + 50, periodInMinutes: 1 }));
  await until(async () => (await worker.evaluate(() => chrome.storage.local.get('status'))).status?.desktop === 'unreachable', { what: 'unreachable status' });
  assert.equal(seen.length, requestsBefore, 'no claude.ai requests without Claude Desktop');
});
