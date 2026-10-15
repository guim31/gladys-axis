// -----------------------------------------------------------------------------
// A small WebSocket client (RFC 6455), enough for the VAPIX event stream:
// text frames, ping / pong, close, fragmented messages. No dependency: the
// handshake goes through the `upgrade` seam of src/axis/transport.js
// (node:http, which accepts the self-signed certificate of a device), and the
// frames are read and written here. The fake device of the tests speaks the
// same codec from the server side (frames unmasked).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

// The event stream sends small JSON messages: a frame far larger is not one.
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** The `Sec-WebSocket-Accept` answering a key. */
export const acceptFor = (key) => createHash('sha1').update(`${key}${GUID}`).digest('base64');

/**
 * One frame. A client masks its frames (RFC 6455 §5.3), a server does not.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {object} [options] { mask: boolean, fin: boolean }
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = true, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) {
    return Buffer.concat([header, data]);
  }
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i] ^ key[i % 4];
  }
  return Buffer.concat([header, key, masked]);
}

/** Reads frames out of a byte stream, chunk by chunk. */
export class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {Array<{ fin: boolean, opcode: number, payload: Buffer }>}
   * @throws on a frame larger than MAX_MESSAGE_BYTES
   */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const buffer = this.buffer;
      if (buffer.length < 2) {
        break;
      }
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffer.length < 4) {
          break;
        }
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) {
          break;
        }
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          throw new Error('WebSocket frame too large');
        }
        length = Number(big);
        at = 10;
      }
      if (length > MAX_MESSAGE_BYTES) {
        throw new Error('WebSocket frame too large');
      }
      const keyAt = at;
      if (masked) {
        at += 4;
      }
      if (buffer.length < at + length) {
        break;
      }
      let payload = buffer.subarray(at, at + length);
      if (masked) {
        const key = buffer.subarray(keyAt, keyAt + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]));
      }
      frames.push({ fin, opcode, payload: Buffer.from(payload) });
      this.buffer = buffer.subarray(at + length);
    }
    return frames;
  }
}

export class WebSocketError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'WebSocketError';
    this.status = status;
  }
}

/**
 * An open WebSocket. Events: `message` (text), `close` (an Error, or null
 * when closed by `close()`).
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.fragments = null;
    this.closed = false;
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (err) => this.end(err));
    const closed = () => this.end(new WebSocketError('Connection closed by the device'));
    socket.on('end', closed);
    socket.on('close', closed);
    if (head?.length) {
      queueMicrotask(() => this.receive(head));
    }
  }

  receive(chunk) {
    if (this.closed) {
      return;
    }
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.end(err);
      return;
    }
    for (const frame of frames) {
      this.handle(frame);
      if (this.closed) {
        return;
      }
    }
  }

  handle({ fin, opcode, payload }) {
    this.emit('activity');
    switch (opcode) {
      case OPCODES.PING:
        this.write(OPCODES.PONG, payload);
        return;
      case OPCODES.PONG:
        return;
      case OPCODES.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.write(OPCODES.CLOSE, payload.subarray(0, 2));
        this.end(new WebSocketError(`Closed by the device (code ${code})`));
        return;
      }
      case OPCODES.TEXT:
      case OPCODES.BINARY:
        this.fragments = { opcode, parts: [payload], size: payload.length };
        break;
      case OPCODES.CONTINUATION:
        if (!this.fragments) {
          this.end(new WebSocketError('Unexpected continuation frame'));
          return;
        }
        this.fragments.parts.push(payload);
        this.fragments.size += payload.length;
        if (this.fragments.size > MAX_MESSAGE_BYTES) {
          this.end(new WebSocketError('WebSocket message too large'));
          return;
        }
        break;
      default:
        this.end(new WebSocketError(`Unknown WebSocket opcode ${opcode}`));
        return;
    }
    if (fin && this.fragments) {
      const { opcode: kind, parts } = this.fragments;
      this.fragments = null;
      if (kind === OPCODES.TEXT) {
        this.emit('message', Buffer.concat(parts).toString('utf8'));
      }
    }
  }

  write(opcode, payload) {
    if (!this.closed && !this.socket.destroyed) {
      this.socket.write(encodeFrame(opcode, payload));
    }
  }

  send(text) {
    this.write(OPCODES.TEXT, text);
  }

  ping() {
    this.write(OPCODES.PING, Buffer.from('gladys'));
  }

  /** Close from our side (no `close` error). */
  close() {
    if (this.closed) {
      return;
    }
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000);
    this.write(OPCODES.CLOSE, code);
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
    this.emit('close', null);
  }

  end(err) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.emit('close', err);
  }
}

/**
 * Open a WebSocket through the `upgrade` seam.
 * @param {string} url `ws://…` or `wss://…`
 * @param {object} options
 * @param {Function} options.upgrade src/axis/transport.js upgrade()
 * @param {number} [options.timeoutMs]
 * @returns {Promise<WebSocketConnection>}
 */
export async function openWebSocket(url, { upgrade, timeoutMs = 10_000 }) {
  const key = randomBytes(16).toString('base64');
  const answer = await upgrade(url, {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    },
    timeoutMs,
  });
  if (answer.status !== 101 || !answer.socket) {
    answer.socket?.destroy();
    throw new WebSocketError(`WebSocket refused (HTTP ${answer.status})`, answer.status);
  }
  if (answer.headers?.['sec-websocket-accept'] !== acceptFor(key)) {
    answer.socket.destroy();
    throw new WebSocketError('Invalid WebSocket handshake');
  }
  return new WebSocketConnection(answer.socket, answer.head);
}
