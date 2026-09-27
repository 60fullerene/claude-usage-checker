// The get_claude_usage tool.

import { DEMAND_MIN_AGE_MS } from './bridge.js';
import { buildReport, toNumber } from './usage.js';

export const TOOL_NAME = 'get_claude_usage';
export const DEFAULT_MAX_AGE_SECONDS = 600;

export const TOOL = {
  name: TOOL_NAME,
  title: 'Claude usage limits',
  description:
    "Report how much of the Claude subscription's usage limits remain: the rolling 5-hour window and the " +
    'weekly (7-day) window, as used/remaining percentages with reset times (plus per-model weekly limits when ' +
    'the plan has them). Call it before starting a large task and now and then during long work, so you can ' +
    'pace yourself and save or wrap up your work before a limit is reached.',
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
        description: `Readings older than this are flagged as stale (default ${DEFAULT_MAX_AGE_SECONDS}).`,
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

export const INSTRUCTIONS =
  'Use get_claude_usage to see how much of the Claude usage limits (5-hour and weekly windows) remain ' +
  'before large tasks and periodically during long-running work.';

export function createToolHandler({ store, defaultOrganization = null, clock = Date.now }) {
  return async function callTool(_name, args) {
    const unknown = Object.keys(args).filter((key) => !(key in TOOL.inputSchema.properties));
    if (unknown.length) return { text: `Unknown argument(s): ${unknown.join(', ')}`, isError: true };
    const organization = args.organization ?? defaultOrganization;
    if (organization !== null && typeof organization !== 'string') {
      return { text: 'organization must be a string', isError: true };
    }
    const maxAge = args.max_age_seconds === undefined ? DEFAULT_MAX_AGE_SECONDS : toNumber(args.max_age_seconds);
    if (maxAge === null || maxAge < 0) return { text: 'max_age_seconds must be a non-negative number', isError: true };

    const now = clock();
    const snapshot = store.readSnapshot();
    const report = buildReport({
      snapshot,
      bridgeSeenAt: store.readBridgeSeenAt(),
      organization: organization && organization.trim() ? organization : null,
      maxAgeMs: maxAge * 1000,
      now,
    });
    // Ask the browser extension for a fresher reading on its next check-in.
    if (snapshot?.fetched_at == null || now - snapshot.fetched_at > DEMAND_MIN_AGE_MS) {
      try {
        store.writeDemandAt(now);
      } catch {
        // an unwritable cache only costs freshness
      }
    }
    return { report, isError: !report.ok };
  };
}
