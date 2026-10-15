// -----------------------------------------------------------------------------
// The hub end to end, against the fake devices: what reaches Gladys (states,
// images, scene events, discovered devices, statuses) for what the devices
// say, and what the devices receive for what Gladys asks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { MAX_CAMERA_IMAGE } from '../src/image.js';
import {
  BASE_CONFIG,
  cameraIds,
  createAll,
  createDevices,
  createWorld,
  doorIds,
  legacyIds,
  multiIds,
  settle,
  speakerIds,
} from './helpers/world.js';
import { jpegOfSize } from './helpers/fakeAxis.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const featureIds = (w, device) =>
  w.fake.discoveredDevices
    .find((entry) => entry.external_id === device)
    .features.map((feature) => feature.external_id.split(':').at(-1));

test('the states refresh on the integration timer, without any onPoll', async (t) => {
  const w = await world(t, {
    timers: true,
    timings: { refreshMs: 30, fallbackRefreshMs: 30 },
  });
  await createAll(w);
  const input = cameraIds(w.gladys).feature('input_0');
  assert.equal(w.fake.lastState(input), 0);
  // The garden gate opens while no event says so: the next read sees it.
  w.devices.camera.ports[0].state = 'closed';
  await sleep(120);
  assert.equal(w.fake.lastState(input), 1);
  const ir = cameraIds(w.gladys).feature('ir_light');
  w.devices.camera.lights[0].lightState = true;
  await sleep(120);
  assert.equal(w.fake.lastState(ir), 1);
  // Gladys never polled: no poll request ever reached the integration.
  assert.ok(!w.fake.wsMessages.some((message) => /poll/i.test(JSON.stringify(message))));
});

test('only the changes are published, with a heartbeat for the stable values', async (t) => {
  const w = await world(t);
  await createAll(w);
  const calls = [];
  const original = w.gladys.publishChangedStates.bind(w.gladys);
  t.mock.method(w.gladys, 'publishChangedStates', (states, options) => {
    calls.push(options);
    return original(states, options);
  });
  const before = w.fake.states.length;
  await w.hub.refresh();
  await w.hub.refresh();
  assert.equal(w.fake.states.length, before, 'nothing changed, nothing sent');
  assert.ok(calls.length > 0);
  assert.ok(calls.every((options) => options.heartbeat <= 12 * 60 * 60_000));
});

test('one sensor per event present: learned, kept in /data, there at the next start', async (t) => {
  const w = await world(t);
  const camera = cameraIds(w.gladys).device;
  assert.ok(!featureIds(w, camera).includes('audio'));
  await w.emit('camera', 'audioOn');
  await w.emit('camera', 'tamper');
  await w.emit('camera', 'night');
  assert.deepEqual(
    featureIds(w, camera).filter((key) => ['audio', 'tamper', 'night_mode'].includes(key)),
    ['audio', 'tamper', 'night_mode'],
  );
  // The legacy camera reported its PIR at the start of its RTSP stream.
  assert.ok(featureIds(w, legacyIds(w.gladys).device).includes('pir'));
  await w.app.stop();

  // Next start: every device off, the description and the learned features stay.
  const devices = createDevices();
  for (const device of Object.values(devices)) {
    device.online = false;
  }
  const next = await world(t, { dataDir: w.dataDir, devices, connect: false });
  await next.gladys.connect();
  await next.app.ready;
  await settle();
  assert.equal(next.fake.discoveredDevices.length, 6);
  assert.ok(featureIds(next, camera).includes('night_mode'));
  assert.equal(next.fake.connectionStatus.connected, false);
});

test('a person: the image first, then one scene event; Initialized states fire nothing', async (t) => {
  const w = await world(t);
  await createAll(w);
  const camera = cameraIds(w.gladys);
  w.clock.advance(10_000); // the image of the creation is no longer fresh
  const images = w.fake.cameraImages.length;
  w.devices.camera.emit('OBJECT_ANALYTICS_INIT');
  await settle();
  assert.equal(w.fake.sceneEvents.length, 0);

  await w.emit('camera', 'personStart');
  assert.equal(w.fake.lastState(camera.feature('person')), 1);
  assert.equal(w.fake.lastState(camera.feature('object')), 1);
  assert.equal(w.fake.lastState(camera.feature('vehicle')), 0);
  assert.equal(w.fake.cameraImages.length, images + 1, 'the fresh image');
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: 'person_detected',
      data: { camera: camera.device, camera_name: 'AXIS P3268-LVE', rule_name: 'Driveway' },
    },
  ]);
  // Still there, then gone and back within 15 s: one event.
  await w.emit('camera', 'personStart');
  await w.emit('camera', 'personStop');
  assert.equal(w.fake.lastState(camera.feature('person')), 0);
  await w.emit('camera', 'personStart');
  assert.equal(w.fake.sceneEvents.length, 1);
  w.clock.advance(20_000);
  await w.emit('camera', 'personStop');
  await w.emit('camera', 'personStartNoClass');
  assert.equal(w.fake.sceneEvents.length, 2, 'the scenario says human');
  await w.emit('camera', 'vehicleStart');
  assert.equal(w.fake.lastState(camera.feature('vehicle')), 1);
  assert.equal(w.fake.sceneEvents.length, 2, 'a vehicle is no person');
});

test('a ring: a 1 then 0 pulse, the image, the doorbell scene event', async (t) => {
  const w = await world(t);
  await createAll(w);
  const door = doorIds(w.gladys);
  await w.emit('doorstation', 'ring');
  assert.equal(w.fake.lastState(door.feature('ring')), 1);
  assert.deepEqual(w.fake.sceneEvents.at(-1), {
    key: 'doorbell_pressed',
    data: { doorbell: door.device, doorbell_name: 'AXIS I8116-E' },
  });
  await w.emit('doorstation', 'ringRelease');
  await sleep(80);
  await settle();
  assert.equal(w.fake.lastState(door.feature('ring')), 0);
  // The call button is no input feature.
  assert.ok(!featureIds(w, door.device).includes('input_0'));
});

test('events of the second video source land on its own device', async (t) => {
  const w = await world(t);
  await createAll(w);
  await w.emit('multisensor', 'motion2Start');
  assert.equal(w.fake.lastState(multiIds(w.gladys, 2).feature('motion')), 1);
  assert.equal(w.fake.lastState(multiIds(w.gladys, 1).feature('motion')), 0);
  await w.fake.sceneAction('refresh_snapshot', { camera: multiIds(w.gladys, 2).device });
  assert.equal(w.devices.multisensor.lastSnapshotQuery.camera, '2');
  assert.equal(w.devices.multisensor.lastSnapshotQuery.resolution, '640x360');
});

test('a closed event stream clears the detections, keeps the inputs, and reopens', async (t) => {
  const w = await world(t);
  await createAll(w);
  const camera = cameraIds(w.gladys);
  await w.emit('camera', 'motionStart');
  await w.emit('camera', 'inputOn');
  w.devices.camera.ports[0].state = 'closed';
  assert.equal(w.fake.lastState(camera.feature('motion')), 1);
  w.devices.camera.dropStreams();
  await settle();
  assert.equal(w.fake.lastState(camera.feature('motion')), 0);
  assert.equal(w.fake.lastState(camera.feature('input_0')), 1);
  await w.streamsOpen();
  await w.emit('camera', 'motionStart');
  assert.equal(w.fake.lastState(camera.feature('motion')), 1);
});

test('the infrared light: a command, and its state from the events', async (t) => {
  const w = await world(t);
  await createAll(w);
  const device = w.fake.discoveredDevices.find((d) => d.external_id === cameraIds(w.gladys).device);
  const ir = device.features.find((f) => f.external_id.endsWith(':ir_light'));
  assert.equal(ir.read_only, false);
  assert.equal((await w.fake.setValue(device, ir, 1)).success, true);
  assert.deepEqual(w.devices.camera.lightCommands, ['activateLight']);
  assert.equal(w.fake.lastState(ir.external_id), 1);
  w.devices.camera.emit('LIGHT_STATUS_INIT'); // state OFF
  await settle();
  assert.equal(w.fake.lastState(ir.external_id), 0);
  // No other feature takes a command.
  const motion = device.features.find((f) => f.external_id.endsWith(':motion'));
  assert.equal((await w.fake.setValue(device, motion, 1)).success, false);
});

test('outputs: refused while not allowed, nothing sent; once allowed, one pulse, never retried', async (t) => {
  const w = await world(t);
  await createAll(w);
  const fields = { device: doorIds(w.gladys).device, output: '1', mode: 'pulse_1' };
  const refused = await w.fake.sceneAction('set_output', fields);
  assert.equal(refused.success, false);
  assert.match(refused.error, /outputs are disabled/);
  assert.deepEqual(w.devices.doorstation.outputCommands, []);
  // No output is ever a feature.
  for (const device of w.fake.discoveredDevices) {
    assert.ok(device.features.every((f) => !/output|relay/i.test(f.external_id)));
  }

  await w.fake.configUpdated({ ...BASE_CONFIG, allow_outputs: true });
  const ok = await w.fake.sceneAction('set_output', fields);
  assert.equal(ok.success, true, ok.error);
  assert.deepEqual(ok.data.outputs, { output_name: 'Door lock' });
  assert.equal(w.devices.doorstation.outputCommands.length, 1);
  assert.equal(
    (await w.fake.sceneAction('set_output', { ...fields, output: '2' })).success,
    false,
    'the door station has one output',
  );

  // A refusal of the device is reported, not retried.
  const commands = w.devices.doorstation.outputCommands.length;
  w.devices.doorstation.ports[1].direction = 'input';
  const failed = await w.fake.sceneAction('set_output', fields);
  assert.equal(failed.success, false);
  assert.equal(w.devices.doorstation.outputCommands.length, commands);
});

test('audio clips: listed, played by number or name, an unknown one refused', async (t) => {
  const w = await world(t);
  await createAll(w);
  const speaker = speakerIds(w.gladys).device;
  const byName = await w.fake.sceneAction('play_audio_clip', {
    device: speaker,
    clip: 'closing TIME',
  });
  assert.equal(byName.success, true, byName.error);
  assert.deepEqual(byName.data.outputs, { clip_name: 'Closing time' });
  await w.fake.sceneAction('play_audio_clip', { device: speaker, clip: '0' });
  await w.fake.sceneAction('play_audio_clip', { device: speaker });
  assert.deepEqual(w.devices.speaker.clipsPlayed, ['1', '0', '0']);
  const unknown = await w.fake.sceneAction('play_audio_clip', { device: speaker, clip: 'Nope' });
  assert.equal(unknown.success, false);
  const list = await w.fake.action('audio_clips', {});
  assert.match(list.data.message.fr, /AXIS C1310-E \(192\.0\.2\.30\) : 0 = Doorbell chime/);
});

test('a speaker has no camera: no image feature, no snapshot', async (t) => {
  const w = await world(t);
  await createAll(w);
  const speaker = speakerIds(w.gladys).device;
  assert.deepEqual(featureIds(w, speaker), ['online']);
  const ack = await w.fake.sceneAction('refresh_snapshot', { camera: speaker });
  assert.equal(ack.success, false);
  assert.match(ack.error, /no camera/);
});

test('snapshots fit the 150 KB of Gladys: a second, smaller try, else an error', async (t) => {
  const w = await world(t);
  await createAll(w);
  const camera = cameraIds(w.gladys);
  w.devices.camera.snapshot = jpegOfSize(140_000); // too large at compression 30
  w.clock.advance(60_000);
  const ack = await w.fake.getImage({ external_id: camera.device });
  assert.equal(ack.success, true, ack.error);
  assert.ok(ack.data.image.length <= MAX_CAMERA_IMAGE);
  assert.deepEqual(w.devices.camera.lastSnapshotQuery, {
    camera: '1',
    resolution: '320x180',
    compression: '60',
  });
  w.devices.camera.snapshot = jpegOfSize(400_000);
  w.clock.advance(60_000);
  assert.equal((await w.fake.getImage({ external_id: camera.device })).success, false);
});

test('search the network: configured, to add, moved; unavailable on an older core', async (t) => {
  const mdns = [
    {
      name: 'AXIS P3268-LVE - ACCC8E1A2B3C._axis-video._tcp.local',
      host: 'axis-accc8e1a2b3c.local',
      addresses: ['192.0.2.10'],
      port: 80,
      txt: ['macaddress=ACCC8E1A2B3C'],
    },
    {
      name: 'AXIS M3086-V - ACCC8E998877._axis-video._tcp.local',
      host: 'axis-accc8e998877.local',
      addresses: ['192.0.2.44', 'fe80::1'],
      port: 80,
      txt: ['macaddress=ACCC8E998877'],
    },
  ];
  const ssdp = [
    {
      source_ip: '192.0.2.55',
      source_port: 1900,
      headers:
        'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.0.2.55:45895/rootdesc1.xml\r\nSERVER: Linux/4.14.173-axis8, UPnP/1.0, Portable SDK for UPnP devices/1.8.7\r\nST: urn:axis-com:service:BasicService:1\r\nUSN: uuid:Upnp-BasicDevice-1_0-B8A44F7A8B9C::urn:axis-com:service:BasicService:1\r\n\r\n',
    },
  ];
  const w = await world(t, { scanResults: { mdns, ssdp } });
  w.devices.doorstation.online = false;
  await w.hub.refresh();
  const ack = await w.fake.action('search_network', {});
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.message.en.split('\n'), [
    'AXIS P3268-LVE at 192.0.2.10: configured.',
    'AXIS M3086-V at 192.0.2.44: to add, copy its address in the configuration.',
    'AXIS B8A44F7A8B9C now answers at 192.0.2.55: update its address in the configuration.',
  ]);
  assert.deepEqual(
    w.fake.scans.map((scan) => scan.type),
    ['mdns', 'ssdp'],
  );

  t.mock.method(w.gladys, 'scanNetwork', async () => {
    throw new Error('404 Not Found');
  });
  const unavailable = await w.fake.action('search_network', {});
  assert.match(unavailable.data.message.en, /Network search unavailable/);
});

test('the widget: devices, detections with their image, within the core budget', async (t) => {
  const w = await world(t);
  await createAll(w);
  await w.emit('camera', 'personStart');
  await w.emit('doorstation', 'ring');
  const ack = await w.fake.widgetGet('axis', { settings: {}, language: 'fr' });
  assert.equal(ack.success, true, ack.error);
  const content = ack.data.content;
  const report = validateWidgetContent(content);
  assert.deepEqual(report.errors ?? [], []);
  assert.ok(content.components.length <= 8);
  const list = content.components.find((c) => c.type === 'card-list');
  assert.deepEqual(
    list.items.map((item) => item.title),
    ['Sonnette · AXIS I8116-E', 'Personne · AXIS P3268-LVE'],
  );
  const image = await w.fake.widgetGetImage(list.items[0].image);
  assert.equal(image.success, true);
  const one = await w.fake.widgetGet('axis', {
    settings: { device: speakerIds(w.gladys).device },
    language: 'en',
  });
  assert.equal(one.data.content.components[0].value, '1/1');
});

test('a new language renames the features in the Discovery tab', async (t) => {
  const w = await world(t);
  await w.fake.configUpdated({ ...BASE_CONFIG, language: 'de' });
  const camera = w.fake.discoveredDevices.find((d) => d.external_id === cameraIds(w.gladys).device);
  assert.ok(camera.features.some((feature) => feature.name === 'Infrarotlicht'));
  assert.ok(camera.features.some((feature) => feature.name === 'Garden gate'));
});

test('test the connection: one line per device, and a refused password tried once more', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, password_2: 'wrong-value' } });
  assert.deepEqual(w.fake.connectionStatus.connected, false);
  assert.equal(w.devices.doorstation.refusals, 1);
  const ack = await w.fake.action('test_connection', {});
  assert.equal(w.devices.doorstation.refusals, 2, 'one more try, asked by the user');
  const lines = ack.data.message.en.split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[1], /192\.0\.2\.11: AXIS M1065-LW, 1 video source\(s\), live events by RTSP/);
  assert.match(lines[4], /192\.0\.2\.20: User name or password refused/);
});

test('no configured device: a clear status, an empty Discovery tab', async (t) => {
  const w = await world(t, { config: { hosts: '', password: '' } });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /Enter the address/);
  assert.deepEqual(w.fake.discoveredDevices, []);
});
