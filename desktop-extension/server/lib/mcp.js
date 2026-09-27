// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).

import readline from 'node:readline';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const STRUCTURED_CONTENT_SINCE = '2025-06-18';

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export class McpServer {
  /**
   * @param {object} options
   * @param {{name: string, version: string}} options.info
   * @param {string} options.instructions
   * @param {object[]} options.tools
   * @param {(name: string, args: object) => Promise<object>} options.callTool
   *   resolves to {report, isError} or {text, isError}
   */
  constructor({ info, instructions, tools, callTool }) {
    this.info = info;
    this.instructions = instructions;
    this.tools = tools;
    this.callTool = callTool;
    this.protocolVersion = PROTOCOL_VERSIONS[0];
  }

  /** Answer one JSON-RPC message; null for notifications and responses. */
  async handle(message) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return failure(null, -32600, 'Invalid Request');
    }
    const { method, id } = message;
    if (typeof method !== 'string') {
      return 'result' in message || 'error' in message ? null : failure(id ?? null, -32600, 'Invalid Request');
    }
    if (!('id' in message)) return null; // notification
    const params = typeof message.params === 'object' && message.params !== null ? message.params : {};
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        this.protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return result(id, {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          instructions: this.instructions,
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: this.tools });
      case 'tools/call': {
        if (!this.tools.some((tool) => tool.name === params.name)) {
          return failure(id, -32602, `Unknown tool: ${params.name}`);
        }
        const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
        let outcome;
        try {
          outcome = await this.callTool(params.name, args);
        } catch (error) {
          outcome = { text: `Internal error: ${error.message}`, isError: true };
        }
        const text = outcome.report ? JSON.stringify(outcome.report, null, 2) : outcome.text;
        const value = { content: [{ type: 'text', text }], isError: Boolean(outcome.isError) };
        if (outcome.report && this.protocolVersion >= STRUCTURED_CONTENT_SINCE) value.structuredContent = outcome.report;
        return result(id, value);
      }
      default:
        return failure(id, -32601, `Method not found: ${method}`);
    }
  }

  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return failure(null, -32700, 'Parse error');
    }
    if (Array.isArray(message)) {
      // JSON-RPC batch (protocol versions before 2025-06-18)
      const replies = (await Promise.all(message.map((m) => this.handle(m)))).filter(Boolean);
      return replies.length ? replies : null;
    }
    return this.handle(message);
  }
}

export async function serveStdio(server, input = process.stdin, output = process.stdout) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const reply = await server.handleLine(line);
    if (reply) output.write(`${JSON.stringify(reply)}\n`);
  }
}
