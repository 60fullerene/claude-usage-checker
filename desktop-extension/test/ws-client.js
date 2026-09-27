// A tiny WebSocket client for tests (Node 18 has no built-in one), with
// control over framing so the server's parser can be exercised.

import crypto from 'node:crypto';
import http from 'node:http';

export const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

export function connectWs(port, { origin = EXTENSION, path = '/v1/ws', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', Host: host };
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path, headers });
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) return reject(new Error('bad Sec-WebSocket-Accept'));
      resolve(new TestSocket(socket, head));
    });
    req.on('response', (res) => {
      res.resume();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

export class TestSocket {
  constructor(socket, head) {
    this.socket = socket;
    this.buffer = Buffer.from(head || []);
    this.messages = [];
    this.listeners = [];
    this.closeCode = null;
    this.closed = new Promise((resolve) => socket.on('close', resolve));
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on('error', () => {});
  }

  parse() {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        length = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      if (b.length < offset + length) return;
      const payload = b.subarray(offset, offset + length);
      this.buffer = b.subarray(offset + length);
      if (opcode === 0x8) this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      else if (opcode === 0xa) this.emit({ pong: payload.toString() });
      else if (opcode === 0x1) this.emit(JSON.parse(payload.toString('utf8')));
    }
  }

  emit(message) {
    this.messages.push(message);
    for (const listener of [...this.listeners]) listener(message);
  }

  /** Resolve with the next message (already received or future) that matches. */
  next(match = () => true, timeout = 3000) {
    const found = this.messages.find(match);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const listener = (message) => {
        if (!match(message)) return;
        this.messages.splice(this.messages.indexOf(message), 1);
        this.listeners.splice(this.listeners.indexOf(listener), 1);
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.splice(this.listeners.indexOf(listener), 1);
        reject(new Error('no matching message'));
      }, timeout);
      this.listeners.push(listener);
    });
  }

  frame(opcode, payload, { fin = true, mask = true } = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (data.length < 126) header = Buffer.from([0, data.length]);
    else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = (fin ? 0x80 : 0) | opcode;
    if (!mask) return this.socket.write(Buffer.concat([header, data]));
    header[1] |= 0x80;
    const key = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
    return this.socket.write(Buffer.concat([header, key, masked]));
  }

  send(message) {
    this.frame(0x1, JSON.stringify(message));
  }

  close() {
    this.frame(0x8, Buffer.from([0x03, 0xe8]));
    return this.closed;
  }
}
