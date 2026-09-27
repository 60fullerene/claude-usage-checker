#!/usr/bin/env node
// Claude Desktop extension: gives Claude a get_claude_usage tool fed by the
// "Usage Bridge for Claude" browser extension.

import { createBridge, DEFAULT_PORT } from './lib/bridge.js';
import { McpServer, serveStdio } from './lib/mcp.js';
import { Store } from './lib/store.js';
import { createToolHandler, INSTRUCTIONS, TOOL } from './lib/tool.js';
import { VERSION } from './lib/version.js';

const log = (message) => process.stderr.write(`[claude-usage] ${message}\n`);

/** A user_config value, or null when unset (Claude Desktop may pass "" or the raw placeholder). */
function setting(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !text.startsWith('${') ? text : null;
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

const port = parsePort(setting(process.env.CLAUDE_USAGE_PORT)) ?? DEFAULT_PORT;
const store = new Store();
const bridge = createBridge({ port, store, version: VERSION, log });
const server = new McpServer({
  info: { name: 'claude-usage', version: VERSION },
  instructions: INSTRUCTIONS,
  tools: [TOOL],
  callTool: createToolHandler({ store, defaultOrganization: setting(process.env.CLAUDE_USAGE_ORGANIZATION) }),
});

await serveStdio(server);
await bridge.close();
process.exit(0);
