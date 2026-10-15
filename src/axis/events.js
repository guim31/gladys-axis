// -----------------------------------------------------------------------------
// The live events of one Axis device, kept open for the life of the
// integration, whichever transport its firmware offers:
//
//   - WebSocket (`/vapix/ws-data-stream?sources=events`), when the device
//     lists the "event-streaming-over-websocket" API (recent AXIS OS): a
//     15-second token from wssession.cgi opens it, then `events:configure`
//     subscribes to every topic. Over the HTTP port, HTTPS included;
//   - otherwise the RTSP metadata stream (src/axis/rtsp.js), on every
//     firmware. A WebSocket that fails twice without ever opening (and not
//     because of the password) gives way to RTSP until the next restart.
//
// A stream that closes after a while is reopened at once; one that fails is
// retried with a growing delay (5 s doubling up to 5 min). A refused
// password stops the stream: the hub restarts it once the device accepts the
// credentials again (src/hub.js).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { AuthSession, AxisError, CONTEXT, ERROR_KINDS } from './client.js';
import { parseNotification } from './metadata.js';
import { RtspMetadataStream } from './rtsp.js';
import { openWebSocket } from './websocket.js';

export const STREAM_TIMINGS = {
  quickRetryMs: 2_000,
  failureBaseMs: 5_000,
  failureMaxMs: 5 * 60_000,
  // An open stream shorter than this, then closed, counts as a failure.
  stableMs: 30_000,
  pingMs: 20_000,
  wsIdleMs: 60_000,
  configureTimeoutMs: 10_000,
  rtsp: {},
};

export const TRANSPORTS = Object.freeze({ WEBSOCKET: 'websocket', RTSP: 'rtsp' });

/** Subscribe to every topic (the filter of Kane610/axis). */
export const CONFIGURE_MESSAGE = {
  apiVersion: '1.0',
  context: CONTEXT,
  method: 'events:configure',
  params: { eventFilterList: [{ topicFilter: '//.' }] },
};

const AUTH_KINDS = new Set([ERROR_KINDS.AUTH, ERROR_KINDS.BLOCKED]);

/** A WebSocket carrying VAPIX notifications, as one stream. */
class WebSocketEvents extends EventEmitter {
  constructor({ device, timings }) {
    super();
    this.device = device;
    this.timings = timings;
    this.connection = null;
    this.closed = false;
  }

  async start() {
    const client = this.device.client;
    const token = await client.wsSession();
    const origin = new URL(client.origin);
    const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${origin.host}/vapix/ws-data-stream?sources=events&wssession=${encodeURIComponent(token)}`;
    const connection = await openWebSocket(url, {
      upgrade: client.transport.upgrade,
      timeoutMs: this.timings.configureTimeoutMs,
    });
    this.connection = connection;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close();
        reject(new AxisError(ERROR_KINDS.HTTP, 'No answer to events:configure'));
      }, this.timings.configureTimeoutMs);
      timer.unref?.();
      const onClose = (err) => {
        clearTimeout(timer);
        reject(err ?? new AxisError(ERROR_KINDS.HTTP, 'WebSocket closed'));
      };
      connection.once('close', onClose);
      const onMessage = (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (message?.method !== 'events:configure') {
          return;
        }
        clearTimeout(timer);
        connection.off('message', onMessage);
        connection.off('close', onClose);
        if (message.error) {
          connection.close();
          reject(
            new AxisError(
              ERROR_KINDS.REFUSED,
              `events:configure refused (error ${message.error.code ?? '?'})`,
            ),
          );
          return;
        }
        resolve();
      };
      connection.on('message', onMessage);
      connection.send(JSON.stringify(CONFIGURE_MESSAGE));
    });
    connection.on('message', (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const event = parseNotification(message);
      if (event) {
        this.emit('events', [event]);
      }
    });
    connection.on('activity', () => this.touch());
    connection.once('close', (err) => this.end(err));
    this.ping = setInterval(() => connection.ping(), this.timings.pingMs);
    this.ping.unref?.();
    this.touch();
    this.emit('open');
  }

  touch() {
    clearTimeout(this.idle);
    if (this.closed) {
      return;
    }
    this.idle = setTimeout(() => {
      this.connection?.close();
      this.end(new AxisError(ERROR_KINDS.UNREACHABLE, 'Event stream silent, closed'));
    }, this.timings.wsIdleMs);
    this.idle.unref?.();
  }

  stop() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.ping);
    clearTimeout(this.idle);
    this.connection?.close();
    this.emit('close', null);
  }

  end(err) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.ping);
    clearTimeout(this.idle);
    this.emit('close', err ?? null);
  }
}

export class EventStream {
  /**
   * @param {object} options
   * @param {import('./device.js').AxisDevice} options.device described device
   * @param {(events: object[]) => void} options.onEvents
   * @param {() => void} [options.onOpen]
   * @param {(err: Error) => void} [options.onClose] after an open stream or a failed attempt
   * @param {object} [options.timings] STREAM_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ device, onEvents, onOpen = () => {}, onClose = () => {}, timings, now }) {
    this.device = device;
    this.onEvents = onEvents;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.timings = { ...STREAM_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.current = null;
    this.open = false;
    this.running = false;
    this.failures = 0;
    this.wsFailures = 0;
    this.rtspOnly = false;
    this.timer = null;
    this.generation = 0;
    this.openedAt = null;
  }

  /** The transport the next attempt uses. */
  get transport() {
    return this.device.info?.websocketEvents && !this.rtspOnly
      ? TRANSPORTS.WEBSOCKET
      : TRANSPORTS.RTSP;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.failures = 0;
    this.attempt();
  }

  /** Start again after a stop (a refused password fixed). */
  restart() {
    this.stop();
    this.start();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    clearTimeout(this.timer);
    const current = this.current;
    this.current = null;
    this.open = false;
    current?.stop();
  }

  build() {
    const transport = this.transport;
    if (transport === TRANSPORTS.WEBSOCKET) {
      return {
        transport,
        stream: new WebSocketEvents({ device: this.device, timings: this.timings }),
      };
    }
    const client = this.device.client;
    const origin = new URL(client.origin);
    return {
      transport,
      stream: new RtspMetadataStream({
        host: origin.hostname.replace(/^\[|\]$/g, ''),
        port: this.device.info?.rtspPort ?? 554,
        auth: new AuthSession(client.credentials),
        connect: client.transport.connect,
        timings: this.timings.rtsp,
      }),
    };
  }

  async attempt() {
    if (!this.running) {
      return;
    }
    const generation = this.generation;
    const { transport, stream } = this.build();
    this.current = stream;
    stream.on('events', (events) => {
      if (generation === this.generation) {
        this.onEvents(events);
      }
    });
    try {
      await stream.start();
    } catch (err) {
      stream.stop?.();
      if (generation !== this.generation) {
        return;
      }
      this.current = null;
      this.failed(transport, err, false);
      return;
    }
    if (generation !== this.generation) {
      stream.stop();
      return;
    }
    this.open = true;
    this.openedAt = this.now();
    if (transport === TRANSPORTS.WEBSOCKET) {
      this.wsFailures = 0;
    }
    stream.once('close', (err) => {
      if (generation !== this.generation) {
        return;
      }
      this.open = false;
      this.current = null;
      const stable = this.now() - this.openedAt >= this.timings.stableMs;
      if (stable) {
        this.failures = 0;
      }
      this.failed(
        transport,
        err ?? new AxisError(ERROR_KINDS.UNREACHABLE, 'Event stream closed'),
        stable,
      );
    });
    this.onOpen(transport);
  }

  failed(transport, error, wasStable) {
    const err =
      error instanceof AxisError
        ? error
        : // A 401 on the WebSocket upgrade is an expired token, never the
          // password: only the VAPIX requests decide that.
          new AxisError(ERROR_KINDS.UNREACHABLE, error?.message ?? 'Event stream failed');
    if (AUTH_KINDS.has(err.kind)) {
      this.running = false;
      this.onClose(err);
      return;
    }
    if (transport === TRANSPORTS.WEBSOCKET && !wasStable) {
      this.wsFailures += 1;
      if (this.wsFailures >= 2) {
        this.rtspOnly = true;
        err.fallback = true;
      }
    }
    this.onClose(err);
    if (!this.running) {
      return;
    }
    let wait;
    if (wasStable) {
      wait = this.timings.quickRetryMs;
    } else {
      wait = Math.min(this.timings.failureBaseMs * 2 ** this.failures, this.timings.failureMaxMs);
      this.failures += 1;
    }
    this.timer = setTimeout(() => this.attempt(), wait);
    this.timer.unref?.();
  }
}
