// Keeps a connection open to the "Claude Usage" extension in Claude Desktop
// (127.0.0.1 only). claude.ai is read only when Claude asks for its usage
// through that connection, or when you press Refresh in the popup. While
// Claude Desktop is closed, this only retries the local connection once a
// minute.

import { getSettings } from './usage.js';

const ALARM = 'reconnect';
const SERVICE = 'claude-usage-checker';
const KEEPALIVE_MS = 20_000; // messages within 30 s keep this service worker (and the socket) alive
const CLAUDE_TIMEOUT_MS = 10_000;
const LOCAL_TIMEOUT_MS = 3_000;
const MAX_ORGS = 10;
const VERSION = chrome.runtime.getManifest().version;

/* ---------- claude.ai, path 1: straight from the service worker ---------- */

async function claudeJson(origin, path) {
  const res = await fetch(origin + path, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// Console (API-only) organizations have no chat usage and answer /usage with 403.
const hasChat = (org) => !Array.isArray(org?.capabilities) || !org.capabilities.length || org.capabilities.includes('chat');

async function collectDirect(origin) {
  const orgs = await claudeJson(origin, '/api/organizations');
  if (!Array.isArray(orgs)) throw new Error('unexpected /api/organizations response');
  const out = [];
  for (const org of orgs.filter(hasChat).slice(0, MAX_ORGS)) {
    try {
      out.push({ uuid: org.uuid, name: org.name, usage: await claudeJson(origin, `/api/organizations/${encodeURIComponent(org.uuid)}/usage`) });
    } catch (error) {
      out.push({ uuid: org.uuid, name: org.name, error: error.message, status: error.status ?? null });
    }
  }
  return out;
}

/* ---------- claude.ai, path 2: inside an open claude.ai tab ---------- */

// Serialized into the page, so it must be self-contained.
async function pageCollector(maxOrgs) {
  const get = async (path) => {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
  const keep = (org) => !Array.isArray(org?.capabilities) || !org.capabilities.length || org.capabilities.includes('chat');
  const out = [];
  for (const org of (await get('/api/organizations')).filter(keep).slice(0, maxOrgs)) {
    try {
      out.push({ uuid: org.uuid, name: org.name, usage: await get(`/api/organizations/${encodeURIComponent(org.uuid)}/usage`) });
    } catch (error) {
      out.push({ uuid: org.uuid, name: org.name, error: error.message, status: error.status ?? null });
    }
  }
  return out;
}

async function collectViaTab(origin) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) {
    try {
      const [hit] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageCollector, args: [MAX_ORGS] });
      if (Array.isArray(hit?.result) && hit.result.length) return hit.result;
    } catch {
      // try the next tab
    }
  }
  return null;
}

async function collect(origin) {
  const fetchedAt = Date.now();
  let direct;
  try {
    return { fetched_at: fetchedAt, via: 'direct', orgs: await collectDirect(origin), error: null };
  } catch (error) {
    direct = error;
  }
  const viaTab = await collectViaTab(origin).catch(() => null);
  if (viaTab) return { fetched_at: fetchedAt, via: 'tab', orgs: viaTab, error: null };
  const status = direct.status;
  const error =
    status === 401 || status === 403
      ? { code: 'LOGIN', message: `claude.ai refused the request (HTTP ${status}). Sign in to claude.ai in this browser.` }
      : status
        ? { code: 'FAILED', message: `claude.ai answered HTTP ${status}.` }
        : { code: 'NETWORK', message: `Could not reach claude.ai (${direct.message}).` };
  return { fetched_at: null, via: null, orgs: [], error };
}

/* ---------- status for the popup ---------- */

let statusWrites = Promise.resolve();

/** Merge `changes` into the stored status; writes are queued so none overwrites another. */
function updateStatus(changes) {
  statusWrites = statusWrites
    .catch(() => {})
    .then(async () => {
      const stored = (await chrome.storage.local.get('status')).status || {};
      const status = { ...stored, ...changes };
      await chrome.storage.local.set({ status });
      return status;
    });
  return statusWrites;
}

let reading = null;

/** Read claude.ai once (concurrent callers share the read) and remember it for the popup. */
function read() {
  reading ??= (async () => {
    const { origin } = await getSettings();
    const report = await collect(origin);
    await updateStatus({ last_fetch: { at: Date.now(), via: report.via, orgs: report.orgs, error: report.error } });
    return report;
  })().finally(() => {
    reading = null;
  });
  return reading;
}

/* ---------- the connection to Claude Desktop ---------- */

let socket = null;
let connecting = null;

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function onMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message?.type === 'refresh') {
    // Claude asked: read claude.ai now and answer on the same connection, whatever happens.
    let report;
    try {
      report = await read();
    } catch (error) {
      report = { fetched_at: null, via: null, orgs: [], error: { code: 'FAILED', message: error.message } };
    }
    send(ws, { type: 'report', id: message.id, ...report, extension_version: VERSION });
    await updateStatus({ delivered_at: Date.now() });
  }
}

/** Connect if not connected. A quick local check first keeps failed attempts quiet. */
function connect() {
  connecting ??= (async () => {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    const { port } = await getSettings();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
      if ((await res.json())?.service !== SERVICE) throw new Error(`port ${port} is used by another program`);
    } catch (error) {
      await updateStatus({ desktop: 'disconnected', port, desktop_error: error.name === 'TimeoutError' ? 'timed out' : error.message });
      return;
    }
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
      let keepalive = null;
      let opened = false;
      socket = ws;
      ws.onopen = () => {
        opened = true;
        send(ws, { type: 'hello', extension_version: VERSION });
        keepalive = setInterval(() => send(ws, { type: 'ping' }), KEEPALIVE_MS);
        updateStatus({ desktop: 'connected', port, desktop_error: null }).then(resolve);
      };
      ws.onmessage = (event) => onMessage(ws, event.data);
      ws.onclose = () => {
        clearInterval(keepalive);
        // A socket replaced after a settings change must not mark the new one as disconnected.
        const current = socket === ws || socket === null;
        if (socket === ws) socket = null;
        (current ? updateStatus({ desktop: 'disconnected', port }) : Promise.resolve()).then(resolve);
        // Claude Desktop restarted or another copy of its server took over: come back soon.
        if (opened && current) setTimeout(connect, 3_000);
      };
    });
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** After a settings change: finish any attempt that used the old port, then connect afresh. */
async function reconnect() {
  await connecting;
  socket?.close();
  socket = null;
  return connect();
}

/* ---------- events ---------- */

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm().then(connect));
chrome.runtime.onStartup.addListener(() => ensureAlarm().then(connect));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) connect(); // no-op while connected; only ever talks to 127.0.0.1
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) reconnect();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, (error) => sendResponse({ error: error.message }));
    return true; // respond asynchronously
  };
  if (message?.type === 'status') {
    return reply(connect().then(() => chrome.storage.local.get('status')).then(({ status }) => status || {}));
  }
  if (message?.type === 'refresh') {
    // The popup's Refresh: read claude.ai and pass the result on if Claude Desktop is connected.
    return reply(
      connect()
        .then(read)
        .then(async (report) => {
          if (socket) {
            send(socket, { type: 'report', id: null, ...report, extension_version: VERSION });
            await updateStatus({ delivered_at: Date.now() });
          }
          return (await chrome.storage.local.get('status')).status || {};
        }),
    );
  }
  return false;
});

ensureAlarm();
connect();
