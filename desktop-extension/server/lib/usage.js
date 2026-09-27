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

/**
 * Build the tool result from the stored snapshot (what the browser extension
 * last reported) and the bridge status (when the extension last checked in).
 */
export function buildReport({ snapshot, bridgeSeenAt = null, organization = null, maxAgeMs, now }) {
  const orgs = (snapshot && Array.isArray(snapshot.orgs) ? snapshot.orgs : []).map((org) => ({
    ...org,
    normalized: normalizeUsage(org.usage),
  }));
  const lastError = snapshot && isObject(snapshot.error) ? snapshot.error : null;

  if (snapshot?.fetched_at == null || !orgs.length) {
    if (lastError) {
      return errorReport(`browser_${String(lastError.code || 'error').toLowerCase()}`, lastError.message || 'The browser extension could not read claude.ai.', now, errorHint(lastError.code));
    }
    const hint =
      bridgeSeenAt === null
        ? 'Install the "Usage Bridge for Claude" browser extension in Chrome or Edge and sign in to claude.ai in that browser. Keep the browser running.'
        : 'The browser extension is connected; the first reading should arrive within about a minute.';
    return errorReport('no_data', 'No usage reading has arrived from the browser extension yet.', now, hint);
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
      warnings.push(`The ${labelFor(name)} window reset after the last reading; its usage is reported as 0% until new data arrives.`);
    }
  }
  const ageMs = Math.max(0, now - snapshot.fetched_at);
  report.stale = ageMs > maxAgeMs;
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
  if (report.stale) {
    const extensionAway = bridgeSeenAt === null || now - bridgeSeenAt > 3 * 60_000;
    warnings.push(
      `The last reading is ${fmtDuration(ageMs / 1000)} old.` +
        (extensionAway
          ? ' The browser extension has not checked in recently: keep Chrome/Edge with "Usage Bridge for Claude" running and signed in to claude.ai.'
          : ' A refresh has been requested; ask again in about a minute.'),
    );
  }
  if (lastError && (snapshot.error_at ?? 0) > snapshot.fetched_at) {
    warnings.push(`The latest refresh failed: ${lastError.message || lastError.code}.`);
  }
  report.summary = summaryLine(report);
  return report;
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
