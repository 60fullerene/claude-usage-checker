// The WebSocket framing, driven by a raw client.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import { acceptWebSocket } from '../server/lib/ws.js';
import { connectWs } from './ws-client.js';

let server;
let port;
const received = [];

before(async () => {
  server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const connection = acceptWebSocket(req, socket, head, {
      maxMessageBytes: 100_000,
      onMessage: (text) => {
        received.push(text);
        connection.send({ echo: text.length });
      },
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => server.close());

test('text messages of every length encoding round-trip', async () => {
  const socket = await connectWs(port);
  for (const size of [5, 200, 70_000]) {
    socket.frame(0x1, 'x'.repeat(size));
    assert.deepEqual(await socket.next(), { echo: size });
  }
  socket.socket.destroy();
});

test('fragmented messages are reassembled; pings are answered', async () => {
  const socket = await connectWs(port);
  socket.frame(0x1, '{"a":', { fin: false });
  socket.frame(0x0, '1', { fin: false });
  socket.frame(0x0, '}');
  assert.deepEqual(await socket.next(), { echo: 7 });
  assert.equal(received.at(-1), '{"a":1}');
  socket.frame(0x9, 'hi');
  assert.deepEqual(await socket.next((m) => 'pong' in m), { pong: 'hi' });
  await socket.close();
});

test('protocol violations and oversized messages close the connection', async () => {
  const unmasked = await connectWs(port);
  unmasked.frame(0x1, 'hello', { mask: false });
  await unmasked.closed;
  assert.equal(unmasked.closeCode, 1002);

  const huge = await connectWs(port);
  huge.frame(0x1, 'x'.repeat(100_001));
  await huge.closed;
  assert.equal(huge.closeCode, 1009);

  const stray = await connectWs(port);
  stray.frame(0x0, 'continuation without a start');
  await stray.closed;
  assert.equal(stray.closeCode, 1002);
});

test('a malformed handshake is refused', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve('upgraded'));
    req.end();
  });
  assert.equal(status, 400);
});
