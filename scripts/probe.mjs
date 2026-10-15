#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real Axis device, with the very client of the
// integration: what the integration would see, without Gladys.
//
//   AXIS_PASSWORD=… node scripts/probe.mjs <address> [user] [seconds]
//   AXIS_EVENTS=rtsp …   listens over RTSP even where WebSocket is offered
//
// It reads the identity, the APIs, the video sources, the ports, the lights,
// the audio clips and the analytics scenarios, takes one snapshot, and
// listens to the live events (30 seconds by default, WebSocket or RTSP as the
// integration would choose), printing the topic and the data of each event.
// It writes nothing to the device: no output, no light, no clip played. It
// prints neither the password nor the full serial number (its last 4
// characters only). One refused password stops it at once: Axis devices
// block an address after repeated failures.
//
// Not part of the Docker image (only index.js and src/ are copied).
// -----------------------------------------------------------------------------

import { parseHost } from '../src/config.js';
import { AxisDevice } from '../src/axis/device.js';
import { EventStream } from '../src/axis/events.js';
import { fittedSnapshot } from '../src/image.js';

const [address, user = 'root', seconds = '30'] = process.argv.slice(2);
const password = process.env.AXIS_PASSWORD ?? '';
const host = parseHost(address);
if (!host || !password) {
  console.error('Usage: AXIS_PASSWORD=… node scripts/probe.mjs <address> [user] [seconds]');
  process.exit(2);
}

const mask = (serial) => (serial ? `…${String(serial).slice(-4)}` : '?');
const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

const device = new AxisDevice({ host: { ...host, username: user, password } });

let info;
try {
  info = await device.describe();
} catch (err) {
  console.error(`Cannot read ${host.label}: ${err.message} (${err.kind ?? 'error'})`);
  process.exit(1);
}

line('Address', host.label);
line('Model', `AXIS ${info.model ?? '?'} (${info.productType ?? '?'})`);
line('Firmware', info.firmware ?? '?');
line('Serial', mask(info.serial));
line('APIs', info.apis.map(([id, version]) => `${id} ${version}`).join(', ') || 'none listed');
line('Video sources', info.hasVideo ? info.channels.length : 'none');
line('Snapshot size', info.snapshotResolution ?? 'device default');
line('Door station', info.doorStation);
for (const port of info.ports) {
  line(
    `Port ${port.id}`,
    `${port.direction}${port.name ? ` "${port.name}"` : ''}${port.doorbell ? ' (call button)' : ''}`,
  );
}
line('Lights', info.lights.map((light) => `${light.id} ${light.type}`).join(', ') || 'none');
line('Audio clips', info.clips.map((clip) => `${clip.id} = ${clip.name}`).join(', ') || 'none');
line('VMD', info.vmd);
line(
  'AOA scenarios',
  info.scenarios.map((s) => `${s.id} "${s.name}" [${s.classes.join(', ')}]`).join(', ') || 'none',
);
line('RTSP port', info.rtspPort);

try {
  const states = await device.readStates();
  line('Inputs active', JSON.stringify(Object.fromEntries(states.inputs)));
  line('Infrared light', states.irLight ?? 'n/a');
} catch (err) {
  line('States', `not read: ${err.message}`);
}

if (info.hasVideo) {
  try {
    const started = Date.now();
    const image = await fittedSnapshot((options) => device.client.snapshot(1, options), info);
    line(
      'Snapshot',
      `${Math.round(image.length / 1024)} KB as sent to Gladys, ${Date.now() - started} ms`,
    );
  } catch (err) {
    line('Snapshot', `failed: ${err.message}`);
  }
}

if (process.env.AXIS_EVENTS === 'rtsp') {
  info.websocketEvents = false;
}
console.log(`\nListening to the events for ${seconds} s (move in front of a camera, ring)…`);
const stream = new EventStream({
  device,
  onEvents: (events) => {
    for (const event of events) {
      console.log(
        `${new Date().toISOString()} ${event.topic} ${event.operation} ` +
          `source=${JSON.stringify(event.source)} data=${JSON.stringify(event.data)}`,
      );
    }
  },
  onOpen: (transport) => console.log(`Event stream open (${transport})`),
  onClose: (err) => console.log(`Event stream closed: ${err.message}`),
});
stream.start();
await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000));
stream.stop();
console.log('Done.');
process.exit(0);
