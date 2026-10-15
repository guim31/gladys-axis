// -----------------------------------------------------------------------------
// One configured Axis device: what it is (described once, kept in /data so a
// device off at the next start keeps its features), and its live reads.
//
// The description reads, each one optional except the identity:
//   - apidiscovery: which JSON APIs exist (AXIS OS 7+; none on older ones);
//   - basicdeviceinfo (or param.cgi root.Brand / Properties): serial, model;
//   - param.cgi root.Properties.Image and root.ImageSource: whether the device
//     has video (a network speaker has none), how many video sources (a
//     multi-sensor camera has several, one Gladys device each), and the
//     resolutions image.cgi accepts;
//   - the I/O ports (port management API or param.cgi root.IOPort), and among
//     the inputs the call button of a door station;
//   - the lights of the Light Control API (the infrared illuminator);
//   - the audio clips stored on the device (param.cgi root.MediaClip);
//   - the camera applications (AXIS Object Analytics scenarios and their
//     object classes, AXIS Video Motion Detection);
//   - the RTSP port (param.cgi root.Network.RTSP), for the event stream.
// -----------------------------------------------------------------------------

import { AxisClient, ERROR_KINDS } from './client.js';

// The largest snapshot asked for: the camera scales it, and 640 px wide fits
// the 150 KB of a Gladys camera image at compression 30 in practice.
export const SNAPSHOT_MAX_WIDTH = 640;

// The call button of a door station is an input named so (in the languages of
// the Axis web interface), or, on the AXIS I8116-E, its first input: the case
// verified by the Home Assistant integration.
const CALL_BUTTON = /call|appel|sonnette|doorbell|klingel|ruf|llamada|timbre|bell/i;
const CALL_BUTTON_PORT_ZERO = new Set(['I8116-E']);

const DOOR_STATION = /intercom|door\s*station|interphone|portier/i;

/** The resolution asked of image.cgi: the largest one ≤ 640 px wide, in the sensor ratio. */
export function snapshotResolution(list) {
  const sizes = String(list ?? '')
    .split(',')
    .map((entry) => entry.trim().match(/^(\d+)x(\d+)$/))
    .filter(Boolean)
    .map(([text, width, height]) => ({ text, width: Number(width), height: Number(height) }));
  if (sizes.length === 0) {
    return null;
  }
  const largest = sizes.reduce((best, size) =>
    size.width * size.height > best.width * best.height ? size : best,
  );
  const ratio = largest.width / largest.height;
  const fitting = sizes.filter((size) => size.width <= SNAPSHOT_MAX_WIDTH);
  const sameRatio = fitting.filter((size) => Math.abs(size.width / size.height - ratio) < 0.02);
  const pool = sameRatio.length > 0 ? sameRatio : fitting;
  if (pool.length === 0) {
    return null;
  }
  return pool.reduce((best, size) => (size.width > best.width ? size : best)).text;
}

/** The video sources of `root.ImageSource`: their count, 1 when unsaid. */
export function sourceCount(params) {
  const declared = Number(params['ImageSource.NbrOfSources']);
  if (Number.isInteger(declared) && declared > 0) {
    return declared;
  }
  const ids = new Set();
  for (const key of Object.keys(params)) {
    const match = key.match(/^ImageSource\.I(\d+)\./);
    if (match) {
      ids.add(match[1]);
    }
  }
  return Math.max(ids.size, 1);
}

/** The audio clips of `root.MediaClip`: `{ id, name }`, audio only. */
export function mediaClips(params) {
  const clips = new Map();
  for (const [key, value] of Object.entries(params)) {
    const match = key.match(/^MediaClip\.M(\d+)\.(Name|Type)$/);
    if (!match) {
      continue;
    }
    const clip = clips.get(match[1]) ?? { id: match[1], name: '', type: '' };
    clip[match[2] === 'Name' ? 'name' : 'type'] = value;
    clips.set(match[1], clip);
  }
  return [...clips.values()]
    .filter((clip) => !clip.type || /audio/i.test(clip.type))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(({ id, name }) => ({ id, name: name || `Clip ${id}` }));
}

/** Whether an input is the call button of a door station. */
export function isCallButton(port, { model, doorStation }) {
  if (port.direction !== 'input') {
    return false;
  }
  if (port.name && CALL_BUTTON.test(port.name)) {
    return true;
  }
  return Boolean(doorStation && CALL_BUTTON_PORT_ZERO.has(model) && port.id === '0');
}

const optional = async (read, fallback) => {
  try {
    return await read();
  } catch (err) {
    if ([ERROR_KINDS.AUTH, ERROR_KINDS.BLOCKED, ERROR_KINDS.UNREACHABLE].includes(err.kind)) {
      throw err;
    }
    return fallback;
  }
};

export class AxisDevice {
  /**
   * @param {object} options
   * @param {object} options.host { origin, label, username, password }
   * @param {object} [options.transport] network seams
   * @param {object} [options.clientTimings]
   */
  constructor({ host, transport, clientTimings }) {
    this.host = host;
    this.client = new AxisClient({
      origin: host.origin,
      username: host.username,
      password: host.password,
      transport,
      timings: clientTimings,
    });
    this.transport = transport;
    this.info = null;
    this.redescribe = false;
  }

  get label() {
    return this.host.label;
  }

  /** A description saved in /data: used until the device answers. */
  restore(saved) {
    this.info = saved;
    this.client.apis = new Map(Array.isArray(saved.apis) ? saved.apis : []);
    this.redescribe = true;
  }

  /** Read what the device is. */
  async describe() {
    const client = this.client;
    const apis = await client.discoverApis();
    const identity = await client.identity();
    if (!identity.serial) {
      throw Object.assign(new Error('The device did not give its serial number'), {
        kind: ERROR_KINDS.NO_API,
      });
    }
    const image = await optional(() => client.params('root.Properties.Image'), {});
    const audio = await optional(() => client.params('root.Properties.Audio'), {});
    const hasVideo = /jpeg/i.test(image['Properties.Image.Format'] ?? '');
    const sources = hasVideo
      ? sourceCount(await optional(() => client.params('root.ImageSource'), {}))
      : 1;
    const doorStation = DOOR_STATION.test(identity.productType ?? '');
    const ports = (await optional(() => client.ports(), [])).map((port) => ({
      ...port,
      doorbell: isCallButton(port, { model: identity.model, doorStation }),
    }));
    const lights = await optional(() => client.lights(), []);
    const ir = lights.find((light) => /^ir$/i.test(light.type)) ?? null;
    const hasAudioOut =
      /yes/i.test(audio['Properties.Audio.Audio'] ?? '') &&
      !/^(none|)$/i.test(audio['Properties.Audio.DuplexMode'] ?? 'full');
    const clips = hasAudioOut
      ? mediaClips(await optional(() => client.params('root.MediaClip'), {}))
      : [];
    const applications = await optional(() => client.applications(), []);
    const running = (name) =>
      applications.some((app) => app.name === name && /running/i.test(app.status));
    const scenarios = running('objectanalytics')
      ? ((await client.applicationConfiguration('objectanalytics', '1.0'))?.scenarios ?? [])
      : [];
    const rtsp = await optional(() => client.params('root.Network.RTSP'), {});
    const rtspPort = Number(rtsp['Network.RTSP.Port']);
    return (this.info = {
      serial: String(identity.serial),
      model: identity.model,
      name: identity.name,
      productType: identity.productType,
      firmware: identity.firmware,
      doorStation,
      hasVideo,
      channels: Array.from({ length: hasVideo ? sources : 1 }, (_, index) => ({ index })),
      snapshotResolution: snapshotResolution(image['Properties.Image.Resolution']),
      resolutions: image['Properties.Image.Resolution'] ?? '',
      ports,
      irLight: ir ? ir.id : null,
      lights: lights.map(({ id, type }) => ({ id, type })),
      clips,
      hasAudioOut,
      scenarios: (Array.isArray(scenarios) ? scenarios : [])
        .filter((scenario) => scenario && scenario.id !== undefined)
        .map((scenario) => ({
          id: String(scenario.id),
          name: typeof scenario.name === 'string' ? scenario.name : `Scenario ${scenario.id}`,
          classes: (Array.isArray(scenario.objectClassifications)
            ? scenario.objectClassifications
            : []
          )
            .map((entry) => entry?.type)
            .filter((type) => typeof type === 'string'),
        })),
      vmd: running('vmd'),
      rtspPort: Number.isInteger(rtspPort) && rtspPort > 0 ? rtspPort : 554,
      websocketEvents: apis.has('event-streaming-over-websocket'),
      portManagement: apis.has('io-port-management'),
      apis: [...apis],
    });
  }

  /** The context the event model needs (src/axis/model.js). */
  eventContext() {
    const info = this.info;
    return {
      channels: info?.channels.length ?? 1,
      ports: new Map((info?.ports ?? []).map((port) => [port.id, port])),
      scenarioClasses: new Map((info?.scenarios ?? []).map((s) => [s.id, s.classes])),
      lights: new Map((info?.lights ?? []).map((light) => [light.id, light])),
    };
  }

  /**
   * The live values a read can give: the inputs (fallback of the event
   * stream) and the infrared light. Also proves the device answers.
   * @returns {Promise<{ inputs: Map<string, boolean>, irLight: boolean|null }>}
   */
  async readStates() {
    const client = this.client;
    const info = this.info;
    const inputs = new Map();
    const watched = (info.ports ?? []).filter((port) => port.direction === 'input');
    if (info.portManagement) {
      for (const port of await client.ports()) {
        if (port.direction === 'input' && port.state && port.normalState) {
          inputs.set(port.id, port.state !== port.normalState);
        }
      }
    } else if (watched.length > 0) {
      const states = await optional(
        () => client.activePorts(watched.map((port) => port.id)),
        new Map(),
      );
      for (const [id, active] of states) {
        inputs.set(id, active);
      }
    } else {
      // Nothing to read: a light request proves the device answers.
      await client.params('root.Brand.ProdNbr');
    }
    const irLight = info.irLight
      ? await optional(() => client.lightStatus(info.irLight), null)
      : null;
    return { inputs, irLight };
  }

  /** The port of an output, by its number among the outputs (1, 2…). */
  output(number) {
    const outputs = (this.info?.ports ?? []).filter((port) => port.direction === 'output');
    return outputs[number - 1] ?? null;
  }
}
