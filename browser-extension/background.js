// Every minute: ask the "Claude Usage" extension in Claude Desktop (127.0.0.1)
// whether it wants fresh numbers; if so, read them from claude.ai with this
// browser's own sign-in and hand them over. Nothing is sent anywhere else, and
// claude.ai is not contacted at all while Claude Desktop is closed.

import { getSettings } from './usage.js';

const ALARM = 'tick';
const SERVICE = 'claude-usage-checker';
const CLAUDE_TIMEOUT_MS = 15_000;
const LOCAL_TIMEOUT_MS = 3_000;
const MAX_ORGS = 10;
const VERSION = chrome.runtime.getManifest().version;

/* ---------- Claude Desktop (local bridge) ---------- */

async function local(port, path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

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

/* ---------- the tick ---------- */

let running = null;

/** One round; `force` reads claude.ai even if Claude Desktop is not asking (popup "Refresh"). */
function tick({ force = false } = {}) {
  if (running) return force ? running.then(() => tick({ force })) : running;
  running = round(force).finally(() => {
    running = null;
  });
  return running;
}

async function round(force) {
  const { port, origin } = await getSettings();
  const status = { checked_at: Date.now(), port };
  let state = null;
  try {
    state = await local(port, '/v1/state');
    if (state?.service !== SERVICE) throw new Error(`port ${port} is used by another program`);
    status.desktop = 'connected';
  } catch (error) {
    state = null;
    status.desktop = 'unreachable';
    status.desktop_error = error.name === 'TimeoutError' ? 'timed out' : error.message;
  }
  if (force || state?.need_refresh) {
    const report = await collect(origin);
    status.last_fetch = { at: Date.now(), via: report.via, orgs: report.orgs, error: report.error };
    if (state) {
      try {
        await local(port, '/v1/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...report, extension_version: VERSION }),
        });
        status.delivered_at = Date.now();
      } catch (error) {
        status.desktop = 'unreachable';
        status.desktop_error = error.message;
      }
    }
  }
  const stored = (await chrome.storage.local.get('status')).status || {};
  const merged = { ...stored, ...status };
  if (status.desktop === 'connected') delete merged.desktop_error;
  await chrome.storage.local.set({ status: merged });
  return merged;
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm().then(() => tick()));
chrome.runtime.onStartup.addListener(() => ensureAlarm().then(() => tick()));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) tick();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh') {
    tick({ force: true }).then(sendResponse, (error) => sendResponse({ error: error.message }));
    return true; // respond asynchronously
  }
  return false;
});
ensureAlarm();
