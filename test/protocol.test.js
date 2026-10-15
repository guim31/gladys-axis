// -----------------------------------------------------------------------------
// The protocol layer, piece by piece: the parsers on the real metadata
// documents of Kane610/axis, the event model, the VAPIX client and its
// authentication discipline, the WebSocket codec, and both event transports
// against the fake device (in memory, then on real sockets on 127.0.0.1).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthSession, AxisClient, Credentials, ERROR_KINDS } from '../src/axis/client.js';
import { AxisDevice, mediaClips, snapshotResolution, sourceCount } from '../src/axis/device.js';
import { EventStream, TRANSPORTS } from '../src/axis/events.js';
import { parseMetadata, parseNotification } from '../src/axis/metadata.js';
import { KEYS, inputKey, interpret } from '../src/axis/model.js';
import { parseApplications, parseParams } from '../src/axis/parse.js';
import { metadataControl, rtpPayload } from '../src/axis/rtsp.js';
import { defaultTransport } from '../src/axis/transport.js';
import { FrameDecoder, OPCODES, encodeFrame } from '../src/axis/websocket.js';
import { EVENTS, FakeAxis, METADATA, PASSWORD, USERNAME } from './helpers/fakeAxis.js';

const ORIGIN = 'http://192.0.2.10';

function clientFor(fake, { password = PASSWORD } = {}) {
  return new AxisClient({
    origin: ORIGIN,
    username: USERNAME,
    password,
    transport: fake.transport,
  });
}

async function describedDevice(name, overrides = {}) {
  const fake = new FakeAxis({ name });
  Object.assign(fake, overrides);
  const device = new AxisDevice({
    host: { origin: ORIGIN, label: '192.0.2.10', username: USERNAME, password: PASSWORD },
    transport: fake.transport,
  });
  await device.describe();
  return { fake, device };
}

const waitFor = async (condition, ms = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// --- Parsers -------------------------------------------------------------------------

test('every real metadata document of Kane610/axis parses to its topic, source and data', () => {
  assert.deepEqual(parseMetadata(METADATA.FIRST_MESSAGE), []);
  assert.deepEqual(parseMetadata(METADATA.OBJECT_ANALYTICS_ANY_CHANGE), [
    {
      topic: 'tnsaxis:CameraApplicationPlatform/ObjectAnalytics/Device1Scenario1',
      operation: 'Changed',
      source: {},
      data: { classTypes: 'human', active: '1', objectId: '234232' },
    },
  ]);
  assert.deepEqual(parseMetadata(METADATA.PORT_0_INIT)[0], {
    topic: 'tns1:Device/tnsaxis:IO/Port',
    operation: 'Initialized',
    source: { port: '1' },
    data: { state: '0' },
  });
  for (const [name, xml] of Object.entries(METADATA)) {
    if (name !== 'FIRST_MESSAGE') {
      const [event] = parseMetadata(xml);
      assert.ok(event?.topic, name);
      assert.ok(['Initialized', 'Changed'].includes(event.operation), name);
    }
  }
});

test('a WebSocket notification parses to the same shape', () => {
  const event = parseNotification({
    apiVersion: '1.0',
    method: 'events:notify',
    params: {
      notification: {
        topic: 'tns1:Device/tnsaxis:IO/VirtualPort',
        timestamp: 1621413216131,
        message: { source: { port: '1' }, key: {}, data: { state: '0' } },
      },
    },
  });
  assert.deepEqual(event, {
    topic: 'tns1:Device/tnsaxis:IO/VirtualPort',
    operation: 'Changed',
    source: { port: '1' },
    data: { state: '0' },
  });
  assert.equal(parseNotification({ method: 'events:configure' }), null);
  assert.equal(parseNotification({ method: 'events:notify', params: {} }), null);
});

test('param.cgi lines, applications, resolutions, sources and clips', () => {
  assert.deepEqual(
    parseParams(
      "root.Brand.ProdNbr=M1065-LW\n# Error: Error -1 getting param in group 'root.X'\nroot.Brand.WebURL=http://www.axis.com\n",
    ),
    { 'Brand.ProdNbr': 'M1065-LW', 'Brand.WebURL': 'http://www.axis.com' },
  );
  assert.deepEqual(
    parseApplications(
      '<reply result="ok">\n <application Name="vmd" NiceName="AXIS Video Motion Detection" Status="Running" />\n</reply>',
    ),
    [{ name: 'vmd', niceName: 'AXIS Video Motion Detection', status: 'Running' }],
  );
  assert.equal(
    snapshotResolution('1920x1080,1280x960,1280x720,1024x768,800x600,640x480,640x360,320x240'),
    '640x360',
  );
  assert.equal(snapshotResolution('2592x1944,1920x1440,1280x960,640x480,320x240'), '640x480');
  assert.equal(snapshotResolution(''), null);
  assert.equal(sourceCount({ 'ImageSource.NbrOfSources': '4' }), 4);
  assert.equal(sourceCount({ 'ImageSource.I0.Name': 'a', 'ImageSource.I1.Name': 'b' }), 2);
  assert.equal(sourceCount({}), 1);
  assert.deepEqual(
    mediaClips({
      'MediaClip.M1.Name': 'Alarm',
      'MediaClip.M1.Type': 'audio',
      'MediaClip.M0.Name': 'Logo',
      'MediaClip.M0.Type': 'image',
    }),
    [{ id: '1', name: 'Alarm' }],
  );
});

// --- Event model -----------------------------------------------------------------------

const context = {
  channels: 2,
  ports: new Map([
    ['0', { id: '0', direction: 'input', doorbell: false }],
    ['1', { id: '1', direction: 'output' }],
    ['2', { id: '2', direction: 'input', doorbell: true }],
  ]),
  scenarioClasses: new Map([['3', ['human']]]),
  lights: new Map([['led0', { id: 'led0', type: 'IR' }]]),
};
const effectsOf = (xml) => interpret(parseMetadata(xml)[0], context).effects;

test('motion, objects, persons and vehicles land on their video source', () => {
  assert.deepEqual(effectsOf(METADATA.VMD4_C1P1_CHANGE), [
    { channel: 0, key: KEYS.MOTION, source: 'VMD:1:1', on: true },
    { channel: 0, key: KEYS.PERSON, source: 'VMD:1:1', on: false },
    { channel: 0, key: KEYS.VEHICLE, source: 'VMD:1:1', on: false },
  ]);
  assert.equal(effectsOf(EVENTS.motion2Start)[0].channel, 1);
  assert.deepEqual(effectsOf(METADATA.OBJECT_ANALYTICS_ANY_CHANGE), [
    { channel: 0, key: KEYS.OBJECT, source: 'aoa:1:1', on: true },
    { channel: 0, key: KEYS.PERSON, source: 'aoa:1:1', on: true },
    { channel: 0, key: KEYS.VEHICLE, source: 'aoa:1:1', on: false },
  ]);
  // No classTypes in the event: the scenario configuration says.
  const scenario3 = interpret(
    {
      topic: 'tnsaxis:CameraApplicationPlatform/ObjectAnalytics/Device1Scenario3',
      source: {},
      data: { active: '1' },
    },
    context,
  ).effects;
  assert.equal(scenario3.find((effect) => effect.key === KEYS.PERSON).on, true);
  assert.equal(effectsOf(METADATA.VMD3_INIT)[0].key, KEYS.MOTION);
  assert.equal(effectsOf(METADATA.RULE_ENGINE_REGION_DETECTOR_INIT)[0].key, KEYS.MOTION);
  assert.equal(effectsOf(METADATA.FENCE_GUARD_INIT)[0].key, KEYS.MOTION);
});

test('sensors, inputs, the call button, day and night, the infrared light', () => {
  assert.deepEqual(effectsOf(METADATA.PIR_CHANGE), [
    { channel: 0, key: KEYS.PIR, source: 'pir:0', on: true },
  ]);
  assert.equal(effectsOf(EVENTS.audioOn)[0].key, KEYS.AUDIO);
  assert.equal(effectsOf(EVENTS.tamper)[0].key, KEYS.TAMPER);
  assert.deepEqual(effectsOf(EVENTS.night), [
    { channel: 0, key: KEYS.NIGHT, source: 'daynight', on: true },
  ]);
  assert.deepEqual(effectsOf(METADATA.DAYNIGHT_INIT), [
    { channel: 0, key: KEYS.NIGHT, source: 'daynight', on: false },
  ]);
  assert.deepEqual(effectsOf(EVENTS.inputOn), [
    { channel: 0, key: inputKey('0'), source: 'port:0', on: true },
  ]);
  // Port -1 is "any port": ignored.
  assert.deepEqual(effectsOf(METADATA.PORT_ANY_INIT), []);
  const ring = (state) =>
    interpret(
      { topic: 'tns1:Device/tnsaxis:IO/Port', source: { port: '2' }, data: { state } },
      context,
    ).effects;
  assert.deepEqual(ring('1'), [{ channel: 0, key: KEYS.RING, pulse: true, on: true }]);
  assert.deepEqual(ring('0'), []);
  assert.deepEqual(effectsOf(EVENTS.irOn), [
    { channel: 0, key: KEYS.IR_LIGHT, setting: 'irLight', value: true },
  ]);
  assert.deepEqual(effectsOf(METADATA.LIGHT_STATUS_INIT)[0].value, false);
  // Topics without a feature are ignored.
  assert.deepEqual(effectsOf(METADATA.PTZ_MOVE_START), []);
  assert.deepEqual(effectsOf(METADATA.STORAGE_ALERT_INIT), []);
  assert.deepEqual(effectsOf(METADATA.RELAY_INIT), []);
});

// --- VAPIX client ------------------------------------------------------------------------

test('the client signs every request with Digest, POST bodies included', async () => {
  const fake = new FakeAxis({ name: 'camera' });
  const client = clientFor(fake);
  await client.discoverApis();
  assert.equal(client.apiVersion('basic-device-info'), '1.1');
  const identity = await client.identity();
  assert.deepEqual(identity, {
    serial: 'ACCC8E1A2B3C',
    model: 'P3268-LVE',
    name: 'AXIS P3268-LVE Dome Camera',
    productType: 'Dome Camera',
    firmware: '11.11.112',
  });
  assert.equal(fake.refusals, 0);
  // One challenge, then the nonce is reused with a growing counter.
  const unsigned = fake.requests.filter((request) => !request.authorized).length;
  assert.equal(unsigned, 1);
});

test('an old firmware without API discovery is read through param.cgi', async () => {
  const fake = new FakeAxis({ name: 'legacy' });
  fake.apiDiscovery = false;
  const client = clientFor(fake);
  assert.equal((await client.discoverApis()).size, 0);
  fake.data.params['root.Brand'] =
    'root.Brand.ProdNbr=M1065-LW\nroot.Brand.ProdFullName=AXIS M1065-LW Network Camera\nroot.Brand.ProdType=Network Camera\n';
  fake.data.params['root.Properties.System'] = 'root.Properties.System.SerialNumber=ACCC8E4D5E6F\n';
  fake.data.params['root.Properties.Firmware'] = 'root.Properties.Firmware.Version=6.50.5\n';
  assert.deepEqual(await client.identity(), {
    serial: 'ACCC8E4D5E6F',
    model: 'M1065-LW',
    name: 'AXIS M1065-LW Network Camera',
    productType: 'Network Camera',
    firmware: '6.50.5',
  });
  assert.deepEqual(await client.ports(), [
    {
      id: '0',
      direction: 'input',
      name: 'PIR sensor',
      state: null,
      normalState: 'open',
      configurable: false,
    },
  ]);
});

test('a refused password stops every request at once, until unblocked', async () => {
  const fake = new FakeAxis({ name: 'camera' });
  const client = clientFor(fake, { password: 'wrong-password-value' });
  await assert.rejects(client.discoverApis(), { kind: ERROR_KINDS.AUTH });
  assert.equal(fake.refusals, 1, 'one refused attempt, never a second');
  const before = fake.requests.length;
  await assert.rejects(client.identity(), { kind: ERROR_KINDS.BLOCKED });
  assert.equal(fake.requests.length, before, 'nothing sent while blocked');
  client.credentials.password = PASSWORD;
  client.unblock();
  await client.discoverApis();
  assert.ok(client.apis.size > 0);
});

test('a reused nonce the device dropped is not a wrong password', async () => {
  const fake = new FakeAxis({ name: 'camera' });
  const client = clientFor(fake);
  await client.discoverApis();
  fake.nonces.clear(); // the device rebooted: its nonces are gone
  await client.identity();
  assert.equal(client.blocked, false);
});

test('outputs: a pulse through port management, or port.cgi on old firmwares', async () => {
  const { fake, device } = await describedDevice('doorstation');
  const relay = device.output(1);
  assert.equal(relay.name, 'Door lock');
  await device.client.setOutput(relay, { pulseMs: 3000 });
  assert.deepEqual(fake.outputCommands.at(-1), {
    port: '1',
    sequence: [
      { state: 'closed', time: 3000 },
      { state: 'open', time: 0 },
    ],
  });
  const legacy = new FakeAxis({ name: 'legacy' });
  const client = clientFor(legacy);
  await client.setOutput({ id: '0', normalState: 'open' }, { pulseMs: 1000 });
  await client.setOutput({ id: '0', normalState: 'open' }, { active: true });
  assert.deepEqual(legacy.outputCommands, [{ action: '1:/1000\\' }, { action: '1:/' }]);
});

test('describe: identity, video sources, ports and call button, lights, clips, scenarios', async () => {
  const { device } = await describedDevice('camera');
  const info = device.info;
  assert.equal(info.serial, 'ACCC8E1A2B3C');
  assert.equal(info.hasVideo, true);
  assert.equal(info.channels.length, 1);
  assert.equal(info.snapshotResolution, '640x360');
  assert.equal(info.irLight, 'led0');
  assert.deepEqual(
    info.clips.map((clip) => clip.name),
    ['Camera clicks', 'Alarm', 'Welcome'],
  );
  assert.deepEqual(
    info.scenarios.map((s) => [s.id, s.name, s.classes]),
    [
      ['1', 'Driveway', ['human']],
      ['2', 'Street', ['vehicle']],
    ],
  );
  assert.equal(info.websocketEvents, true);
  const door = (await describedDevice('doorstation')).device.info;
  assert.equal(door.doorStation, true);
  assert.equal(door.ports.find((port) => port.id === '0').doorbell, true);
  const speaker = (await describedDevice('speaker')).device.info;
  assert.equal(speaker.hasVideo, false);
  assert.equal(speaker.channels.length, 1);
  assert.equal((await describedDevice('multisensor')).device.info.channels.length, 2);
});

test('a snapshot is asked at a resolution the device scales itself', async () => {
  const fake = new FakeAxis({ name: 'camera' });
  const client = clientFor(fake);
  const jpeg = await client.snapshot(1, { resolution: '640x360' });
  assert.equal(jpeg[0], 0xff);
  assert.deepEqual(fake.lastSnapshotQuery, {
    camera: '1',
    resolution: '640x360',
    compression: '30',
  });
});

// --- WebSocket codec ----------------------------------------------------------------------

test('the WebSocket codec reads masked, unmasked, long and split frames', () => {
  const decoder = new FrameDecoder();
  const long = 'x'.repeat(70_000);
  const frames = Buffer.concat([
    encodeFrame(OPCODES.TEXT, 'hello', { mask: true }),
    encodeFrame(OPCODES.TEXT, long, { mask: false }),
    encodeFrame(OPCODES.PING, 'p', { mask: false }),
  ]);
  const out = [];
  for (let at = 0; at < frames.length; at += 1000) {
    out.push(...decoder.push(frames.subarray(at, at + 1000)));
  }
  assert.deepEqual(
    out.map((frame) => [frame.opcode, frame.payload.length]),
    [
      [OPCODES.TEXT, 5],
      [OPCODES.TEXT, 70_000],
      [OPCODES.PING, 1],
    ],
  );
  assert.equal(out[0].payload.toString(), 'hello');
});

test('RTP payloads and the SDP control of the metadata track', () => {
  const packet = Buffer.concat([
    Buffer.from([0x90, 0xe2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0xbe, 0xde, 0, 1, 1, 2, 3, 4]),
    Buffer.from('<x/>'),
  ]);
  const parsed = rtpPayload(packet);
  assert.equal(parsed.payload.toString(), '<x/>');
  assert.equal(parsed.marker, true);
  const sdp =
    'v=0\r\nm=video 0 RTP/AVP 96\r\na=control:stream=0\r\nm=application 0 RTP/AVP 98\r\na=control:stream=1\r\n';
  assert.equal(
    metadataControl(sdp, 'rtsp://192.0.2.10/axis-media/media.amp/'),
    'rtsp://192.0.2.10/axis-media/media.amp/stream=1',
  );
  assert.equal(
    metadataControl('m=application 0 RTP/AVP 98\r\na=control:rtsp://h/x/trackID=2\r\n', 'b'),
    'rtsp://h/x/trackID=2',
  );
});

// --- Event streams ----------------------------------------------------------------------------

async function openStream(device, timings = {}) {
  const received = [];
  const closes = [];
  let opened = null;
  const stream = new EventStream({
    device,
    onEvents: (events) => received.push(...events),
    onOpen: (transport) => {
      opened = transport;
    },
    onClose: (err) => closes.push(err),
    timings: { failureBaseMs: 10, failureMaxMs: 20, quickRetryMs: 10, ...timings },
  });
  stream.start();
  return { stream, received, closes, opened: () => opened };
}

test('the WebSocket stream: token, configure, notifications', async (t) => {
  const { fake, device } = await describedDevice('camera');
  const { stream, received, opened } = await openStream(device);
  t.after(() => stream.stop());
  await waitFor(() => stream.open);
  assert.equal(opened(), TRANSPORTS.WEBSOCKET);
  fake.emit('personStart');
  await waitFor(() => received.length > 0);
  assert.deepEqual(received[0].data, { classTypes: 'human', active: '1', objectId: '7781' });
});

test('the RTSP stream: Digest, SETUP interleaved, documents cut in RTP packets', async (t) => {
  const { fake, device } = await describedDevice('legacy');
  const { stream, received, opened } = await openStream(device);
  t.after(() => stream.stop());
  await waitFor(() => stream.open);
  assert.equal(opened(), TRANSPORTS.RTSP);
  // The Initialized states the device sends at the start.
  await waitFor(() => received.length >= 4);
  assert.deepEqual(
    received.map((event) => event.topic),
    [
      'tns1:Device/tnsaxis:Sensor/PIR',
      'tnsaxis:CameraApplicationPlatform/VMD/Camera1ProfileANY',
      'tnsaxis:CameraApplicationPlatform/VMD/Camera1Profile1',
      'tns1:Device/tnsaxis:IO/Port',
    ],
  );
  fake.emit('pirOn');
  await waitFor(() => received.length >= 5);
  assert.equal(received[4].data.state, '1');
  assert.equal(fake.refusals, 0);
});

test('a WebSocket that never opens gives way to RTSP', async (t) => {
  const { fake, device } = await describedDevice('camera');
  fake.websocketUpgrade = false;
  const { stream, closes } = await openStream(device);
  t.after(() => stream.stop());
  await waitFor(() => stream.open);
  assert.equal(stream.transport, TRANSPORTS.RTSP);
  assert.equal(fake.wsAttempts, 2);
  assert.equal(closes.at(-1).fallback, true);
});

test('a stream closed by the device is reopened; a refused password stops it', async (t) => {
  const { fake, device } = await describedDevice('legacy');
  const { stream, closes } = await openStream(device);
  t.after(() => stream.stop());
  await waitFor(() => stream.open);
  fake.dropStreams();
  await waitFor(() => closes.length === 1);
  await waitFor(() => stream.open);
  assert.equal(fake.rtspAttempts, 2);
  fake.password = 'changed-on-the-device';
  fake.dropStreams();
  await waitFor(() => !stream.running);
  assert.equal(closes.at(-1).kind, ERROR_KINDS.AUTH);
  assert.equal(fake.refusals, 1);
});

test('the real sockets: HTTP, WebSocket upgrade and RTSP on 127.0.0.1', async (t) => {
  for (const name of ['camera', 'legacy']) {
    const fake = new FakeAxis({ name });
    const server = await fake.serve();
    t.after(() => server.close());
    const device = new AxisDevice({
      host: { origin: server.origin, label: server.origin, username: USERNAME, password: PASSWORD },
      transport: defaultTransport,
    });
    await device.describe();
    device.info.rtspPort = server.rtspPort;
    const { stream, received } = await openStream(device);
    await waitFor(() => stream.open);
    fake.emit('motionStart');
    await waitFor(() => received.some((event) => event.data.active === '1'));
    stream.stop();
  }
});

test('an AuthSession answers a challenge offering Digest and Basic with Digest', async () => {
  const session = new AuthSession(new Credentials(USERNAME, PASSWORD));
  const fake = new FakeAxis({ name: 'camera' });
  const path = '/axis-cgi/param.cgi?action=list&group=root.Brand.ProdNbr';
  const seen = [];
  const answer = await session.exchange('GET', path, async (headers) => {
    seen.push(headers.Authorization?.split(' ')[0] ?? 'none');
    return fake.request(`${ORIGIN}${path}`, { headers });
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, ['none', 'Digest']);
});
