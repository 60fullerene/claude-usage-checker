// Normalize claude.ai usage payloads and build the report Claude sees.

export const PRIMARY = ['five_hour', 'seven_day'];

const LABELS = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
  seven_day_cowork: '7-day Cowork',
  seven_day_oauth_apps: '7-day OAuth apps',
};
const SHORT = { five_hour: '5h', seven_day: '7d' };
// Legacy per-window fields worth reporting; experiment codenames are skipped.
const LEGACY_WINDOW = /^(five_hour|seven_day)(_[a-z_]+)?$/;
const MAX_EPOCH_MS = 32503680000000; // year 3000

export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function toNumber(value) {
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Epoch seconds/milliseconds or an ISO 8601 string -> epoch milliseconds (or null). */
export function parseTime(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
    const n = toNumber(value);
    if (n === null || n <= 0) return null;
    const ms = n < 1e11 ? n * 1000 : n;
    return ms < MAX_EPOCH_MS ? ms : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  // Keep at most millisecond precision; "…:00.119305+00:00" is not guaranteed to parse everywhere.
  const text = value.trim().replace(/(T\d{2}:\d{2}:\d{2}\.\d{3})\d+/, '$1');
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 && ms < MAX_EPOCH_MS ? ms : null;
}

export const isoformat = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

export function labelFor(name) {
  return LABELS[name] || name.replace(/_/g, ' ');
}

function scopeLabel(scope) {
  if (!isObject(scope)) return null;
  const model = isObject(scope.model) ? scope.model.display_name || scope.model.id : null;
  const surface = isObject(scope.surface) ? scope.surface.display_name || scope.surface.id : scope.surface;
  const parts = [model, surface].filter((part) => typeof part === 'string' && part);
  return parts.length ? parts.join(' · ') : null;
}

function makeWindow(percent, resetsAt, severity) {
  const used = toNumber(percent);
  if (used === null) return null;
  return { used, resetsAt: parseTime(resetsAt), severity: typeof severity === 'string' ? severity : null };
}

/**
 * One `GET /api/organizations/{uuid}/usage` payload -> windows.
 *
 * Current payloads list every limit in `limits[]` (kind session / weekly_all /
 * weekly_scoped, with `percent`); older ones and some plans only have the
 * `five_hour` / `seven_day` / `seven_day_*` objects (with `utilization`).
 */
export function normalizeUsage(usage) {
  const windows = {};
  const models = {};
  if (!isObject(usage)) return { windows, models, extraUsage: null };
  const limits = Array.isArray(usage.limits) ? usage.limits.filter(isObject) : [];
  if (limits.length) {
    for (const limit of limits) {
      const window = makeWindow(limit.percent ?? limit.utilization, limit.resets_at, limit.severity);
      if (!window) continue;
      const scope = scopeLabel(limit.scope);
      let target = windows;
      let key;
      if (limit.kind === 'session' && !scope) key = 'five_hour';
      else if (limit.kind === 'weekly_all' && !scope) key = 'seven_day';
      else if (limit.kind === 'weekly_scoped' && scope) [target, key] = [models, scope];
      else key = [limit.kind || 'limit', scope].filter(Boolean).join(':');
      if (!(key in target)) target[key] = window;
    }
  } else {
    for (const [key, raw] of Object.entries(usage)) {
      if (!LEGACY_WINDOW.test(key) || !isObject(raw)) continue;
      const window = makeWindow(raw.utilization, raw.resets_at, null);
      if (window) windows[key] = window;
    }
  }
  return { windows, models, extraUsage: isObject(usage.extra_usage) ? { ...usage.extra_usage } : null };
}

export function hasPrimaryWindow(normalized) {
  return PRIMARY.some((name) => name in normalized.windows);
}

// ---------------------------------------------------------------------------
// Reports

export function windowReport(window, now) {
  // A window that reset after the reading starts over; usage since then is unknown.
  const expired = window.resetsAt !== null && window.resetsAt <= now;
  const used = Math.round(Math.max(0, expired ? 0 : window.used) * 10) / 10;
  const report = {
    used_percent: used,
    remaining_percent: Math.round(Math.max(0, 100 - used) * 10) / 10,
    resets_at: expired ? null : isoformat(window.resetsAt),
    resets_in_seconds: expired || window.resetsAt === null ? null : Math.max(0, Math.floor((window.resetsAt - now) / 1000)),
  };
  if (window.severity && !expired) report.severity = window.severity;
  if (expired) report.estimated = true;
  return report;
}

export function fmtPercent(value) {
  const text = value.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

export function fmtDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  let minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  let hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  if (hours < 24) return `${hours}h${minutes}m`;
  const days = Math.floor(hours / 24);
  hours -= days * 24;
  return `${days}d${hours}h`;
}

export function summaryLine(report) {
  return PRIMARY.map((name) => {
    const window = report[name];
    if (!window) return `${SHORT[name]}: unknown`;
    let text = `${SHORT[name]}: ${fmtPercent(window.remaining_percent)}% left`;
    if (window.resets_in_seconds !== null) text += ` (resets in ${fmtDuration(window.resets_in_seconds)})`;
    else if (window.estimated) text += ' (window reset since last reading)';
    return text;
  }).join(' | ');
}

export function errorReport(code, message, now, hint) {
  const error = { code, message };
  if (hint) error.hint = hint;
  return {
    ok: false,
    summary: `Claude usage unavailable: ${message}`,
    error,
    five_hour: null,
    seven_day: null,
    generated_at: isoformat(now),
  };
}

function matchOrg(orgs, query) {
  const wanted = query.trim().toLowerCase();
  return (
    orgs.find((org) => (org.uuid || '').toLowerCase() === wanted) ||
    orgs.find((org) => (org.name || '').toLowerCase() === wanted) ||
    orgs.find((org) => (org.name || '').toLowerCase().includes(wanted))
  );
}

/** Why reading claude.ai just now did not work, for Claude and for the user. */
function refreshFailure(refresh, port) {
  switch (refresh.status) {
    case 'no_extension':
      return {
        code: 'browser_not_connected',
        message: 'The "Usage Bridge for Claude" browser extension is not connected.',
        hint: 'Open Chrome or Edge with the "Usage Bridge for Claude" extension installed and signed in to claude.ai, then ask again.',
      };
    case 'unreachable':
      return {
        code: 'bridge_unreachable',
        message: `Could not reach the local bridge on 127.0.0.1:${port} (${refresh.error}).`,
        hint: 'Restart Claude Desktop. If another program uses this port, choose another port in both extensions.',
      };
    case 'timeout':
    case 'disconnected':
      return {
        code: 'browser_timeout',
        message: 'The browser extension did not answer in time.',
        hint: 'Open the "Usage Bridge for Claude" popup in your browser to see what is wrong, then ask again.',
      };
    default:
      return {
        code: 'browser_error',
        message: refresh.error || 'The browser extension could not read claude.ai.',
        hint: 'Open the "Usage Bridge for Claude" popup in your browser for details.',
      };
  }
}

function errorHint(code) {
  switch (code) {
    case 'LOGIN':
      return 'Sign in to claude.ai in the browser that has the "Usage Bridge for Claude" extension.';
    case 'NETWORK':
      return 'Check that the browser can reach claude.ai.';
    default:
      return 'Open the "Usage Bridge for Claude" extension popup in your browser for details.';
  }
}

/**
 * Build the tool result from the stored snapshot (what the browser extension
 * last read from claude.ai) and the outcome of asking it to read again just
 * now (`refresh`; null when a recent enough reading was reused).
 */
export function buildReport({ snapshot, refresh = null, organization = null, port = null, now }) {
  const orgs = (snapshot && Array.isArray(snapshot.orgs) ? snapshot.orgs : []).map((org) => ({
    ...org,
    normalized: normalizeUsage(org.usage),
  }));
  const lastError = snapshot && isObject(snapshot.error) ? snapshot.error : null;
  const failed = refresh && refresh.status !== 'ok' ? refresh : null;

  if (snapshot?.fetched_at == null || !orgs.length) {
    // Nothing usable yet: explain the most specific reason we know.
    if (lastError && (!failed || failed.status === 'error')) {
      const code = String(lastError.code || 'error').toLowerCase();
      return errorReport(`browser_${code}`, lastError.message || 'The browser extension could not read claude.ai.', now, errorHint(lastError.code));
    }
    if (failed) {
      const why = refreshFailure(failed, port);
      return errorReport(why.code, why.message, now, why.hint);
    }
    return errorReport('no_data', 'No usage reading yet.', now, refreshFailure({ status: 'no_extension' }, port).hint);
  }

  let org;
  if (organization) {
    org = matchOrg(orgs, organization);
    if (!org) {
      const names = orgs.map((o) => o.name || o.uuid).join(', ');
      return errorReport('organization_not_found', `No organization matches "${organization}".`, now, `Known organizations: ${names}`);
    }
  } else {
    org = orgs.find((o) => hasPrimaryWindow(o.normalized)) || orgs[0];
  }

  const { windows, models, extraUsage } = org.normalized;
  const warnings = [];
  const report = { ok: true, summary: '' };
  for (const name of PRIMARY) {
    report[name] = name in windows ? windowReport(windows[name], now) : null;
    if (report[name]?.estimated) {
      warnings.push(`The ${labelFor(name)} window reset after this reading; its usage is reported as 0%.`);
    }
  }
  const ageMs = Math.max(0, now - snapshot.fetched_at);
  report.stale = Boolean(failed); // true when claude.ai could not be read now and an older reading is shown
  report.warnings = warnings;

  const others = Object.keys(windows).filter((name) => !PRIMARY.includes(name)).sort();
  if (others.length) report.other_windows = Object.fromEntries(others.map((n) => [n, windowReport(windows[n], now)]));
  const modelNames = Object.keys(models).sort();
  if (modelNames.length) report.model_windows = Object.fromEntries(modelNames.map((n) => [n, windowReport(models[n], now)]));
  if (extraUsage) report.extra_usage = extraUsage;
  report.organization = { name: org.name || null, uuid: org.uuid || null };
  const rest = orgs.filter((o) => o !== org);
  if (rest.length) {
    report.other_organizations = rest.map((o) => {
      const r = Object.fromEntries(PRIMARY.map((n) => [n, n in o.normalized.windows ? windowReport(o.normalized.windows[n], now) : null]));
      return { name: o.name || null, uuid: o.uuid || null, summary: hasPrimaryWindow(o.normalized) ? summaryLine(r) : 'no 5-hour or weekly limits' };
    });
  }
  report.source = 'browser';
  report.observed_at = isoformat(snapshot.fetched_at);
  report.age_seconds = Math.floor(ageMs / 1000);
  report.generated_at = isoformat(now);

  if (!hasPrimaryWindow(org.normalized)) {
    warnings.push(`No 5-hour or weekly limits apply to the organization "${org.name || org.uuid}" (for example a usage-based Enterprise plan).`);
  }
  if (failed) {
    const why = failed.status === 'error' && lastError ? { message: lastError.message || failed.error, hint: errorHint(lastError.code) } : refreshFailure(failed, port);
    warnings.push(`Could not read claude.ai just now (${why.message}) Showing the reading from ${fmtDuration(ageMs / 1000)} ago. ${why.hint}`);
  } else if (lastError && (snapshot.error_at ?? 0) > snapshot.fetched_at) {
    warnings.push(`The latest read of claude.ai failed: ${lastError.message || lastError.code}`);
  }
  report.summary = summaryLine(report);
  return report;
}
