// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, five fake Axis devices (a
// camera with WebSocket events and analytics, an old camera with RTSP events,
// a two-sensor camera, a door station with its own password, a network
// speaker), a temporary /data and a manual clock, with the integration wired
// on top through registerHandlers. No periodic timer runs unless
// `timers: true`: the tests read the devices with `world.hub.refresh()` and
// push events with `world.emit(...)`.
// (From guim31/gladys-dahua.)
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { FakeAxis, PASSWORD, USERNAME, network } from './fakeAxis.js';

// The integration logs its lifecycle; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const ORIGINS = {
  camera: 'http://192.0.2.10',
  legacy: 'http://192.0.2.11',
  multisensor: 'http://192.0.2.12',
  doorstation: 'http://192.0.2.20',
  speaker: 'http://192.0.2.30',
};

export const DOOR_PASSWORD = 'Door-Secret-2';

export const SERIALS = {
  camera: 'ACCC8E1A2B3C',
  legacy: 'ACCC8E4D5E6F',
  multisensor: 'E827253C4D5E',
  doorstation: 'B8A44F7A8B9C',
  speaker: 'ACCC8E0F1E2D',
};

export const BASE_CONFIG = {
  hosts: '192.0.2.10, 192.0.2.11, 192.0.2.12, 192.0.2.30',
  username: USERNAME,
  password: PASSWORD,
  hosts_2: '192.0.2.20',
  username_2: USERNAME,
  password_2: DOOR_PASSWORD,
  snapshot_interval: '5',
  allow_outputs: false,
  language: 'en',
};

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 15, 18, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/** Let the streams, the event handlers and the fake network settle. */
export async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function createDevices() {
  return {
    camera: new FakeAxis({ name: 'camera' }),
    legacy: new FakeAxis({ name: 'legacy' }),
    multisensor: new FakeAxis({ name: 'multisensor' }),
    doorstation: new FakeAxis({ name: 'doorstation', password: DOOR_PASSWORD }),
    speaker: new FakeAxis({ name: 'speaker' }),
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.devices] fake devices by name
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers]
 * @param {object} [options.timings] HUB_TIMINGS overrides
 */
export async function createWorld({
  clock = createClock(),
  devices = createDevices(),
  config = BASE_CONFIG,
  created = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-axis-')),
  timings = {},
  streamTimings = {},
  timers = false,
  scanResults = {},
} = {}) {
  const gladys = createFakeGladys({ config, devices: created, scanResults });
  const transport = network(
    Object.fromEntries(Object.entries(devices).map(([name, device]) => [ORIGINS[name], device])),
  );
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    transport,
    timers,
    timings: { pulseMs: 50, eventImageWaitMs: 200, ...timings },
    streamTimings: {
      quickRetryMs: 20,
      failureBaseMs: 20,
      failureMaxMs: 40,
      ...streamTimings,
    },
    now: clock.now,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    devices,
    app,
    hub: app.hub,
    clock,
    dataDir,
    /** Send an event (a name of EVENTS or raw XML) from a device, then let it be handled. */
    async emit(name, event) {
      devices[name].emit(event);
      await settle();
    },
    /** Wait until the event stream of every answering device is open. */
    async streamsOpen() {
      for (let i = 0; i < 200; i += 1) {
        // Every device that answers (a refused password keeps its stream closed).
        const answering = [...app.hub.devices.keys()].filter(
          (origin) => app.hub.reads.get(origin)?.ok !== false,
        );
        if (answering.every((origin) => app.hub.streams.get(origin)?.open)) {
          await settle();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('The event streams did not open');
    },
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await world.streamsOpen();
  }
  return world;
}

/** External ids of a device of the fixtures. */
export const ids = (gladys, platformId) => gladys.externalIds('axis', platformId);
export const cameraIds = (gladys) => ids(gladys, SERIALS.camera);
export const legacyIds = (gladys) => ids(gladys, SERIALS.legacy);
export const doorIds = (gladys) => ids(gladys, SERIALS.doorstation);
export const speakerIds = (gladys) => ids(gladys, SERIALS.speaker);
export const multiIds = (gladys, source) => ids(gladys, `${SERIALS.multisensor}-cam${source}`);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await settle();
}

export { FakeAxis, PASSWORD, USERNAME };
