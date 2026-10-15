// -----------------------------------------------------------------------------
// The RTSP metadata stream of an Axis device, the event channel of every
// firmware: `rtsp://<host>:554/axis-media/media.amp?video=0&audio=0&event=on`
// carries no video, only ONVIF XML documents (src/axis/metadata.js) in RTP.
//
// Home Assistant (Kane610/axis) receives the RTP packets over UDP. That does
// not work from a Gladys container: on its bridge network the device's UDP
// packets never find their way back. So the RTP packets are asked
// interleaved in the RTSP TCP connection itself (RFC 2326 §10.12,
// `RTP/AVP/TCP;interleaved=0-1`): one outgoing TCP connection, which crosses
// the bridge like any request.
//
// Sequence: OPTIONS, DESCRIBE (Digest, the SDP gives the metadata track),
// SETUP, PLAY, then an OPTIONS with the session every `timeout - 5` seconds
// to keep it alive. A frame is `$`, the channel, a 16-bit length, an RTP
// packet; RTP payloads are joined until the marker bit closes a document.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { parseMetadata } from './metadata.js';

export const RTSP_TIMINGS = {
  connectTimeoutMs: 10_000,
  answerTimeoutMs: 10_000,
  // Nothing at all (RTCP reports, keep-alive answers, events) for this long:
  // the connection is dead.
  idleMs: 90_000,
};

// A metadata document is a few kilobytes; a runaway one is not.
const MAX_DOCUMENT_BYTES = 256 * 1024;

export class RtspError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'RtspError';
    this.status = status;
  }
}

/** The metadata URL of a device. */
export function metadataUrl(host, port) {
  return `rtsp://${host}:${port}/axis-media/media.amp?video=0&audio=0&event=on`;
}

/** The control URL of the metadata track in an SDP, absolute. */
export function metadataControl(sdp, base) {
  const lines = String(sdp ?? '').split(/\r?\n/);
  let inApplication = false;
  let control = null;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inApplication = line.startsWith('m=application');
      continue;
    }
    if (inApplication && line.startsWith('a=control:')) {
      control = line.slice('a=control:'.length).trim();
      break;
    }
  }
  if (!control || control === '*') {
    return base;
  }
  if (/^rtsp:\/\//i.test(control)) {
    return control;
  }
  return `${base.replace(/\/?$/, '/')}${control}`;
}

/** The payload of one RTP packet, and its marker bit. */
export function rtpPayload(packet) {
  if (packet.length < 12 || packet[0] >> 6 !== 2) {
    return null;
  }
  const padding = (packet[0] & 0x20) !== 0;
  const extension = (packet[0] & 0x10) !== 0;
  const csrc = packet[0] & 0x0f;
  const marker = (packet[1] & 0x80) !== 0;
  let at = 12 + 4 * csrc;
  if (extension) {
    if (packet.length < at + 4) {
      return null;
    }
    at += 4 + 4 * packet.readUInt16BE(at + 2);
  }
  let end = packet.length;
  if (padding) {
    end -= packet[packet.length - 1];
  }
  if (at > end) {
    return null;
  }
  return { payload: packet.subarray(at, end), marker };
}

function parseResponse(head) {
  const [statusLine, ...lines] = head.split('\r\n');
  const match = statusLine.match(/^RTSP\/1\.\d\s+(\d{3})/);
  const headers = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) {
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      // Several WWW-Authenticate headers (Digest and Basic) are kept as a list.
      if (headers[name] !== undefined) {
        headers[name] = [].concat(headers[name], value);
      } else {
        headers[name] = value;
      }
    }
  }
  return { status: match ? Number(match[1]) : 0, headers, isResponse: Boolean(match) };
}

/**
 * Events: `open`, `events` (an array, see src/axis/metadata.js), `close`
 * (an Error, or null after stop()).
 */
export class RtspMetadataStream extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {object} options.auth an AuthSession (src/axis/client.js)
   * @param {Function} options.connect src/axis/transport.js connect()
   * @param {object} [options.timings] RTSP_TIMINGS overrides
   */
  constructor({ host, port, auth, connect, timings }) {
    super();
    this.host = host;
    this.port = port;
    this.url = metadataUrl(host.includes(':') ? `[${host}]` : host, port);
    this.auth = auth;
    this.connectSocket = connect;
    this.timings = { ...RTSP_TIMINGS, ...timings };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.cseq = 0;
    this.pending = new Map();
    this.session = null;
    this.document = [];
    this.documentSize = 0;
    this.closed = false;
    this.keepAlive = null;
    this.idle = null;
  }

  async start() {
    try {
      this.socket = await this.connectSocket({
        host: this.host,
        port: this.port,
        timeoutMs: this.timings.connectTimeoutMs,
      });
    } catch (err) {
      throw new RtspError(`No RTSP answer (${err.code ?? err.message})`);
    }
    this.socket.on('data', (chunk) => this.receive(chunk));
    this.socket.on('error', (err) =>
      this.end(new RtspError(`RTSP connection lost (${err.code ?? err.message})`)),
    );
    const closed = () => this.end(new RtspError('RTSP connection closed by the device'));
    this.socket.on('end', closed);
    this.socket.on('close', closed);
    this.touch();
    try {
      await this.request('OPTIONS', this.url);
      const describe = await this.request('DESCRIBE', this.url, { Accept: 'application/sdp' });
      const base = describe.headers['content-base'] ?? this.url;
      const control = metadataControl(describe.body, base);
      const setup = await this.request('SETUP', control, {
        Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1',
      });
      const session = String(setup.headers.session ?? '');
      this.session = session.split(';')[0].trim() || null;
      const timeout = Number(session.match(/timeout=(\d+)/)?.[1] ?? 60);
      await this.request('PLAY', this.url, { Range: 'npt=0.000-' });
      const every = Math.max(timeout - 5, 5) * 1000;
      this.keepAlive = setInterval(() => {
        this.request('OPTIONS', this.url).catch((err) => this.end(err));
      }, every);
      this.keepAlive.unref?.();
    } catch (err) {
      this.end(err, { emit: false });
      throw err;
    }
    this.emit('open');
  }

  /** One request, authenticated, answered with a 2xx. */
  async request(method, url, headers = {}) {
    const response = await this.auth.exchange(method, url, (auth) =>
      this.send(method, url, { ...headers, ...auth }),
    );
    if (response.status < 200 || response.status >= 300) {
      throw new RtspError(`RTSP ${method} answered ${response.status}`, response.status);
    }
    return response;
  }

  send(method, url, headers) {
    if (this.closed || !this.socket) {
      return Promise.reject(new RtspError('RTSP connection closed'));
    }
    this.cseq += 1;
    const cseq = this.cseq;
    const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${cseq}`, 'User-Agent: Gladys Axis'];
    if (this.session) {
      lines.push(`Session: ${this.session}`);
    }
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${value}`);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cseq);
        reject(new RtspError(`No answer to RTSP ${method}`));
      }, this.timings.answerTimeoutMs);
      timer.unref?.();
      this.pending.set(cseq, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  }

  receive(chunk) {
    this.touch();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length > 0 && !this.closed) {
      if (this.buffer[0] === 0x24) {
        if (this.buffer.length < 4) {
          return;
        }
        const channel = this.buffer[1];
        const length = this.buffer.readUInt16BE(2);
        if (this.buffer.length < 4 + length) {
          return;
        }
        const packet = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);
        if (channel === 0) {
          this.rtp(packet);
        }
        continue;
      }
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > 64 * 1024) {
          this.end(new RtspError('Unreadable RTSP answer'));
        }
        return;
      }
      const head = this.buffer.subarray(0, end).toString('utf8');
      const response = parseResponse(head);
      const length = Number(response.headers['content-length'] ?? 0);
      if (this.buffer.length < end + 4 + length) {
        return;
      }
      response.body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (!response.isResponse) {
        continue; // a request of the server (ANNOUNCE…): not used
      }
      const cseq = Number(response.headers.cseq);
      const pending = this.pending.get(cseq);
      if (pending) {
        this.pending.delete(cseq);
        pending.resolve(response);
      }
    }
  }

  rtp(packet) {
    const parsed = rtpPayload(packet);
    if (!parsed) {
      return;
    }
    this.document.push(parsed.payload);
    this.documentSize += parsed.payload.length;
    if (this.documentSize > MAX_DOCUMENT_BYTES) {
      this.document = [];
      this.documentSize = 0;
      return;
    }
    if (parsed.marker) {
      const xml = Buffer.concat(this.document);
      this.document = [];
      this.documentSize = 0;
      const events = parseMetadata(xml);
      if (events.length > 0) {
        this.emit('events', events);
      }
    }
  }

  touch() {
    clearTimeout(this.idle);
    if (this.closed) {
      return;
    }
    this.idle = setTimeout(
      () => this.end(new RtspError('RTSP stream silent, closed')),
      this.timings.idleMs,
    );
    this.idle.unref?.();
  }

  /** Close from our side: TEARDOWN, best effort. */
  stop() {
    if (this.closed) {
      return;
    }
    if (this.session && this.socket && !this.socket.destroyed) {
      this.cseq += 1;
      this.socket.write(
        `TEARDOWN ${this.url} RTSP/1.0\r\nCSeq: ${this.cseq}\r\nSession: ${this.session}\r\n\r\n`,
      );
    }
    this.end(null);
  }

  end(err, { emit = true } = {}) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.keepAlive);
    clearTimeout(this.idle);
    for (const pending of this.pending.values()) {
      pending.reject(err ?? new RtspError('RTSP connection closed'));
    }
    this.pending.clear();
    this.socket?.end();
    this.socket?.destroy();
    if (emit) {
      this.emit('close', err);
    }
  }
}
