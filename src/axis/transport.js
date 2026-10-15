// -----------------------------------------------------------------------------
// The network seams of the Axis client, each one small enough to be replaced
// in the tests by the fake device (test/helpers/fakeAxis.js):
//   - request(): one HTTP(S) request answered as a whole body (VAPIX CGIs,
//     JSON APIs, snapshots);
//   - upgrade(): an HTTP(S) request upgraded to a raw socket (the WebSocket
//     event stream);
//   - connect(): a TCP connection (the RTSP metadata stream).
//
// node:http rather than fetch: an Axis device served over HTTPS has a
// self-signed certificate that fetch cannot be told to accept without a
// dependency, and the event streams stay open for hours.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// A snapshot of a 4K camera is a few hundred kilobytes; anything far larger
// is not an answer of VAPIX.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class TransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

const agentOptions = (secure) => (secure ? { rejectUnauthorized: false } : {});

/**
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {Buffer|string} [options.body]
 * @param {number} [options.timeoutMs] idle timeout of the socket
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
export function request(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const req = (secure ? https : http).request(target, {
      method,
      headers: { Connection: 'close', ...headers },
      // Axis devices present a self-signed certificate unless the owner
      // installed another one.
      ...agentOptions(secure),
    });
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err instanceof TransportError ? err : new TransportError(err.message, err.code));
      }
    };
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new TransportError(`No answer within ${Math.round(timeoutMs / 1000)} s`, 'ETIMEDOUT'),
      );
    });
    req.on('error', fail);
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new TransportError('Answer too large', 'EFBIG'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        }
      });
    });
    req.end(body);
  });
}

/**
 * An HTTP GET asking for a protocol upgrade (WebSocket).
 * @returns {Promise<{ status: number, headers: object, socket?: import('node:stream').Duplex,
 *   head?: Buffer, body?: Buffer }>} `socket` only on a 101 answer
 */
export function upgrade(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url.replace(/^ws/, 'http'));
    const secure = target.protocol === 'https:';
    const req = (secure ? https : http).request(target, {
      method: 'GET',
      headers,
      ...agentOptions(secure),
    });
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new TransportError(`No answer within ${Math.round(timeoutMs / 1000)} s`, 'ETIMEDOUT'),
      );
    });
    req.on('error', (err) =>
      finish(
        reject,
        err instanceof TransportError ? err : new TransportError(err.message, err.code),
      ),
    );
    req.on('upgrade', (res, socket, head) => {
      req.setTimeout(0);
      finish(resolve, { status: res.statusCode, headers: res.headers, socket, head });
    });
    req.on('response', (res) => {
      // Not upgraded (401, 404…): the body says why, it is small.
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        finish(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.end();
  });
}

/**
 * A TCP connection, resolved once established.
 * @returns {Promise<import('node:net').Socket>}
 */
export function connect({ host, port, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TransportError(`No answer within ${Math.round(timeoutMs / 1000)} s`, 'ETIMEDOUT'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new TransportError(err.message, err.code));
    });
  });
}

export const defaultTransport = { request, upgrade, connect };
