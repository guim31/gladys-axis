// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle — reads, events, persons, rings, images, scene events
// — writes nothing; a failure that repeats is logged once, and its end once.
// Never a password of the configuration.
// (From guim31/gladys-dahua.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_CONFIG,
  DOOR_PASSWORD,
  PASSWORD,
  cameraIds,
  createAll,
  createWorld,
  doorIds,
  settle,
} from './helpers/world.js';

/** Capture the lines of the SDK logger at a level. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRETS = [PASSWORD, DOOR_PASSWORD];

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('a normal cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  assert.ok(
    logs.texts().some((text) => text.includes('Connected to AXIS P3268-LVE at 192.0.2.10')),
    'the start is logged',
  );
  await createAll(w);
  logs.clear();

  for (let i = 0; i < 3; i += 1) {
    await w.emit('camera', 'motionStart');
    await w.emit('camera', 'personStart');
    await w.emit('camera', 'personStop');
    await w.emit('camera', 'motionStop');
    await w.emit('camera', 'audioOn');
    await w.emit('legacy', 'pirOn');
    await w.emit('legacy', 'pirOff');
    await w.emit('doorstation', 'ring');
    await w.emit('doorstation', 'ringRelease');
    w.clock.advance(5 * 60_000);
    await w.hub.refresh();
    await w.hub.snapshotAll();
    await w.fake.widgetGet('axis', { settings: {}, language: 'en' });
  }
  await sleep(80); // the pulses end
  await settle();
  assert.deepEqual(logs.texts(), []);
  assert.ok(w.fake.sceneEvents.length >= 6);
});

test('a device that stays down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();

  w.devices.camera.online = false;
  w.devices.camera.dropStreams();
  for (let i = 0; i < 6; i += 1) {
    w.clock.advance(60_000);
    await w.hub.refresh();
    await sleep(30); // the stream retries
  }
  const lines = logs.texts();
  const count = (pattern) => lines.filter((text) => text.includes(pattern)).length;
  assert.equal(count('Cannot read the device at 192.0.2.10'), 1, lines.join('\n'));
  assert.equal(count('Live events of 192.0.2.10'), 1, lines.join('\n'));
  assert.equal(count('192.0.2.10 is offline'), 1, lines.join('\n'));
  assert.equal(lines.length, 3, lines.join('\n'));

  logs.clear();
  w.devices.camera.online = true;
  await w.hub.refresh();
  await w.streamsOpen();
  await w.hub.refresh();
  const back = logs.texts();
  const again = (pattern) => back.filter((text) => pattern.test(text)).length;
  assert.equal(again(/answers again after 5 min/), 1, back.join('\n'));
  assert.equal(again(/connected again/), 1, back.join('\n'));
  assert.equal(again(/online again/), 1, back.join('\n'));
  assert.equal(back.length, 3, back.join('\n'));
});

test('a refused password is logged once, its repeats only at debug; never a password', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, {
    config: { ...BASE_CONFIG, password_2: 'wrong-door-secret-value' },
  });
  for (let i = 0; i < 5; i += 1) {
    await w.hub.refresh();
    await sleep(20);
  }
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(warnings.length, 1, logs.texts().join('\n'));
  assert.match(
    warnings[0].text,
    /Cannot read the device at 192\.0\.2\.20: User name or password refused/,
  );
  assert.equal(w.devices.doorstation.refusals, 1, 'one refused attempt, never a second');
  const all = logs.texts().join('\n');
  for (const secret of [...SECRETS, 'wrong-door-secret-value']) {
    assert.ok(!all.includes(secret), secret);
  }
});

test('a camera that stops sending images is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  await createAll(w);
  logs.clear();
  w.devices.multisensor.snapshotStatus = 500;
  for (let i = 0; i < 4; i += 1) {
    w.clock.advance(10 * 60_000);
    await w.hub.snapshotAll();
  }
  const failing = logs.texts();
  // One line per video source of the multi-sensor camera.
  assert.equal(failing.length, 2, failing.join('\n'));
  assert.ok(failing.every((text) => text.includes('No image from')));
  logs.clear();
  w.devices.multisensor.snapshotStatus = 200;
  w.clock.advance(10 * 60_000);
  await w.hub.snapshotAll();
  assert.equal(logs.texts().length, 2, logs.texts().join('\n'));
  assert.ok(logs.texts().every((text) => text.includes('back')));
});

test('a user command is one line; the stream address never holds the password', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: { ...BASE_CONFIG, allow_outputs: true } });
  await createAll(w);
  logs.clear();
  const camera = w.fake.discoveredDevices.find((d) => d.external_id === cameraIds(w.gladys).device);
  const ir = camera.features.find((f) => f.external_id.endsWith(':ir_light'));
  await w.fake.setValue(camera, ir, 1);
  assert.deepEqual(logs.texts().length, 1);
  assert.match(logs.texts()[0], /AXIS P3268-LVE: infrared light on/);
  logs.clear();
  const ack = await w.fake.action('stream_url', { camera: camera.external_id });
  assert.equal(logs.texts().length, 1);
  assert.ok(!JSON.stringify(ack).includes(PASSWORD));
  assert.match(ack.data.message.en, /rtsp:\/\/root:PASSWORD@192\.0\.2\.10:554\/axis-media/);
  logs.clear();
  await w.fake.sceneAction('set_output', {
    device: doorIds(w.gladys).device,
    output: '1',
    mode: 'pulse_3',
  });
  assert.equal(logs.texts().length, 1);
  assert.match(logs.texts()[0], /Door lock of AXIS I8116-E: pulse_3/);
});

test('LOG_LEVEL=debug shows the events and the reads; never a password', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t);
  await w.emit('camera', 'personStart');
  w.devices.legacy.online = false;
  await w.hub.refresh();
  await w.hub.refresh();
  const text = logs.texts().join('\n');
  assert.match(text, /\[DEBUG\].*ObjectAnalytics\/Device1Scenario1 \(Changed\) of 192\.0\.2\.10/);
  assert.match(text, /\[DEBUG\].*Cannot read the device at 192\.0\.2\.11/);
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), secret);
  }
});
