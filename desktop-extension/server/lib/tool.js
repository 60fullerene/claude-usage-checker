// The get_claude_usage tool: when called, ask the browser for a fresh reading.

import { DEFAULT_PORT, requestRefresh } from './bridge.js';
import { buildReport, toNumber } from './usage.js';

export const TOOL_NAME = 'get_claude_usage';
export const DEFAULT_MAX_AGE_SECONDS = 60;

export const TOOL = {
  name: TOOL_NAME,
  title: 'Claude usage limits',
  description:
    "Report how much of the Claude subscription's usage limits remain: the rolling 5-hour window and the " +
    'weekly (7-day) window, as used/remaining percentages with reset times (plus per-model weekly limits when ' +
    'the plan has them). Call it before starting a large task and now and then during long work, so you can ' +
    'pace yourself and save or wrap up your work before a limit is reached. Reads claude.ai through the browser when called, so it takes a few seconds.',
  inputSchema: {
    type: 'object',
    properties: {
      organization: {
        type: 'string',
        description: 'Name or UUID of the claude.ai organization to report, if the account has several.',
      },
      max_age_seconds: {
        type: 'number',
        minimum: 0,
        description: `Reuse a reading at most this old instead of reading claude.ai again (default ${DEFAULT_MAX_AGE_SECONDS}; 0 always reads).`,
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

export const INSTRUCTIONS =
  'Use get_claude_usage to see how much of the Claude usage limits (5-hour and weekly windows) remain ' +
  'before large tasks and periodically during long-running work.';

export function createToolHandler({ store, port = DEFAULT_PORT, defaultOrganization = null, clock = Date.now, refresh = requestRefresh }) {
  return async function callTool(_name, args) {
    const unknown = Object.keys(args).filter((key) => !(key in TOOL.inputSchema.properties));
    if (unknown.length) return { text: `Unknown argument(s): ${unknown.join(', ')}`, isError: true };
    const organization = args.organization ?? defaultOrganization;
    if (organization !== null && typeof organization !== 'string') {
      return { text: 'organization must be a string', isError: true };
    }
    const maxAge = args.max_age_seconds === undefined ? DEFAULT_MAX_AGE_SECONDS : toNumber(args.max_age_seconds);
    if (maxAge === null || maxAge < 0) return { text: 'max_age_seconds must be a non-negative number', isError: true };

    let snapshot = store.readSnapshot();
    const fetchedAt = toNumber(snapshot?.fetched_at);
    let refreshed = null;
    if (fetchedAt === null || clock() - fetchedAt > maxAge * 1000) {
      refreshed = await refresh(port); // the browser reads claude.ai now
      snapshot = store.readSnapshot();
    }
    const report = buildReport({
      snapshot,
      refresh: refreshed,
      organization: organization && organization.trim() ? organization : null,
      port,
      now: clock(),
    });
    return { report, isError: !report.ok };
  };
}
