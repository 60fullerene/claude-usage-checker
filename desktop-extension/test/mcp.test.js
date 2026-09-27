import assert from 'node:assert/strict';
import { test } from 'node:test';

import { McpServer, PROTOCOL_VERSIONS } from '../server/lib/mcp.js';

const REPORT = { ok: true, summary: '5h: 80% left | 7d: 60% left' };
const TOOL = { name: 'get_claude_usage', inputSchema: { type: 'object' } };

function makeServer(outcome = { report: REPORT, isError: false }) {
  const calls = [];
  const server = new McpServer({
    info: { name: 'claude-usage', version: 'test' },
    instructions: 'use it',
    tools: [TOOL],
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return { server, calls };
}

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates the protocol version', async () => {
  const { server } = makeServer();
  const init = await server.handle(req(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.instructions, 'use it');
  const future = await server.handle(req(2, 'initialize', { protocolVersion: '2099-01-01' }));
  assert.equal(future.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('tools/list and tools/call', async () => {
  const { server, calls } = makeServer();
  assert.deepEqual((await server.handle(req(1, 'tools/list'))).result.tools, [TOOL]);
  await server.handle(req(2, 'initialize', { protocolVersion: '2025-06-18' }));
  const reply = (await server.handle(req(3, 'tools/call', { name: 'get_claude_usage', arguments: { organization: 'x' } }))).result;
  assert.deepEqual(calls, [['get_claude_usage', { organization: 'x' }]]);
  assert.deepEqual(JSON.parse(reply.content[0].text), REPORT);
  assert.deepEqual(reply.structuredContent, REPORT);
  assert.equal(reply.isError, false);
});

test('older clients get no structuredContent', async () => {
  const { server } = makeServer();
  await server.handle(req(1, 'initialize', { protocolVersion: '2024-11-05' }));
  const reply = (await server.handle(req(2, 'tools/call', { name: 'get_claude_usage' }))).result;
  assert.equal('structuredContent' in reply, false);
});

test('tool failures become tool errors, not protocol errors', async () => {
  const { server } = makeServer(new Error('boom'));
  const reply = (await server.handle(req(1, 'tools/call', { name: 'get_claude_usage' }))).result;
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /boom/);
  const invalid = (await makeServer({ text: 'bad argument', isError: true }).server.handle(req(2, 'tools/call', { name: 'get_claude_usage' }))).result;
  assert.deepEqual(invalid, { content: [{ type: 'text', text: 'bad argument' }], isError: true });
});

test('protocol errors, notifications and batches', async () => {
  const { server } = makeServer();
  assert.equal((await server.handle(req(1, 'tools/call', { name: 'other' }))).error.code, -32602);
  assert.equal((await server.handle(req(2, 'resources/list'))).error.code, -32601);
  assert.equal((await server.handle('junk')).error.code, -32600);
  assert.deepEqual((await server.handle(req(3, 'ping'))).result, {});
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', id: 9, result: {} }), null);
  assert.equal((await server.handleLine('{broken')).error.code, -32700);
  const batch = await server.handleLine(JSON.stringify([req(4, 'ping'), { jsonrpc: '2.0', method: 'x' }, req(5, 'ping')]));
  assert.deepEqual(batch.map((r) => r.id), [4, 5]);
});
