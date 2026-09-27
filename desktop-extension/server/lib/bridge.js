// HTTP endpoint on 127.0.0.1 that the "Usage Bridge for Claude" browser
// extension reports to. Only one copy of the server can own the port; the
// others simply read what it stores.

import http from 'node:http';
import { SNAPSHOT_FILE } from './store.js';
import { isObject, toNumber } from './usage.js';

export const SERVICE = 'claude-usage-checker';
export const DEFAULT_PORT = 47832;
export const REFRESH_MS = 3 * 60_000; // refresh at least this often while Claude Desktop runs
export const RETRY_MS = 45_000; // never ask the browser more often than its ~1 minute tick
export const DEMAND_MIN_AGE_MS = 30_000; // refresh early once Claude asked for data older than this
const RELISTEN_MS = 30_000;
const MAX_BODY_BYTES = 1 << 20;
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[^/]+$/;

/** Should the browser extension fetch claude.ai now? */
export function needRefresh(snapshot, demandAt, now) {
  const attemptedAt = toNumber(snapshot?.attempted_at) ?? 0;
  if (now - attemptedAt < RETRY_MS) return false;
  const fetchedAt = toNumber(snapshot?.fetched_at);
  if (fetchedAt === null) return true;
  const age = now - fetchedAt;
  if (age >= REFRESH_MS) return true;
  return demandAt !== null && demandAt > attemptedAt && age >= DEMAND_MIN_AGE_MS;
}

const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

/** Validate a POST /v1/report body; null if it is not a report. */
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

/** Merge a report into the stored snapshot; a failed refresh keeps the last good reading. */
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

function send(res, status, body, extraHeaders = {}) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders };
  if (body === undefined) {
    res.writeHead(status, headers).end();
  } else {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk); // past the limit: keep draining, stop buffering
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error('report too large'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function createBridge({ port = DEFAULT_PORT, store, version, log = () => {}, clock = Date.now }) {
  async function handle(req, res) {
    // Only loopback names: blocks DNS-rebinding pages that resolve their own domain to 127.0.0.1.
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, { error: 'unexpected host' });
    // Web pages always send their Origin; only browser extensions (or local tools, with none) may talk to us.
    const origin = req.headers.origin;
    const fromExtension = typeof origin === 'string' && EXTENSION_ORIGIN.test(origin);
    if (origin !== undefined && !fromExtension) return send(res, 403, { error: 'forbidden origin' });

    const { pathname } = new URL(req.url || '/', 'http://127.0.0.1');
    const now = clock();
    if (req.method === 'GET' && pathname === '/v1/state') {
      try {
        store.writeBridgeSeenAt(now);
      } catch (error) {
        log(`cannot record the extension check-in: ${error.message}`); // only affects hints
      }
      const need = needRefresh(store.readSnapshot(), store.readDemandAt(), now);
      return send(res, 200, { service: SERVICE, version, need_refresh: need });
    }
    if (req.method === 'POST' && pathname === '/v1/report') {
      if (!fromExtension) return send(res, 403, { error: 'reports must come from the browser extension' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        if (error.status) return send(res, error.status, { error: error.message }, { Connection: 'close' });
        return send(res, 400, { error: 'invalid JSON' });
      }
      const report = sanitizeReport(body, now);
      if (!report) return send(res, 400, { error: 'invalid report' });
      store.writeBridgeSeenAt(now);
      store.write(SNAPSHOT_FILE, applyReport(store.readSnapshot(), report, now));
      return send(res, 204);
    }
    return send(res, 404, { error: 'not found' });
  }

  let server = null;
  let timer = null;
  let closed = false;

  function attempt() {
    if (closed) return;
    const candidate = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        log(`request failed: ${error.message}`);
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
      });
    });
    candidate.on('error', (error) => {
      if (server === candidate) return log(`bridge error: ${error.message}`);
      log(
        error.code === 'EADDRINUSE'
          ? `127.0.0.1:${port} is taken (probably another copy of this server); retrying in 30s`
          : `cannot listen on 127.0.0.1:${port}: ${error.message}; retrying in 30s`,
      );
      timer = setTimeout(attempt, RELISTEN_MS);
      timer.unref();
    });
    candidate.listen(port, '127.0.0.1', () => {
      if (closed) return candidate.close();
      server = candidate;
      log(`listening for the browser extension on 127.0.0.1:${port}`);
    });
  }
  attempt();

  return {
    get listening() {
      return server !== null;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      if (!server) return Promise.resolve();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
