import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReport, fmtDuration, normalizeUsage, parseTime, windowReport } from '../server/lib/usage.js';

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Shapes seen from GET https://claude.ai/api/organizations/{uuid}/usage
const LIMITS_PAYLOAD = {
  five_hour: { utilization: 23, resets_at: iso(NOW + 2 * HOUR) },
  seven_day: { utilization: 41, resets_at: iso(NOW + 3 * DAY) },
  extra_usage: { is_enabled: false, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 23, severity: 'normal', resets_at: iso(NOW + 2 * HOUR), scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 41, severity: 'normal', resets_at: iso(NOW + 3 * DAY), scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 76, severity: 'warning', resets_at: iso(NOW + 3 * DAY), scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
  ],
};
const LEGACY_PAYLOAD = {
  five_hour: { utilization: 33.0, resets_at: '2026-09-27T14:00:00.528743+00:00' },
  seven_day: { utilization: 13.0, resets_at: '2026-10-01T00:59:59.951713+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 1.0, resets_at: '2026-10-01T03:00:00.951719+00:00' },
  nimbus_quill: { utilization: 0.0, resets_at: null },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [],
};
const ENTERPRISE_PAYLOAD = {
  five_hour: null,
  seven_day: null,
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25.0, currency: 'USD' },
  limits: [],
};

function snapshot(orgs, overrides = {}) {
  return { version: 1, attempted_at: NOW - 60_000, fetched_at: NOW - 60_000, orgs, error: null, error_at: null, ...overrides };
}
const report = (snap, options = {}) => buildReport({ snapshot: snap, refresh: { status: 'ok' }, port: 47832, now: NOW, ...options });

test('parseTime accepts epoch seconds, milliseconds and ISO strings', () => {
  assert.equal(parseTime(1790000000), 1790000000000);
  assert.equal(parseTime(1790000000123), 1790000000123);
  assert.equal(parseTime('1790000000'), 1790000000000);
  assert.equal(parseTime('2026-09-27T14:00:00.528743+00:00'), Date.UTC(2026, 8, 27, 14, 0, 0, 528));
  assert.equal(parseTime('2026-09-27T23:00:00+09:00'), Date.UTC(2026, 8, 27, 14));
  for (const bad of [null, undefined, true, '', 'soon', -1, 0, {}, 1e20]) assert.equal(parseTime(bad), null, String(bad));
});

test('normalizeUsage reads limits[] (current payloads)', () => {
  const { windows, models, extraUsage } = normalizeUsage(LIMITS_PAYLOAD);
  assert.deepEqual(Object.keys(windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(windows.five_hour.used, 23);
  assert.equal(windows.five_hour.severity, 'normal');
  assert.equal(models.Fable.used, 76);
  assert.equal(models.Fable.severity, 'warning');
  assert.deepEqual(extraUsage, { is_enabled: false, utilization: null });
});

test('normalizeUsage falls back to five_hour / seven_day fields and skips codenames', () => {
  const { windows, models } = normalizeUsage(LEGACY_PAYLOAD);
  assert.deepEqual(Object.keys(windows).sort(), ['five_hour', 'seven_day', 'seven_day_sonnet']);
  assert.equal(windows.seven_day.used, 13);
  assert.deepEqual(models, {});
  assert.deepEqual(normalizeUsage(ENTERPRISE_PAYLOAD).windows, {});
  assert.deepEqual(normalizeUsage(null).windows, {});
});

test('normalizeUsage keeps unknown limit kinds under their own name', () => {
  const { windows } = normalizeUsage({ limits: [{ kind: 'daily_routines', percent: 10, resets_at: null }] });
  assert.equal(windows.daily_routines.used, 10);
});

test('windowReport computes remaining time and handles resets', () => {
  assert.deepEqual(windowReport({ used: 23.456, resetsAt: NOW + 90_000, severity: null }, NOW), {
    used_percent: 23.5,
    remaining_percent: 76.5,
    resets_at: '2026-09-27T12:01:30Z',
    resets_in_seconds: 90,
  });
  const over = windowReport({ used: 120, resetsAt: null, severity: 'warning' }, NOW);
  assert.equal(over.remaining_percent, 0);
  assert.equal(over.severity, 'warning');
  const reset = windowReport({ used: 95, resetsAt: NOW - 1, severity: 'warning' }, NOW);
  assert.deepEqual(reset, { used_percent: 0, remaining_percent: 100, resets_at: null, resets_in_seconds: null, estimated: true });
});

test('fmtDuration', () => {
  const cases = [[-5, '0s'], [59, '59s'], [60, '1m'], [3600, '1h0m'], [8388, '2h19m'], [86400, '1d0h'], [3 * 86400 + 17 * 3600, '3d17h']];
  for (const [seconds, expected] of cases) assert.equal(fmtDuration(seconds), expected);
});

test('buildReport: normal reading', () => {
  const r = report(snapshot([{ uuid: 'org-1', name: 'Personal', usage: LIMITS_PAYLOAD }]));
  assert.equal(r.ok, true);
  assert.equal(r.summary, '5h: 77% left (resets in 2h0m) | 7d: 59% left (resets in 3d0h)');
  assert.equal(r.five_hour.remaining_percent, 77);
  assert.equal(r.seven_day.remaining_percent, 59);
  assert.equal(r.model_windows.Fable.remaining_percent, 24);
  assert.equal(r.stale, false);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.organization, { name: 'Personal', uuid: 'org-1' });
  assert.equal(r.source, 'browser');
  assert.equal(r.age_seconds, 60);
  assert.deepEqual(Object.keys(r).slice(0, 4), ['ok', 'summary', 'five_hour', 'seven_day']);
});

test('buildReport picks the organization with limits and lists the others', () => {
  const orgs = [
    { uuid: 'org-ent', name: 'Acme Corp', usage: ENTERPRISE_PAYLOAD },
    { uuid: 'org-2', name: 'Team Alpha', usage: LEGACY_PAYLOAD },
  ];
  const r = report(snapshot(orgs));
  assert.equal(r.organization.name, 'Team Alpha');
  assert.equal(r.other_organizations[0].summary, 'no 5-hour or weekly limits');
  const chosen = report(snapshot(orgs), { organization: 'acme' });
  assert.equal(chosen.organization.name, 'Acme Corp');
  assert.equal(chosen.five_hour, null);
  assert.match(chosen.warnings.at(-1), /No 5-hour or weekly limits apply/);
  assert.equal(chosen.extra_usage.utilization, 25);
  const missing = report(snapshot(orgs), { organization: 'nope' });
  assert.equal(missing.error.code, 'organization_not_found');
  assert.match(missing.error.hint, /Acme Corp, Team Alpha/);
});

test('buildReport: a failed read shows the last reading as stale, with the reason', () => {
  const old = snapshot([{ uuid: 'o', name: 'P', usage: LIMITS_PAYLOAD }], { fetched_at: NOW - 20 * 60_000 });
  const offline = report(old, { refresh: { status: 'no_extension' } });
  assert.equal(offline.ok, true);
  assert.equal(offline.stale, true);
  assert.match(offline.warnings[0], /Could not read claude.ai just now \(The "Usage Bridge for Claude" browser extension is not connected\.\) Showing the reading from 20m0s ago|Showing the reading from 20m ago/);
  assert.match(offline.warnings[0], /Open Chrome or Edge/);
  const signedOut = report(
    { ...old, error: { code: 'LOGIN', message: 'claude.ai refused the request (HTTP 401).' }, error_at: NOW },
    { refresh: { status: 'error', error: 'claude.ai refused the request (HTTP 401).' } },
  );
  assert.match(signedOut.warnings[0], /HTTP 401.*Sign in to claude.ai/);
  const reused = report(old, { refresh: null });
  assert.equal(reused.stale, false, 'a reading reused on purpose is not stale');
  assert.equal(reused.age_seconds, 1200);
});

test('buildReport explains why there is no reading at all', () => {
  const codes = (refresh, snap = null) => report(snap, { refresh }).error.code;
  assert.equal(codes({ status: 'no_extension' }), 'browser_not_connected');
  assert.equal(codes({ status: 'unreachable', error: 'connect ECONNREFUSED' }), 'bridge_unreachable');
  assert.equal(codes({ status: 'timeout' }), 'browser_timeout');
  assert.equal(codes({ status: 'disconnected' }), 'browser_timeout');
  assert.equal(codes(null), 'no_data');
  const login = report({ attempted_at: NOW, fetched_at: null, orgs: [], error: { code: 'LOGIN', message: 'Not signed in' } }, { refresh: { status: 'error', error: 'Not signed in' } });
  assert.equal(login.error.code, 'browser_login');
  assert.match(login.error.hint, /Sign in to claude.ai/);
  const unreachable = report(null, { refresh: { status: 'unreachable', error: 'connect ECONNREFUSED' } });
  assert.match(unreachable.error.message, /127\.0\.0\.1:47832 \(connect ECONNREFUSED\)/);
});

test('buildReport estimates a window that reset since the reading', () => {
  const payload = { limits: [{ kind: 'session', percent: 96, resets_at: iso(NOW - 60_000) }, { kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY) }] };
  const r = report(snapshot([{ uuid: 'o', name: 'P', usage: payload }]));
  assert.equal(r.five_hour.remaining_percent, 100);
  assert.equal(r.five_hour.estimated, true);
  assert.match(r.summary, /5h: 100% left \(window reset since last reading\)/);
  assert.match(r.warnings[0], /reset after this reading/);
});
