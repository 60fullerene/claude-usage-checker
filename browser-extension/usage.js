// Shared by the service worker and the popup.

export const DEFAULT_PORT = 47832;
export const CLAUDE_ORIGIN = 'https://claude.ai';

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const port = Number(settings?.port);
  // The claude.ai origin can only be swapped for a loopback server (used by the automated tests).
  const testOrigin = settings?.claudeOrigin;
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
    origin: typeof testOrigin === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(testOrigin) ? testOrigin : CLAUDE_ORIGIN,
  };
}

/** The 5-hour and weekly windows of one usage payload: {five_hour, seven_day} of {percent, resetsAt} or null. */
export function primaryWindows(usage) {
  const result = { five_hour: null, seven_day: null };
  if (!usage || typeof usage !== 'object') return result;
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  if (limits.length) {
    for (const limit of limits) {
      const key = limit?.kind === 'session' ? 'five_hour' : limit?.kind === 'weekly_all' ? 'seven_day' : null;
      if (key && !result[key] && Number.isFinite(Number(limit.percent))) {
        result[key] = { percent: Number(limit.percent), resetsAt: limit.resets_at || null };
      }
    }
  } else {
    for (const key of Object.keys(result)) {
      const value = usage[key];
      if (value && Number.isFinite(Number(value.utilization))) {
        result[key] = { percent: Number(value.utilization), resetsAt: value.resets_at || null };
      }
    }
  }
  return result;
}

export function formatAgo(ms, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export function formatIn(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  let minutes = Math.max(0, Math.round((at - now) / 60000));
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
