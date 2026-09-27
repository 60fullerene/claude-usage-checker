// Just enough of a WebSocket server (RFC 6455) for one browser extension to
// hold a connection to us: text messages, fragmentation, ping/pong, close.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request' };

export function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Complete the opening handshake for an HTTP upgrade request; null if it is not a valid one. */
export function acceptWebSocket(req, socket, head, handlers) {
  const key = req.headers['sec-websocket-key'];
  const valid =
    String(req.headers.upgrade || '').toLowerCase() === 'websocket' &&
    req.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' &&
    Buffer.from(key, 'base64').length === 16;
  if (!valid) {
    rejectUpgrade(socket, 400);
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConnection(socket, head, handlers);
}

export class WebSocketConnection {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head bytes that arrived with the upgrade request
   * @param {{maxMessageBytes: number, onMessage: (text: string) => void, onClose?: () => void}} handlers
   */
  constructor(socket, head, handlers) {
    this.socket = socket;
    this.handlers = handlers;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.closing = false;
    this.finished = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    // The HTTP server keeps sockets half-open, so a peer that just goes away
    // (the browser quits) shows up as 'end', not 'close'.
    socket.on('end', () => {
      this.finish();
      socket.end();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (this.buffer.length) this.parse();
  }

  get open() {
    return !this.closing && !this.finished;
  }

  parse() {
    const max = this.handlers.maxMessageBytes;
    while (this.open && this.buffer.length >= 2) {
      const b = this.buffer;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      if (!(b[1] & 0x80)) return this.close(1002); // clients must mask every frame
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(max)) return this.close(1009);
        length = Number(big);
        offset = 10;
      }
      if (length > max) return this.close(1009);
      if (b.length < offset + 4 + length) return; // wait for the rest of the frame
      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + 4 + length);
      this.frame(fin, opcode, payload);
    }
  }

  frame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close
        return this.close(1000);
      case 0x9: // ping
        return this.write(0xa, payload);
      case 0xa: // pong
        return undefined;
      case 0x1: // text
      case 0x2: // binary
        if (this.fragments.length) return this.close(1002);
        break;
      case 0x0: // continuation
        if (!this.fragments.length) return this.close(1002);
        break;
      default:
        return this.close(1002);
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.handlers.maxMessageBytes) return this.close(1009);
    if (!fin) return undefined;
    const message = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];
    this.fragmentBytes = 0;
    return this.handlers.onMessage(message);
  }

  send(value) {
    this.write(0x1, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'));
  }

  write(opcode, payload) {
    if (!this.open) return;
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header.writeUInt16BE(payload.length, 2);
      header[1] = 126;
    } else {
      header = Buffer.alloc(10);
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      header[1] = 127;
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.write(0x8, payload);
    this.closing = true;
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.handlers.onClose?.();
  }
}
