// -----------------------------------------------------------------------------
// Simulated Axis devices, built from the fixtures (test/fixtures/axis): the
// three network seams of src/axis/transport.js, answered in memory.
//   - request(): VAPIX over HTTP with Digest authentication (a fresh nonce on
//     every challenge, qop "auth" as AXIS OS sends it): param.cgi, the JSON
//     APIs (apidiscovery, basicdeviceinfo, portmanagement, lightcontrol, the
//     control.cgi of Object Analytics), applications/list.cgi, port.cgi,
//     image.cgi, mediaclip.cgi, wssession.cgi;
//   - upgrade(): the WebSocket event stream (`events:configure`, then
//     `events:notify` messages), spoken with the codec of src/axis/websocket.js
//     from the server side;
//   - connect(): the RTSP metadata stream (Digest without qop, as Axis RTSP
//     servers ask), RTP interleaved in the TCP connection, each XML document
//     cut into several RTP packets.
// The sockets are in-memory pairs (node:stream duplexPair). `serve()` puts the
// same device on real sockets on 127.0.0.1, for the transport tests.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { duplexPair } from 'node:stream';
import { parseMetadata } from '../../src/axis/metadata.js';
import { FrameDecoder, OPCODES, acceptFor, encodeFrame } from '../../src/axis/websocket.js';

process.env.LOG_LEVEL ??= 'silent';

export const USERNAME = 'root';
export const PASSWORD = 'Secret-Axis-1';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/axis/${name}`, import.meta.url), 'utf8'));

/** The real metadata documents of Kane610/axis. */
export const METADATA = fixture('metadata.json').events;

/** A metadata document in the shape of the real ones (Kane610/axis fixtures). */
export function metadataXml({ topic, operation = 'Changed', source = {}, data = {} }) {
  const items = (entries) =>
    Object.entries(entries)
      .map(([name, value]) => `<tt:SimpleItem Name="${name}" Value="${value}"/>`)
      .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema">\n' +
    '<tt:Event><wsnt:NotificationMessage xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:tnsaxis="http://www.axis.com/2009/event/topics" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa5="http://www.w3.org/2005/08/addressing">' +
    `<wsnt:Topic Dialect="http://docs.oasis-open.org/wsn/t-1/TopicExpression/Simple">${topic}</wsnt:Topic>` +
    '<wsnt:ProducerReference><wsa5:Address>uri://00000000-0000-4000-8000-000000000000/ProducerReference</wsa5:Address></wsnt:ProducerReference>' +
    `<wsnt:Message><tt:Message UtcTime="2026-10-15T18:00:00.000000Z" PropertyOperation="${operation}">` +
    `<tt:Source>${items(source)}</tt:Source><tt:Key></tt:Key><tt:Data>${items(data)}</tt:Data>` +
    '</tt:Message></wsnt:Message></wsnt:NotificationMessage></tt:Event></tt:MetadataStream>\n'
  );
}

const AOA = 'tnsaxis:CameraApplicationPlatform/ObjectAnalytics/Device1Scenario';
const VMD = 'tnsaxis:CameraApplicationPlatform/VMD/Camera';
const PORT = 'tns1:Device/tnsaxis:IO/Port';

/** Events of the tests, beyond the real fixtures, in the same shape. */
export const EVENTS = {
  ...METADATA,
  OBJECT_ANALYTICS_S2_INIT: metadataXml({
    topic: `${AOA}2`,
    operation: 'Initialized',
    data: { active: '0' },
  }),
  personStart: metadataXml({
    topic: `${AOA}1`,
    data: { classTypes: 'human', active: '1', objectId: '7781' },
  }),
  personStop: metadataXml({ topic: `${AOA}1`, data: { active: '0' } }),
  // An AOA scenario on an older firmware: no classTypes, the scenario says.
  personStartNoClass: metadataXml({ topic: `${AOA}1`, data: { active: '1' } }),
  vehicleStart: metadataXml({
    topic: `${AOA}2`,
    data: { classTypes: 'car', active: '1', objectId: '7782' },
  }),
  vehicleStop: metadataXml({ topic: `${AOA}2`, data: { active: '0' } }),
  motionStart: METADATA.VMD4_C1P1_CHANGE,
  motionStop: metadataXml({ topic: `${VMD}1Profile1`, data: { active: '0' } }),
  VMD4_C2P1_INIT: metadataXml({
    topic: `${VMD}2Profile1`,
    operation: 'Initialized',
    data: { active: '0' },
  }),
  motion2Start: metadataXml({ topic: `${VMD}2Profile1`, data: { active: '1' } }),
  PORT_0_INPUT_INIT: metadataXml({
    topic: PORT,
    operation: 'Initialized',
    source: { port: '0' },
    data: { state: '0' },
  }),
  inputOn: metadataXml({ topic: PORT, source: { port: '0' }, data: { state: '1' } }),
  inputOff: metadataXml({ topic: PORT, source: { port: '0' }, data: { state: '0' } }),
  PORT_0_LEGACY_INIT: metadataXml({
    topic: PORT,
    operation: 'Initialized',
    source: { port: '0' },
    data: { state: '0' },
  }),
  CALL_BUTTON_INIT: metadataXml({
    topic: PORT,
    operation: 'Initialized',
    source: { port: '0' },
    data: { state: '0' },
  }),
  ring: metadataXml({ topic: PORT, source: { port: '0' }, data: { state: '1' } }),
  ringRelease: metadataXml({ topic: PORT, source: { port: '0' }, data: { state: '0' } }),
  pirOn: METADATA.PIR_CHANGE,
  pirOff: metadataXml({
    topic: 'tns1:Device/tnsaxis:Sensor/PIR',
    source: { sensor: '0' },
    data: { state: '0' },
  }),
  audioOn: metadataXml({
    topic: 'tns1:AudioSource/tnsaxis:TriggerLevel',
    source: { channel: '1' },
    data: { triggered: '1' },
  }),
  night: metadataXml({
    topic: 'tns1:VideoSource/tnsaxis:DayNightVision',
    source: { VideoSourceConfigurationToken: '1' },
    data: { day: '0' },
  }),
  tamper: metadataXml({
    topic: 'tns1:VideoSource/GlobalSceneChange/ImagingService',
    source: { Source: '0' },
    data: { State: '1' },
  }),
  irOn: metadataXml({
    topic: 'tns1:Device/tnsaxis:Light/Status',
    source: { id: '0' },
    data: { state: 'ON' },
  }),
};

/** A small JPEG-looking buffer (SOI … EOI) of a given size. */
export function jpegOfSize(size) {
  const bytes = Buffer.alloc(Math.max(size, 4), 0x11);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

function parseAuthorization(header) {
  const match = String(header ?? '').match(/^Digest\s+(.*)$/is);
  if (!match) {
    return null;
  }
  const params = {};
  for (const [, key, quoted, bare] of match[1].matchAll(
    /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi,
  )) {
    params[key.toLowerCase()] = quoted !== undefined ? quoted : bare;
  }
  return params;
}

const unreachable = () => {
  const err = new Error('connect EHOSTUNREACH');
  err.code = 'EHOSTUNREACH';
  return err;
};

export class FakeAxis {
  /**
   * @param {object} options
   * @param {string} options.name fixture: camera, legacy, doorstation, speaker, multisensor
   */
  constructor({ name, username = USERNAME, password = PASSWORD }) {
    const data = fixture(`devices/${name}.json`);
    this.name = name;
    this.data = data;
    this.username = username;
    this.password = password;
    this.realm = `AXIS_${data.basicDeviceInfo.SerialNumber}`;
    this.ports = structuredClone(data.ports ?? []);
    this.lights = structuredClone(data.lights ?? []);
    this.online = true;
    this.apiDiscovery = true;
    this.websocket = data.apiList.some((api) => api.id === 'event-streaming-over-websocket');
    this.websocketUpgrade = true;
    this.snapshot = jpegOfSize(40_000);
    this.snapshotStatus = 200;
    this.requests = [];
    this.refusals = 0;
    this.nonces = new Set();
    this.tokens = new Set();
    this.wsClients = new Set();
    this.rtspClients = new Set();
    this.rtspAttempts = 0;
    this.wsAttempts = 0;
    this.outputCommands = [];
    this.clipsPlayed = [];
    this.lightCommands = [];
    this.transport = {
      request: this.request.bind(this),
      upgrade: this.upgrade.bind(this),
      connect: this.connect.bind(this),
    };
  }

  // --- Authentication --------------------------------------------------------------

  challenge(qop = true) {
    const nonce = randomBytes(12).toString('hex');
    this.nonces.add(nonce);
    return qop
      ? `Digest realm="${this.realm}", nonce="${nonce}", algorithm=MD5, qop="auth"`
      : `Digest realm="${this.realm}", nonce="${nonce}", stale=FALSE`;
  }

  /** Whether an Authorization header is valid for this method and URI. */
  authorized(header, method, uri) {
    const params = parseAuthorization(header);
    if (!params) {
      return false;
    }
    if (!this.nonces.has(params.nonce) || params.uri !== uri) {
      return false;
    }
    const ha1 = md5(`${params.username}:${this.realm}:${this.password}`);
    const ha2 = md5(`${method}:${params.uri}`);
    const expected = params.qop
      ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:auth:${ha2}`)
      : md5(`${ha1}:${params.nonce}:${ha2}`);
    const ok = params.username === this.username && params.response === expected;
    if (!ok) {
      this.refusals += 1;
    }
    return ok;
  }

  // --- HTTP ------------------------------------------------------------------------

  async request(url, { method = 'GET', headers = {}, body } = {}) {
    const target = new URL(url);
    const path = `${target.pathname}${target.search}`;
    this.requests.push({ method, path, authorized: Boolean(headers.Authorization) });
    if (!this.online) {
      throw unreachable();
    }
    if (!this.authorized(headers.Authorization, method, path)) {
      return {
        status: 401,
        headers: { 'www-authenticate': [this.challenge(), `Basic realm="${this.realm}"`] },
        body: Buffer.from('<HTML><HEAD><TITLE>401 Unauthorized</TITLE></HEAD></HTML>'),
      };
    }
    return this.answer(target, method, body);
  }

  text(body, status = 200) {
    return { status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) };
  }

  json(data, method) {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ apiVersion: '1.0', context: 'gladys', method, data })),
    };
  }

  jsonError(method, code = 2104) {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          apiVersion: '1.0',
          method,
          error: { code, message: 'Invalid parameter' },
        }),
      ),
    };
  }

  hasApi(id) {
    return this.data.apiList.some((api) => api.id === id);
  }

  answer(target, method, body) {
    const query = target.searchParams;
    const call = method === 'POST' ? JSON.parse(String(body ?? '{}')) : null;
    switch (target.pathname) {
      case '/axis-cgi/apidiscovery.cgi':
        if (!this.apiDiscovery) {
          return this.text('Not Found', 404);
        }
        return this.json({ apiList: this.data.apiList }, 'getApiList');
      case '/axis-cgi/basicdeviceinfo.cgi':
        return this.json({ propertyList: this.data.basicDeviceInfo }, 'getAllProperties');
      case '/axis-cgi/param.cgi': {
        const group = query.get('group');
        const text = this.data.params[group];
        if (!text) {
          return this.text(`# Error: Error -1 getting param in group '${group}'\n`);
        }
        return this.text(text);
      }
      case '/axis-cgi/io/portmanagement.cgi':
        return this.portManagement(call);
      case '/axis-cgi/io/port.cgi':
        return this.portCgi(query);
      case '/axis-cgi/lightcontrol.cgi':
        return this.lightControl(call);
      case '/axis-cgi/applications/list.cgi':
        return this.data.applications
          ? this.text(this.data.applications)
          : this.text('<reply result="ok">\n</reply>');
      case '/local/objectanalytics/control.cgi':
        return this.data.objectanalytics
          ? this.json(this.data.objectanalytics, 'getConfiguration')
          : this.text('Not Found', 404);
      case '/axis-cgi/jpg/image.cgi': {
        const camera = Number(query.get('camera') ?? 1);
        const sources = this.data.params['root.ImageSource']
          ? Number(this.data.params['root.ImageSource'].match(/NbrOfSources=(\d+)/)?.[1] ?? 1)
          : 0;
        if (this.snapshotStatus !== 200) {
          return this.text('Error', this.snapshotStatus);
        }
        if (camera < 1 || camera > sources) {
          return this.text('Error: camera', 400);
        }
        this.lastSnapshotQuery = Object.fromEntries(query);
        const compression = Number(query.get('compression') ?? 30);
        // A higher compression gives a smaller file, as on a device.
        const size = Math.round(this.snapshot.length * (compression <= 30 ? 1 : 0.4));
        return {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
          body: jpegOfSize(size),
        };
      }
      case '/axis-cgi/mediaclip.cgi': {
        const clip = query.get('clip');
        if (
          query.get('action') !== 'play' ||
          !this.data.params['root.MediaClip']?.includes(`M${clip}.`)
        ) {
          return this.text('Error: invalid clip', 400);
        }
        this.clipsPlayed.push(clip);
        return this.text('OK\r\n');
      }
      case '/axis-cgi/wssession.cgi': {
        if (!this.websocket) {
          return this.text('Not Found', 404);
        }
        const token = randomBytes(8).toString('hex');
        this.tokens.add(token);
        return this.text(`${token}\r\n`);
      }
      default:
        return this.text('Not Found', 404);
    }
  }

  portManagement(call) {
    if (!this.hasApi('io-port-management')) {
      return this.text('Not Found', 404);
    }
    if (call?.method === 'getPorts') {
      return this.json({ numberOfPorts: this.ports.length, items: this.ports }, 'getPorts');
    }
    if (call?.method === 'setStateSequence') {
      const port = this.ports.find((entry) => entry.port === call.params?.port);
      if (!port || port.direction !== 'output') {
        return this.jsonError('setStateSequence');
      }
      this.outputCommands.push({ port: port.port, sequence: call.params.sequence });
      port.state = call.params.sequence.at(-1).state;
      return this.json({}, 'setStateSequence');
    }
    return this.jsonError(call?.method ?? '?', 4002);
  }

  portCgi(query) {
    if (query.has('checkactive')) {
      const lines = query
        .get('checkactive')
        .split(',')
        .map((number) => `port${number}=${this.data.activePorts?.[number] ?? 'inactive'}`);
      return this.text(`${lines.join('\n')}\n`);
    }
    const action = query.get('action');
    if (action) {
      this.outputCommands.push({ action });
      return this.text('OK\r\n');
    }
    return this.text('Error', 400);
  }

  lightControl(call) {
    if (!this.hasApi('light-control')) {
      return this.text('Not Found', 404);
    }
    const light = this.lights.find((entry) => entry.lightID === call?.params?.lightID);
    switch (call?.method) {
      case 'getLightInformation':
        return this.json({ items: this.lights }, 'getLightInformation');
      case 'getLightStatus':
        return light
          ? this.json({ status: light.lightState }, 'getLightStatus')
          : this.jsonError('getLightStatus');
      case 'activateLight':
      case 'deactivateLight':
        if (!light) {
          return this.jsonError(call.method);
        }
        light.lightState = call.method === 'activateLight';
        this.lightCommands.push(call.method);
        return this.json({}, call.method);
      default:
        return this.jsonError(call?.method ?? '?', 4002);
    }
  }

  // --- WebSocket event stream --------------------------------------------------------

  async upgrade(url, { headers = {} } = {}) {
    this.wsAttempts += 1;
    const target = new URL(url.replace(/^ws/, 'http'));
    if (!this.online) {
      throw unreachable();
    }
    const token = target.searchParams.get('wssession');
    if (
      !this.websocketUpgrade ||
      target.pathname !== '/vapix/ws-data-stream' ||
      !this.tokens.delete(token)
    ) {
      return { status: this.websocketUpgrade ? 401 : 404, headers: {}, body: Buffer.from('') };
    }
    const [client, server] = duplexPair();
    this.acceptWebSocket(server);
    return {
      status: 101,
      headers: { 'sec-websocket-accept': acceptFor(headers['Sec-WebSocket-Key']) },
      socket: client,
      head: Buffer.alloc(0),
    };
  }

  /** The server side of a WebSocket, on a socket. */
  acceptWebSocket(socket) {
    const decoder = new FrameDecoder();
    const entry = { socket, configured: false };
    this.wsClients.add(entry);
    const drop = () => this.wsClients.delete(entry);
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === OPCODES.PING) {
          socket.write(encodeFrame(OPCODES.PONG, frame.payload, { mask: false }));
        } else if (frame.opcode === OPCODES.CLOSE) {
          socket.write(encodeFrame(OPCODES.CLOSE, frame.payload, { mask: false }));
          socket.end();
          drop();
        } else if (frame.opcode === OPCODES.TEXT) {
          const message = JSON.parse(frame.payload.toString('utf8'));
          if (message.method === 'events:configure') {
            entry.configured = true;
            socket.write(
              encodeFrame(
                OPCODES.TEXT,
                JSON.stringify({
                  apiVersion: '1.0',
                  context: message.context,
                  method: 'events:configure',
                  data: {},
                }),
                { mask: false },
              ),
            );
          }
        }
      }
    });
  }

  // --- RTSP event stream -------------------------------------------------------------

  async connect({ port }) {
    this.rtspAttempts += 1;
    if (!this.online || port !== this.data.rtspPort) {
      const err = new Error('connect ECONNREFUSED');
      err.code = this.online ? 'ECONNREFUSED' : 'EHOSTUNREACH';
      throw err;
    }
    const [client, server] = duplexPair();
    this.acceptRtsp(server);
    return client;
  }

  /** The server side of an RTSP connection, on a socket. */
  acceptRtsp(socket) {
    const entry = { socket, playing: false, sequence: 0 };
    this.rtspClients.add(entry);
    const drop = () => this.rtspClients.delete(entry);
    socket.on('close', drop);
    socket.on('error', drop);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n\r\n')) >= 0) {
        const head = buffer.slice(0, end);
        buffer = buffer.slice(end + 4);
        this.rtspRequest(entry, head);
      }
    });
  }

  rtspRequest(entry, head) {
    const [requestLine, ...lines] = head.split('\r\n');
    const [method, uri] = requestLine.split(' ');
    const headers = Object.fromEntries(
      lines.map((line) => [
        line.slice(0, line.indexOf(':')).toLowerCase(),
        line.slice(line.indexOf(':') + 1).trim(),
      ]),
    );
    const reply = (status, text, extra = {}, body = '') => {
      const out = [`RTSP/1.0 ${status} ${text}`, `CSeq: ${headers.cseq}`];
      for (const [name, value] of Object.entries(extra)) {
        for (const item of [].concat(value)) {
          out.push(`${name}: ${item}`);
        }
      }
      if (body) {
        out.push('Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(body)}`);
      }
      entry.socket.write(`${out.join('\r\n')}\r\n\r\n${body}`);
    };
    if (method === 'TEARDOWN') {
      entry.socket.end();
      return;
    }
    if (method !== 'OPTIONS' && !this.authorized(headers.authorization, method, uri)) {
      reply(401, 'Unauthorized', {
        'WWW-Authenticate': [this.challenge(false), `Basic realm="${this.realm}"`],
      });
      return;
    }
    const base = `rtsp://${new URL(uri).host}/axis-media/media.amp`;
    switch (method) {
      case 'OPTIONS':
        reply(200, 'OK', {
          Public:
            'OPTIONS, DESCRIBE, ANNOUNCE, GET_PARAMETER, PAUSE, PLAY, SETUP, SET_PARAMETER, TEARDOWN',
        });
        return;
      case 'DESCRIBE':
        reply(
          200,
          'OK',
          { 'Content-Base': `${base}/` },
          'v=0\r\no=- 1 1 IN IP4 192.0.2.10\r\ns=Session streamed with GStreamer\r\nt=0 0\r\na=control:*\r\nm=application 0 RTP/AVP 98\r\na=rtpmap:98 vnd.onvif.metadata/90000\r\na=control:stream=1\r\n',
        );
        return;
      case 'SETUP':
        if (!/interleaved=0-1/.test(headers.transport ?? '') || !uri.endsWith('/stream=1')) {
          reply(461, 'Unsupported Transport');
          return;
        }
        reply(200, 'OK', {
          Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1;ssrc=1A2B3C4D;mode="PLAY"',
          Session: '24A5B6C7D8;timeout=60',
        });
        return;
      case 'PLAY':
        reply(200, 'OK', {
          Session: '24A5B6C7D8',
          'RTP-Info': `url=${base}/stream=1;seq=1;rtptime=0`,
        });
        entry.playing = true;
        for (const name of this.data.events ?? []) {
          this.writeRtp(entry, EVENTS[name]);
        }
        return;
      default:
        reply(405, 'Method Not Allowed');
    }
  }

  /** One XML document as RTP packets (several, the last one with the marker). */
  writeRtp(entry, xml) {
    const payload = Buffer.from(xml, 'utf8');
    const size = 300;
    for (let at = 0; at < payload.length; at += size) {
      const part = payload.subarray(at, at + size);
      const last = at + size >= payload.length;
      const rtp = Buffer.alloc(12);
      rtp[0] = 0x80;
      rtp[1] = (last ? 0x80 : 0) | 98;
      entry.sequence += 1;
      rtp.writeUInt16BE(entry.sequence & 0xffff, 2);
      const packet = Buffer.concat([rtp, part]);
      const frame = Buffer.alloc(4);
      frame[0] = 0x24;
      frame[1] = 0;
      frame.writeUInt16BE(packet.length, 2);
      entry.socket.write(Buffer.concat([frame, packet]));
    }
  }

  // --- Driving the device from a test ----------------------------------------------------

  /** Send an event (a name of EVENTS or a raw XML document) on every open stream. */
  emit(nameOrXml) {
    const xml = EVENTS[nameOrXml] ?? nameOrXml;
    for (const entry of this.rtspClients) {
      if (entry.playing) {
        this.writeRtp(entry, xml);
      }
    }
    for (const entry of this.wsClients) {
      if (!entry.configured) {
        continue;
      }
      for (const event of parseMetadata(xml)) {
        const message = {
          apiVersion: '1.0',
          method: 'events:notify',
          params: {
            notification: {
              topic: event.topic,
              timestamp: 1792087200000,
              message: { source: event.source, key: {}, data: event.data },
            },
          },
        };
        entry.socket.write(encodeFrame(OPCODES.TEXT, JSON.stringify(message), { mask: false }));
      }
    }
  }

  get streams() {
    return (
      [...this.rtspClients].filter((entry) => entry.playing).length +
      [...this.wsClients].filter((entry) => entry.configured).length
    );
  }

  /** Close every event stream, as a device rebooting does. */
  dropStreams() {
    for (const entry of [...this.rtspClients, ...this.wsClients]) {
      entry.socket.end();
      setImmediate(() => entry.socket.destroy());
    }
    this.rtspClients.clear();
    this.wsClients.clear();
  }

  // --- Real sockets, for the transport tests -----------------------------------------------

  /** Serve this device on 127.0.0.1 (HTTP with WebSocket, and RTSP). */
  serve() {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const answer = await this.request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: { Authorization: req.headers.authorization },
        body: Buffer.concat(chunks),
      }).catch(() => ({ status: 500, headers: {}, body: Buffer.from('Error') }));
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
    server.on('upgrade', (req, socket) => {
      const target = new URL(`http://${req.headers.host}${req.url}`);
      if (!this.tokens.delete(target.searchParams.get('wssession'))) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(req.headers['sec-websocket-key'])}\r\n\r\n`,
      );
      this.acceptWebSocket(socket);
    });
    const rtsp = net.createServer((socket) => this.acceptRtsp(socket));
    const listen = (target) =>
      new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve(target.address().port)));
    return Promise.all([listen(server), listen(rtsp)]).then(([httpPort, rtspPort]) => {
      this.data.rtspPort = rtspPort;
      return {
        origin: `http://127.0.0.1:${httpPort}`,
        rtspPort,
        close: async () => {
          this.dropStreams();
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
          await new Promise((done) => rtsp.close(done));
        },
      };
    });
  }
}

/**
 * Several devices behind one set of seams, routed by host.
 * @param {Record<string, FakeAxis>} byOrigin
 */
export function network(byOrigin) {
  const find = (url) => byOrigin[new URL(url.replace(/^ws/, 'http')).origin];
  return {
    request: (url, options) => find(url)?.request(url, options) ?? Promise.reject(unreachable()),
    upgrade: (url, options) => find(url)?.upgrade(url, options) ?? Promise.reject(unreachable()),
    connect: (options) => {
      const device = Object.entries(byOrigin).find(
        ([origin]) => new URL(origin).hostname === options.host,
      )?.[1];
      return device ? device.connect(options) : Promise.reject(unreachable());
    },
  };
}
