// Local endpoint on 127.0.0.1 that the "Usage Bridge for Claude" browser
// extension keeps a WebSocket open to. When Claude asks for its usage, we ask
// the browser over that socket, and it reads claude.ai right then. Only one
// copy of this server can own the port; other copies go through it via
// POST /v1/refresh.

import crypto from 'node:crypto';
import http from 'node:http';
import { SNAPSHOT_FILE } from './store.js';
import { isObject, toNumber } from './usage.js';
import { acceptWebSocket, rejectUpgrade } from './ws.js';

export const SERVICE = 'claude-usage-checker';
export const DEFAULT_PORT = 47832;
export const REPORT_TIMEOUT_MS = 25_000; // how long the browser gets to read claude.ai
const RELISTEN_MS = 5_000;
const IDLE_CLIENT_MS = 90_000; // the extension pings every 20 s; drop connections that went quiet
const MAX_MESSAGE_BYTES = 1 << 20;
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[^/]+$/;

const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

/** Validate a report from the extension; null if it is not one. */
export function sanitizeReport(body, now) {
  if (!isObject(body)) return null;
  const orgs = (Array.isArray(body.orgs) ? body.orgs : [])
    .filter(isObject)
    .slice(0, 20)
    .map((org) => ({
      uuid: text(org.uuid, 100),
      name: text(org.name, 200),
      usage: isObject(org.usage) ? org.usage : null,
      error: text(org.error, 300),
      status: toNumber(org.status),
    }));
  const fetchedAt = toNumber(body.fetched_at);
  const error = isObject(body.error)
    ? { code: text(body.error.code, 40) || 'ERROR', message: text(body.error.message, 500) }
    : null;
  return {
    orgs,
    fetchedAt: fetchedAt === null ? null : Math.min(fetchedAt, now),
    error,
    extension: { version: text(body.extension_version, 40), via: text(body.via, 20) },
  };
}

/** Merge a report into the stored snapshot; a failed read keeps the last good reading. */
export function applyReport(previous, report, now) {
  const next = {
    version: 1,
    attempted_at: now,
    fetched_at: previous?.fetched_at ?? null,
    orgs: previous?.orgs ?? [],
    error: previous?.error ?? null,
    error_at: previous?.error_at ?? null,
    extension: report.extension,
  };
  if (!report.error && report.orgs.some((org) => org.usage)) {
    return { ...next, fetched_at: report.fetchedAt ?? now, orgs: report.orgs, error: null, error_at: null };
  }
  const details = report.orgs.map((org) => `${org.name || org.uuid}: ${org.error || 'no data'}`).join('; ');
  next.error = report.error ?? {
    code: 'NO_USAGE',
    message: `claude.ai returned no usage for any organization${details ? ` (${details})` : ''}`,
  };
  next.error_at = now;
  return next;
}

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return; // the caller gave up waiting
  res
    .writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' })
    .end(JSON.stringify(body));
}

/** Ask whichever copy of the server owns the port to get a fresh reading. */
export function requestRefresh(port, timeoutMs = REPORT_TIMEOUT_MS + 5_000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/refresh', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data?.service === SERVICE) return resolve(data);
        } catch {
          // fall through
        }
        resolve({ status: 'unreachable', error: `port ${port} answers but is not this extension (HTTP ${res.statusCode})` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (error) => resolve({ status: 'unreachable', error: error.message }));
    req.end();
  });
}

export function createBridge({
  port = DEFAULT_PORT,
  store,
  version,
  log = () => {},
  clock = Date.now,
  reportTimeoutMs = REPORT_TIMEOUT_MS,
}) {
  const clients = []; // connected browser extensions, oldest first
  let inflight = null;

  const hostOk = (req) => {
    // Only loopback names: blocks DNS-rebinding pages that resolve their own domain to 127.0.0.1.
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  function onMessage(client, raw) {
    client.lastSeen = clock();
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    if (message.type === 'ping') return client.socket.send({ type: 'pong' });
    if (message.type === 'hello') {
      client.extensionVersion = text(message.extension_version, 40);
      return undefined;
    }
    if (message.type !== 'report') return undefined;
    const now = clock();
    const report = sanitizeReport(message, now);
    if (!report) return undefined;
    try {
      store.write(SNAPSHOT_FILE, applyReport(store.readSnapshot(), report, now));
    } catch (error) {
      log(`cannot store the reading: ${error.message}`);
    }
    const waiter = client.waiters.get(message.id);
    if (waiter) waiter(report.error ? { status: 'error', error: report.error.message } : { status: 'ok' });
    return undefined;
  }

  function askClient(client) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const done = (result) => {
        clearTimeout(timer);
        client.waiters.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => done({ status: 'timeout', error: 'the browser extension did not answer in time' }), reportTimeoutMs);
      client.waiters.set(id, done);
      client.socket.send({ type: 'refresh', id });
    });
  }

  /** One read of claude.ai through the newest connected browser; concurrent callers share it. */
  function refresh() {
    inflight ??= (async () => {
      let result = { status: 'no_extension', error: 'no browser extension is connected' };
      for (const client of [...clients].reverse()) {
        result = await askClient(client);
        if (result.status === 'ok') break;
      }
      return result;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function onRequest(req, res) {
    if (!hostOk(req)) return send(res, 421, { error: 'unexpected host' });
    // Web pages always send an Origin, so they are turned away. The browser
    // extension may check /v1/status; /v1/refresh is for local programs only.
    const origin = req.headers.origin;
    const fromExtension = typeof origin === 'string' && EXTENSION_ORIGIN.test(origin);
    const { pathname } = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && pathname === '/v1/status') {
      if (origin !== undefined && !fromExtension) return send(res, 403, { error: 'forbidden origin' });
      return send(res, 200, { service: SERVICE, version, connected: clients.length });
    }
    if (req.method === 'POST' && pathname === '/v1/refresh') {
      if (origin !== undefined) return send(res, 403, { error: 'forbidden origin' });
      req.resume();
      return refresh().then((result) => send(res, 200, { service: SERVICE, version, connected: clients.length, ...result }));
    }
    return send(res, 404, { error: 'not found' });
  }

  function onUpgrade(req, socket, head) {
    if (!hostOk(req)) return rejectUpgrade(socket, 421);
    if (!EXTENSION_ORIGIN.test(String(req.headers.origin || ''))) return rejectUpgrade(socket, 403);
    if (new URL(req.url || '/', 'http://127.0.0.1').pathname !== '/v1/ws') return rejectUpgrade(socket, 404);
    const client = { waiters: new Map(), lastSeen: clock(), extensionVersion: null, socket: null };
    client.socket = acceptWebSocket(req, socket, head, {
      maxMessageBytes: MAX_MESSAGE_BYTES,
      onMessage: (raw) => onMessage(client, raw),
      onClose: () => {
        const index = clients.indexOf(client);
        if (index >= 0) clients.splice(index, 1);
        for (const waiter of [...client.waiters.values()]) waiter({ status: 'disconnected', error: 'the browser extension disconnected' });
        log('browser extension disconnected');
      },
    });
    if (client.socket) {
      clients.push(client);
      log('browser extension connected');
    }
    return undefined;
  }

  const sweeper = setInterval(() => {
    const now = clock();
    for (const client of [...clients]) if (now - client.lastSeen > IDLE_CLIENT_MS) client.socket.close(1001);
  }, 30_000);
  sweeper.unref();

  let server = null;
  let timer = null;
  let closed = false;

  function attempt() {
    if (closed) return;
    const candidate = http.createServer(onRequest);
    candidate.on('upgrade', onUpgrade);
    candidate.on('error', (error) => {
      if (server === candidate) return log(`bridge error: ${error.message}`);
      if (error.code !== 'EADDRINUSE') log(`cannot listen on 127.0.0.1:${port}: ${error.message}`);
      timer = setTimeout(attempt, RELISTEN_MS); // another copy of this server has the port for now
      timer.unref();
    });
    candidate.listen(port, '127.0.0.1', () => {
      if (closed) return candidate.close();
      server = candidate;
      log(`waiting for the browser extension on 127.0.0.1:${port}`);
    });
  }
  attempt();

  return {
    get listening() {
      return server !== null;
    },
    get connected() {
      return clients.length;
    },
    refresh,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(sweeper);
      for (const client of [...clients]) client.socket.close(1001);
      if (!server) return Promise.resolve();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
