// -----------------------------------------------------------------------------
// The Axis hub: every configured device, followed live and read again on a
// timer.
//
//   - at start, each device is described once (identity, video sources,
//     ports, lights, clips, analytics: src/axis/device.js) and the
//     description kept in /data, so a device that is off at the next start
//     keeps its features;
//   - the event stream of each device (src/axis/events.js: WebSocket or RTSP
//     metadata): motion, objects, persons, vehicles, PIR, sound, tampering,
//     day/night, inputs, rings, the infrared light, as they happen. A
//     feature seen in the events that the description did not show is added
//     (one sensor per event present). A ring is a pulse (1, then 0 a few
//     seconds later), as the core expects for a doorbell;
//   - the inputs and the infrared light are read every 5 minutes, every
//     minute while an event stream is down: the container refreshes itself,
//     Gladys never polls (should_poll: false, GladysAssistant/Gladys#3198);
//   - snapshots: a fresh image of a camera at each person detected or ring
//     (before the scene event, so a scene sending "the camera image" sends
//     the right one), on the timer chosen in the configuration, on demand.
//
// States go through publishChangedStates (only the changes, plus a heartbeat
// every 6 hours: the front shows "no recent value" past 48 hours), and only
// for the devices the user added: Gladys drops the others.
//
// Logs: info keeps the lifecycle (connected, a device lost and back, user
// commands); a problem that repeats is logged once, and once when it clears;
// the rest goes to debug (LOG_LEVEL=debug). Never a password, never an
// address with credentials.
// (Structure from guim31/gladys-dahua.)
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS } from './axis/client.js';
import { AxisDevice } from './axis/device.js';
import { EventStream } from './axis/events.js';
import { OPERATIONS } from './axis/metadata.js';
import { INPUT_PREFIX, KEYS, inputKey, interpret } from './axis/model.js';
import {
  buildDevice,
  channelIds,
  channelName,
  featureKeys,
  featureValues,
  platformId,
} from './devices.js';
import { mdnsCandidates, mergeCandidates, ssdpCandidates } from './discovery.js';
import { fittedSnapshot } from './image.js';
import {
  ACTION_TEXT,
  CLIPS_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  REPORT_TEXT,
  SEARCH_TEXT,
  TRANSPORT_TEXT,
  localized,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'axis-hub' });

export const WIDGET_KEY = 'axis';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  PERSON: 'person_detected',
  DOORBELL: 'doorbell_pressed',
});

export const HUB_TIMINGS = {
  refreshMs: 5 * 60_000,
  // While an event stream is down, the reads carry the inputs.
  fallbackRefreshMs: 60_000,
  heartbeatMs: 6 * 60 * 60_000,
  // A ring: 1, then 0 after this.
  pulseMs: 10_000,
  // One scene event per person or ring in this window, per video source.
  triggerSpacingMs: 15_000,
  // The core takes 12 images a minute per camera at most.
  imageSpacingMs: 6_000,
  // A scene event waits this long at most for the fresh image of its camera.
  eventImageWaitMs: 4_000,
  // The search of the network (mediated mDNS / SSDP), each.
  scanSeconds: 4,
};

// Detections kept for the widget (with their image) and counted over 24 h.
export const MAX_DETECTIONS = 8;
const DAY_MS = 24 * 60 * 60_000;
const MAX_COUNTED = 5000;

// What an event can add to a video source (a feature its description did not show).
const LEARNABLE = new Set([
  KEYS.MOTION,
  KEYS.OBJECT,
  KEYS.PERSON,
  KEYS.VEHICLE,
  KEYS.PIR,
  KEYS.AUDIO,
  KEYS.TAMPER,
  KEYS.NIGHT,
]);

// Pulses of an output offered by the scene action, and the steady states.
export const OUTPUT_ACTIONS = Object.freeze({
  pulse_1: { pulseMs: 1000 },
  pulse_3: { pulseMs: 3000 },
  pulse_10: { pulseMs: 10_000 },
  on: { active: true },
  off: { active: false },
});

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const devicesSignature = (config) =>
  JSON.stringify(config.devices.map((d) => [d.origin, d.username, d.password]));

export class AxisHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {object} [options.transport] network seams (src/axis/transport.js)
   * @param {boolean} [options.timers] periodic timers (off in most tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.streamTimings] STREAM_TIMINGS overrides
   * @param {object} [options.clientTimings] CLIENT_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({
    gladys,
    store,
    transport,
    timers = true,
    timings,
    streamTimings,
    clientTimings,
    now,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.transport = transport;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.streamTimings = streamTimings;
    this.clientTimings = clientTimings;
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.signature = null;
    /** By origin: AxisDevice, EventStream, read state. */
    this.devices = new Map();
    this.streams = new Map();
    this.reads = new Map();
    /** By channel key: latched sources per feature, pulses, learned features, settings. */
    this.active = new Map();
    this.pulses = new Map();
    this.learned = new Map();
    this.settings = new Map();
    this.lastTriggers = new Map();
    this.saved = { devices: {}, learned: {} };
    this.reading = null;
    this.discovery = null;
    /** Last image per channel key: { at, image }. */
    this.images = new Map();
    this.imageReads = new Map();
    /** Detections, newest first: { id, at, key, kind, imageKey }. */
    this.detections = [];
    this.detectionTimes = [];
    this.detectionCount = 0;
    this.thumbnails = new Map();
    this.online = new Map();
    this.transports = new Map();
    this.connection = null;
    this.refreshTimer = null;
    this.snapshotTimer = null;
    this.stopped = false;
    /** Problems already logged, by key: their repeats go to debug. */
    this.warned = new Set();
  }

  get language() {
    return this.config?.language ?? 'en';
  }

  // --- Logs ------------------------------------------------------------------

  /** Log a problem once (`level` info, warn or error), its repeats at debug. */
  problem(key, message, level = 'warn') {
    if (this.warned.has(key)) {
      logger.debug(message);
      return;
    }
    this.warned.add(key);
    logger[level](message);
  }

  /** The problem `key` is gone: say so once, the next occurrence logs again. */
  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.saved = {
      devices: saved.devices && typeof saved.devices === 'object' ? saved.devices : {},
      learned: saved.learned && typeof saved.learned === 'object' ? saved.learned : {},
    };
    for (const [key, list] of Object.entries(this.saved.learned)) {
      if (Array.isArray(list)) {
        this.learned.set(key, new Set(list.filter((item) => LEARNABLE.has(item))));
      }
    }
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovery = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const next = devicesSignature(config);
    const changed = next !== this.signature;
    this.config = config;
    if (changed) {
      this.closeStreams();
      this.signature = next;
      this.devices.clear();
      this.reads.clear();
      this.online.clear();
      for (const host of config.devices) {
        const device = new AxisDevice({
          host,
          transport: this.transport,
          clientTimings: this.clientTimings,
        });
        const saved = this.saved.devices[host.origin];
        if (saved && typeof saved === 'object' && Array.isArray(saved.channels)) {
          device.restore(saved);
        }
        this.devices.set(host.origin, device);
        this.reads.set(host.origin, { ok: null, error: null, downSince: null });
      }
      if (config.invalidHosts.length > 0) {
        this.problem(
          'invalid-hosts',
          `Addresses not understood in the configuration: ${config.invalidHosts.join(', ')}`,
        );
      } else {
        this.resolved('invalid-hosts');
      }
    }
    // A new language renames the features: the Discovery tab shows them.
    this.discovery = null;
    if (this.devices.size === 0) {
      clearTimeout(this.refreshTimer);
      clearTimeout(this.snapshotTimer);
      await this.publishDevices();
      await this.publishConnectionStatus();
      return;
    }
    await this.refresh();
    this.scheduleRefresh();
    this.scheduleSnapshots();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.snapshotTimer);
    this.closeStreams();
    for (const timers of this.pulses.values()) {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    }
    this.pulses.clear();
    await this.store.flush();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.timersEnabled || this.stopped || this.devices.size === 0) {
      return;
    }
    const allLive = [...this.devices.keys()].every((origin) => this.streams.get(origin)?.open);
    const wait = allLive ? this.timings.refreshMs : this.timings.fallbackRefreshMs;
    this.refreshTimer = setTimeout(async () => {
      await this.refresh();
      this.scheduleRefresh();
    }, wait);
  }

  scheduleSnapshots() {
    clearTimeout(this.snapshotTimer);
    const interval = this.config?.snapshotIntervalMs ?? 0;
    if (!this.timersEnabled || this.stopped || this.devices.size === 0 || interval <= 0) {
      return;
    }
    this.snapshotTimer = setTimeout(async () => {
      await this.snapshotAll();
      this.scheduleSnapshots();
    }, interval);
  }

  // --- Channels ----------------------------------------------------------------

  /** Every video source of every described device. */
  channels() {
    const list = [];
    for (const device of this.devices.values()) {
      const info = device.info;
      if (!info) {
        continue;
      }
      const scenarios = info.scenarios ?? [];
      for (const channel of info.channels) {
        const first = channel.index === 0;
        const entry = {
          device,
          origin: device.host.origin,
          host: device.label,
          serial: info.serial,
          model: info.model,
          count: info.channels.length,
          index: channel.index,
          hasVideo: info.hasVideo,
          ports: info.ports ?? [],
          caps: {
            [KEYS.MOTION]: Boolean(info.vmd) && info.hasVideo,
            [KEYS.OBJECT]: first && scenarios.length > 0,
            [KEYS.PERSON]: first && scenarios.some((s) => s.classes.includes('human')),
            [KEYS.VEHICLE]: first && scenarios.some((s) => s.classes.includes('vehicle')),
            [KEYS.RING]: (info.ports ?? []).some((port) => port.doorbell),
            [KEYS.IR_LIGHT]: Boolean(info.irLight),
          },
        };
        entry.key = platformId(entry);
        entry.learned = this.learned.get(entry.key) ?? new Set();
        list.push(entry);
      }
    }
    return list;
  }

  /** The channel of a Gladys external id, null when unknown. */
  findChannel(externalId) {
    if (!externalId) {
      return null;
    }
    return (
      this.channels().find((channel) => channelIds(this.gladys, channel).device === externalId) ??
      null
    );
  }

  isOnline(origin) {
    const read = this.reads.get(origin);
    return Boolean(read && (read.ok === true || this.streams.get(origin)?.open));
  }

  activeOf(key) {
    let features = this.active.get(key);
    if (!features) {
      features = new Map();
      this.active.set(key, features);
    }
    return features;
  }

  /** The latched features of a channel that are on. */
  activeKeys(key) {
    const on = new Set();
    for (const [feature, sources] of this.active.get(key) ?? []) {
      if (sources.size > 0) {
        on.add(feature);
      }
    }
    return on;
  }

  // --- Reading the devices -----------------------------------------------------

  /** Read every device. Concurrent calls share the read. */
  refresh({ describe = false } = {}) {
    if (describe) {
      for (const device of this.devices.values()) {
        device.redescribe = true;
      }
    }
    this.reading ??= this.readAll().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  async readAll() {
    const devices = [...this.devices.values()];
    const results = await Promise.all(devices.map((device) => this.readDevice(device)));
    if (
      this.devices.size === 0 ||
      devices.some((device) => this.devices.get(device.host.origin) !== device)
    ) {
      return false; // reconfigured while reading
    }
    await this.publishDevices();
    await this.publishAllStates();
    await this.afterChanges();
    return results.every(Boolean);
  }

  async readDevice(device) {
    const origin = device.host.origin;
    let states;
    try {
      if (!device.info || device.redescribe) {
        device.redescribe = false;
        const info = await device.describe();
        this.saved.devices[origin] = info;
        this.save();
      }
      states = await device.readStates();
    } catch (err) {
      if (this.devices.get(origin) === device) {
        this.readFailed(device, err);
      }
      return false;
    }
    if (this.devices.get(origin) !== device) {
      return false;
    }
    this.applyReads(device, states);
    this.readSucceeded(device);
    return true;
  }

  /** What a read gave: the inputs, the infrared light. */
  applyReads(device, { inputs, irLight }) {
    const first = this.channels().find(
      (channel) => channel.origin === device.host.origin && channel.index === 0,
    );
    if (!first) {
      return;
    }
    const features = this.activeOf(first.key);
    for (const [id, on] of inputs) {
      const port = device.info.ports.find((entry) => entry.id === id);
      if (!port || port.doorbell) {
        continue;
      }
      const sources = new Set(on ? [`port:${id}`] : []);
      features.set(inputKey(id), sources);
    }
    if (irLight !== null && irLight !== undefined) {
      this.settings.set(first.key, { ...this.settings.get(first.key), irLight });
    }
  }

  readSucceeded(device) {
    const read = this.reads.get(device.host.origin);
    const first = read.ok === null;
    const wasDown = read.ok === false;
    read.ok = true;
    read.error = null;
    const info = device.info;
    const label = `AXIS ${info.model ?? info.serial} at ${device.label}`;
    if (first) {
      logger.info(
        `Connected to ${label}: ${info.channels.length} video source(s), firmware ${info.firmware ?? '?'}`,
      );
    } else if (wasDown) {
      const minutes = Math.max(1, Math.round((this.now() - read.downSince) / 60_000));
      logger.info(`${label} answers again after ${minutes} min`);
    }
    this.warned.delete(`read-${device.host.origin}`);
    read.downSince = null;
    this.ensureStream(device);
  }

  readFailed(device, err) {
    const read = this.reads.get(device.host.origin);
    if (read.ok !== false) {
      read.downSince = this.now();
    }
    read.ok = false;
    read.error = err;
    const level = err.kind === ERROR_KINDS.UNREACHABLE ? 'info' : 'warn';
    this.problem(
      `read-${device.host.origin}`,
      `Cannot read the device at ${device.label}: ${err.message}`,
      level,
    );
    if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
      this.streams.get(device.host.origin)?.stop();
    }
  }

  save() {
    const learned = Object.fromEntries(
      [...this.learned.entries()].map(([key, set]) => [key, [...set]]),
    );
    this.saved.learned = learned;
    return this.store.save({ devices: this.saved.devices, learned });
  }

  // --- Event streams -----------------------------------------------------------------

  /** The event stream of a described device that answers: opened, or resumed. */
  ensureStream(device) {
    if (this.stopped || !device.info) {
      return;
    }
    const origin = device.host.origin;
    const existing = this.streams.get(origin);
    if (existing) {
      // Stopped by a refused password: resumes once the device answers again.
      if (!existing.running) {
        existing.restart();
      }
      return;
    }
    const stream = new EventStream({
      device,
      onEvents: (events) =>
        this.onEvents(device, events).catch((err) =>
          this.problem(
            `event-${origin}`,
            `Cannot handle an event of ${device.label}: ${err.message}`,
          ),
        ),
      onOpen: (transport) => this.streamOpened(device, transport),
      onClose: (err) => this.streamClosed(device, err),
      timings: this.streamTimings,
      now: this.now,
    });
    this.streams.set(origin, stream);
    stream.start();
  }

  closeStreams() {
    for (const stream of this.streams.values()) {
      stream.stop();
    }
    this.streams.clear();
  }

  streamOpened(device, transport) {
    this.resolved(
      `stream-${device.host.origin}`,
      `Live events of ${device.label}: connected again`,
    );
    logger.debug(`Event stream of ${device.label} open (${transport})`);
    this.scheduleRefresh();
    this.afterChanges().catch(() => {});
  }

  streamClosed(device, err) {
    const origin = device.host.origin;
    if (err.fallback) {
      logger.debug(`WebSocket events of ${device.label} unavailable, RTSP instead: ${err.message}`);
    } else if (err.kind === ERROR_KINDS.BLOCKED) {
      logger.debug(`Live events of ${device.label} stopped: ${err.message}`);
    } else {
      // A device lost is lifecycle (info); a refused password is a problem
      // to fix (warn). Once per outage either way.
      const level = err.kind === ERROR_KINDS.AUTH ? 'warn' : 'info';
      this.problem(
        `stream-${origin}`,
        `Live events of ${device.label} interrupted: ${err.message}`,
        level,
      );
    }
    // Its changes are lost while it is closed: nothing stays detected but the
    // inputs, which the reads keep up to date.
    for (const channel of this.channels().filter((entry) => entry.origin === origin)) {
      const features = this.active.get(channel.key);
      if (!features) {
        continue;
      }
      let cleared = false;
      for (const [feature, sources] of features) {
        if (!feature.startsWith(INPUT_PREFIX) && sources.size > 0) {
          sources.clear();
          cleared = true;
        }
      }
      if (cleared) {
        this.publishStates(channel).catch(() => {});
      }
    }
    if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
      const read = this.reads.get(origin);
      if (read) {
        if (read.ok !== false) {
          read.downSince = this.now();
        }
        read.ok = false;
        read.error = err;
      }
    }
    this.scheduleRefresh();
    this.afterChanges().catch(() => {});
  }

  async onEvents(device, events) {
    const context = device.eventContext();
    const channels = this.channels().filter((entry) => entry.origin === device.host.origin);
    const touched = new Set();
    const learned = [];
    const persons = [];
    const rings = [];
    for (const event of events) {
      const { effects, rule, scenario } = interpret(event, context);
      if (effects.length === 0) {
        logger.debug(`Event ${event.topic} of ${device.label}: ignored`);
        continue;
      }
      logger.debug(
        `Event ${event.topic} (${event.operation}) of ${device.label}: ${JSON.stringify(event.data)}`,
      );
      const live = event.operation !== OPERATIONS.INITIALIZED;
      for (const effect of effects) {
        const channel = channels.find((entry) => entry.index === effect.channel) ?? channels[0];
        if (!channel) {
          continue;
        }
        touched.add(channel);
        if (effect.setting) {
          this.settings.set(channel.key, {
            ...this.settings.get(channel.key),
            [effect.setting]: effect.value,
          });
          continue;
        }
        if (effect.pulse) {
          if (live) {
            this.pulse(channel, effect.key);
            rings.push(channel);
          }
          continue;
        }
        // Every detection a VMD profile reports names person and vehicle,
        // off: those are learned only once really seen.
        const seen = effect.on || (effect.key !== KEYS.PERSON && effect.key !== KEYS.VEHICLE);
        if (seen && LEARNABLE.has(effect.key) && !featureKeys(channel).includes(effect.key)) {
          learned.push([channel, effect.key]);
        }
        const features = this.activeOf(channel.key);
        const sources = features.get(effect.key) ?? new Set();
        features.set(effect.key, sources);
        const before = sources.size > 0;
        if (effect.on) {
          sources.add(effect.source);
        } else {
          sources.delete(effect.source);
        }
        if (effect.key === KEYS.PERSON && !before && sources.size > 0 && live) {
          persons.push({ channel, rule: this.ruleName(device, rule, scenario) });
        }
      }
    }
    if (learned.length > 0) {
      await this.learn(learned);
    }
    for (const channel of touched) {
      await this.publishStates(channel);
    }
    for (const channel of rings) {
      await this.ring(channel);
    }
    for (const { channel, rule } of persons) {
      await this.personDetected(channel, rule);
    }
  }

  /** The name of the rule behind a detection: the AOA scenario, the profile. */
  ruleName(device, rule, scenario) {
    if (scenario) {
      const found = device.info?.scenarios?.find((entry) => entry.id === scenario);
      if (found) {
        return found.name;
      }
    }
    return rule ?? null;
  }

  /** Features seen in the events that the description did not show: added. */
  async learn(entries) {
    const added = [];
    for (const [channel, key] of entries) {
      const learned = this.learned.get(channel.key) ?? new Set();
      if (!learned.has(key)) {
        learned.add(key);
        this.learned.set(channel.key, learned);
        added.push(`${channelName(channel)} ${key}`);
      }
    }
    if (added.length === 0) {
      return;
    }
    this.save();
    logger.debug(`Features learned from the events: ${added.join(', ')}`);
    await this.publishDevices();
  }

  // --- Rings, persons and their scene events ------------------------------------------

  /** One trigger per channel and window: true when this one may fire. */
  mayFire(key, channel) {
    const id = `${key}:${channel.key}`;
    const last = this.lastTriggers.get(id);
    if (last !== undefined && this.now() - last < this.timings.triggerSpacingMs) {
      return false;
    }
    this.lastTriggers.set(id, this.now());
    return true;
  }

  async ring(channel) {
    if (!this.mayFire(TRIGGERS.DOORBELL, channel)) {
      return;
    }
    const detection = this.remember(channel, 'ring');
    await this.imageFor(channel, detection);
    await this.fire(TRIGGERS.DOORBELL, {
      doorbell: channelIds(this.gladys, channel).device,
      doorbell_name: channelName(channel, this.language),
    });
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async personDetected(channel, rule) {
    if (!this.mayFire(TRIGGERS.PERSON, channel)) {
      return;
    }
    const detection = this.remember(channel, 'person');
    await this.imageFor(channel, detection);
    await this.fire(TRIGGERS.PERSON, {
      camera: channelIds(this.gladys, channel).device,
      camera_name: channelName(channel, this.language),
      rule_name: rule ?? null,
    });
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Keep a detection for the widget. */
  remember(channel, kind) {
    this.detectionCount += 1;
    const detection = {
      id: `${this.now().toString(36)}${this.detectionCount.toString(36)}`,
      at: this.now(),
      key: channel.key,
      kind,
      imageKey: null,
    };
    this.detections.unshift(detection);
    for (const dropped of this.detections.splice(MAX_DETECTIONS)) {
      this.thumbnails.delete(dropped.imageKey);
    }
    this.detectionTimes.push(detection.at);
    if (this.detectionTimes.length > MAX_COUNTED) {
      this.detectionTimes.splice(0, this.detectionTimes.length - MAX_COUNTED);
    }
    return detection;
  }

  /** Detections over the last 24 hours, of one channel or all. */
  detectionsToday(key) {
    const since = this.now() - DAY_MS;
    if (key) {
      return this.detections.filter((entry) => entry.key === key && entry.at >= since).length;
    }
    this.detectionTimes = this.detectionTimes.filter((at) => at >= since);
    return this.detectionTimes.length;
  }

  /** A fresh image for a detection, waited for a few seconds at most. */
  async imageFor(channel, detection) {
    if (!channel.hasVideo) {
      return;
    }
    const read = this.cameraImage(channel).then((image) => {
      if (image && !detection.imageKey) {
        detection.imageKey = `det-${detection.id.replace(/[^a-z0-9]/g, '').slice(0, 40)}`;
        this.thumbnails.set(detection.imageKey, image.slice(image.indexOf(',') + 1));
      }
    });
    await Promise.race([read, delay(this.timings.eventImageWaitMs)]);
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.resolved('scene-event');
    } catch (err) {
      this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  /** A momentary detection: on now, off after `pulseMs`. */
  pulse(channel, key) {
    const timers = this.pulses.get(channel.key) ?? new Map();
    this.pulses.set(channel.key, timers);
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => {
      timers.delete(key);
      const current = this.channels().find((entry) => entry.key === channel.key);
      if (current && !this.stopped) {
        this.publishStates(current).catch(() => {});
      }
    }, this.timings.pulseMs);
    timer.unref?.();
    timers.set(key, timer);
  }

  // --- Publishing to Gladys ----------------------------------------------------

  /** Whether the user added the device to Gladys. */
  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  async publishDevices() {
    const devices = this.channels().map((channel) =>
      buildDevice(this.gladys, channel, { language: this.language }),
    );
    const key = JSON.stringify(devices);
    if (key === this.discovery) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale device.
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovery = key;
      this.resolved('discovery');
    } catch (err) {
      this.problem('discovery', `Discovered devices refused: ${err.message}`);
    }
  }

  /**
   * "Search" in the Discovery tab: describe the devices again (a new input,
   * a new scenario…), and say in the logs which Axis devices of the network
   * are not configured yet.
   */
  async rediscover() {
    this.discovery = null;
    if (!(await this.refresh({ describe: true }))) {
      await this.publishDevices();
    }
    const found = await this.scan();
    if (found) {
      const unknown = found.filter((candidate) => !this.configuredSerials().has(candidate.serial));
      if (unknown.length > 0) {
        logger.info(
          `Axis devices on the network not configured yet: ${unknown
            .map((candidate) => `${candidate.name} (${candidate.address})`)
            .join(', ')}`,
        );
      }
    }
  }

  /** The user added a device: the SDK forgot its values, send them again. */
  async onDeviceCreated(device) {
    const channel = this.findChannel(device.external_id);
    if (!channel) {
      return;
    }
    await this.publishStates(channel);
    await this.publishTransports();
    if (channel.hasVideo && this.isOnline(channel.origin)) {
      this.cameraImage(channel).catch(() => {});
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async publishAllStates() {
    for (const channel of this.channels()) {
      await this.publishStates(channel);
    }
  }

  /** The current values of one channel, sent if they changed. */
  async publishStates(channel) {
    const ids = channelIds(this.gladys, channel);
    if (!this.isCreated(ids.device)) {
      return;
    }
    const values = featureValues(channel, {
      online: this.isOnline(channel.origin),
      active: this.activeKeys(channel.key),
      pulses: new Set(this.pulses.get(channel.key)?.keys() ?? []),
      settings: this.settings.get(channel.key),
    });
    const states = Object.entries(values)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => ({ device_feature_external_id: ids.feature(key), state: value }));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.resolved('states');
    } catch (err) {
      this.problem('states', `States of ${channelName(channel)} refused: ${err.message}`);
    }
  }

  /** After any change: devices offline and back, transports, status, widget. */
  async afterChanges() {
    let changed = false;
    for (const device of this.devices.values()) {
      const origin = device.host.origin;
      const online = this.isOnline(origin);
      const before = this.online.get(origin);
      if (before !== online) {
        changed = true;
        if (before !== undefined) {
          logger.info(`${device.label} is ${online ? 'online again' : 'offline'}`);
          await this.publishAllStates();
        }
      }
      this.online.set(origin, online);
    }
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (changed) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  async publishTransports() {
    const entries = [];
    for (const channel of this.channels()) {
      const externalId = channelIds(this.gladys, channel).device;
      if (!this.isCreated(externalId)) {
        continue;
      }
      const transport = this.isOnline(channel.origin)
        ? DEVICE_TRANSPORTS.LOCAL
        : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name, in the Configuration screen. */
  connectionStatus() {
    const config = this.config;
    if (!config || config.devices.length === 0) {
      let message = CONNECTION_TEXT.noHost;
      if (config?.noPassword.length > 0) {
        message = CONNECTION_TEXT.noPassword;
      } else if (config?.invalidHosts.length > 0) {
        message = CONNECTION_TEXT.invalidHost;
      }
      return { connected: false, message };
    }
    const reads = [...this.reads.values()];
    if (reads.some((read) => read.ok === null)) {
      return null; // first read not done yet
    }
    const failed = reads.filter((read) => read.ok === false);
    const refused = failed.find((read) =>
      [ERROR_KINDS.AUTH, ERROR_KINDS.BLOCKED].includes(read.error?.kind),
    );
    if (refused) {
      return { connected: false, message: ERROR_TEXT[ERROR_KINDS.BLOCKED] };
    }
    if (failed.length === reads.length) {
      return { connected: false, message: ERROR_TEXT[failed[0].error?.kind] ?? ERROR_TEXT.http };
    }
    if (config.noPassword.length > 0) {
      return { connected: true, message: CONNECTION_TEXT.noPassword };
    }
    if (failed.length > 0 || config.invalidHosts.length > 0) {
      return { connected: true, message: CONNECTION_TEXT.someDown };
    }
    // A stream still connecting at start is not news: only a lost one is.
    const lost = [...this.devices.values()].some(
      (device) =>
        !this.streams.get(device.host.origin)?.open &&
        this.warned.has(`stream-${device.host.origin}`),
    );
    if (lost) {
      return { connected: true, message: CONNECTION_TEXT.live };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    if (!status) {
      return;
    }
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  // --- Camera images -------------------------------------------------------------

  /**
   * A fresh image of a channel, sent to Gladys when the camera is added.
   * Concurrent calls share the read; a read younger than `imageSpacingMs` is
   * reused (the core takes 12 images a minute per camera).
   * @returns {Promise<string|null>} the `image/jpg;base64,…` string
   */
  cameraImage(channel) {
    const last = this.images.get(channel.key);
    if (last && this.now() - last.at < this.timings.imageSpacingMs) {
      return Promise.resolve(last.image);
    }
    const running = this.imageReads.get(channel.key);
    if (running) {
      return running;
    }
    const read = this.readImage(channel).finally(() => this.imageReads.delete(channel.key));
    this.imageReads.set(channel.key, read);
    return read;
  }

  async readImage(channel) {
    let image;
    try {
      const device = channel.device;
      image = await fittedSnapshot(
        (options) => device.client.snapshot(channel.index + 1, options),
        device.info,
      );
      this.resolved(`image-${channel.key}`, `Images of ${channelName(channel)}: back`);
    } catch (err) {
      this.problem(`image-${channel.key}`, `No image from ${channelName(channel)}: ${err.message}`);
      return null;
    }
    this.images.set(channel.key, { at: this.now(), image });
    const externalId = channelIds(this.gladys, channel).device;
    if (this.isCreated(externalId)) {
      try {
        await this.gladys.publishCameraImage(externalId, image);
        this.resolved('camera-image');
      } catch (err) {
        this.problem('camera-image', `Image of ${channelName(channel)} refused: ${err.message}`);
      }
    }
    return image;
  }

  /** The timer of the configuration: every added camera online, one after the other. */
  async snapshotAll() {
    const half = (this.config?.snapshotIntervalMs ?? 0) / 2;
    for (const channel of this.channels()) {
      const externalId = channelIds(this.gladys, channel).device;
      const last = this.images.get(channel.key);
      // Skip a camera imaged less than half a period ago (a detection did it).
      if (
        !channel.hasVideo ||
        !this.isOnline(channel.origin) ||
        !this.isCreated(externalId) ||
        (last && this.now() - last.at < half)
      ) {
        continue;
      }
      await this.cameraImage(channel);
    }
  }

  /** Gladys asks for a fresh image (scene "send camera image", AI). */
  async getImage(device) {
    const channel = this.findChannel(device.external_id);
    if (!channel) {
      throw new Error(pick(ACTION_TEXT.unknownDevice, this.language));
    }
    if (!channel.hasVideo) {
      throw new Error(pick(ACTION_TEXT.noVideo, this.language));
    }
    const image = await this.cameraImage(channel);
    if (!image) {
      throw new Error(pick(ACTION_TEXT.snapshotFailed, this.language));
    }
    return image;
  }

  // --- Commands --------------------------------------------------------------------

  requireChannel(externalId) {
    if (this.devices.size === 0) {
      throw new Error(pick(ACTION_TEXT.notConfigured, this.language));
    }
    if (!externalId) {
      throw new Error(pick(ACTION_TEXT.pickDevice, this.language));
    }
    const channel = this.findChannel(externalId);
    if (!channel) {
      throw new Error(pick(ACTION_TEXT.unknownDevice, this.language));
    }
    return channel;
  }

  /** The error thrown to Gladys for a failed command, in the language of the config. */
  commandError(err) {
    return new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, this.language), { cause: err });
  }

  /** A command of a feature: the infrared light, the only one. */
  async setValue(device, feature, value) {
    const channel = this.findChannel(device.external_id);
    const ids = channel ? channelIds(this.gladys, channel) : null;
    if (
      !channel ||
      ids.feature(KEYS.IR_LIGHT) !== feature.external_id ||
      !featureKeys(channel).includes(KEYS.IR_LIGHT)
    ) {
      throw new Error(`No command for ${feature.external_id}`);
    }
    const on = Number(value) === 1;
    try {
      await channel.device.client.setLight(channel.device.info.irLight, on);
    } catch (err) {
      logger.warn(`${channelName(channel)}: infrared light not set: ${err.message}`);
      throw this.commandError(err);
    }
    logger.info(`${channelName(channel)}: infrared light ${on ? 'on' : 'off'}`);
    this.settings.set(channel.key, { ...this.settings.get(channel.key), irLight: on });
    await this.publishStates(channel);
  }

  /** Scene action and widget: a fresh image now, sent to Gladys. */
  async refreshSnapshot(externalId) {
    const channel = this.requireChannel(externalId);
    if (!channel.hasVideo) {
      throw new Error(pick(ACTION_TEXT.noVideo, this.language));
    }
    logger.info(`Scene action: fresh image of ${channelName(channel)}`);
    const image = await this.cameraImage(channel);
    if (!image) {
      throw new Error(pick(ACTION_TEXT.snapshotFailed, this.language));
    }
    return image;
  }

  /** The clip of a device by its number ("0", "7") or its name. */
  findClip(info, wanted) {
    const text = String(wanted ?? '').trim();
    const clips = info?.clips ?? [];
    if (!text) {
      return clips[0] ?? null;
    }
    return (
      clips.find((clip) => clip.id === text) ??
      clips.find((clip) => clip.name.toLowerCase() === text.toLowerCase()) ??
      null
    );
  }

  /** Scene action: play an audio clip stored on the device. */
  async playClip(externalId, wanted) {
    const channel = this.requireChannel(externalId);
    const clip = this.findClip(channel.device.info, wanted);
    if (!clip) {
      throw new Error(pick(ACTION_TEXT.noClip, this.language));
    }
    try {
      await channel.device.client.playClip(clip.id);
    } catch (err) {
      logger.warn(
        `Scene action: clip "${clip.name}" of ${channelName(channel)} not played: ${err.message}`,
      );
      throw this.commandError(err);
    }
    logger.info(`Scene action: clip "${clip.name}" played on ${channelName(channel)}`);
    return { clip_name: clip.name };
  }

  /**
   * Scene action: drive an output (relay). Disabled unless allowed in the
   * configuration (on a door station an output opens the door); sent once,
   * never retried.
   */
  async setOutput(externalId, number, action) {
    if (!this.config?.allowOutputs) {
      throw new Error(pick(ACTION_TEXT.outputsDisabled, this.language));
    }
    const channel = this.requireChannel(externalId);
    const port = channel.device.output(number);
    const command = OUTPUT_ACTIONS[action];
    if (!port || !command) {
      throw new Error(pick(ACTION_TEXT.noOutput, this.language));
    }
    const label = port.name || `output ${number}`;
    try {
      await channel.device.client.setOutput(port, command);
    } catch (err) {
      logger.warn(`Scene action: ${label} of ${channelName(channel)} not set: ${err.message}`);
      throw this.commandError(err);
    }
    logger.info(`Scene action: ${label} of ${channelName(channel)}: ${action}`);
    return { output_name: port.name || String(number) };
  }

  // --- Configuration actions -------------------------------------------------------

  /** The serials of the configured devices described so far. */
  configuredSerials() {
    return new Set([...this.devices.values()].map((device) => device.info?.serial).filter(Boolean));
  }

  /**
   * "Test the connection": describe every device again (it also lifts the
   * stop after a refused password) and report, in four languages.
   */
  async testConnection() {
    if (this.devices.size === 0) {
      return this.connectionStatus().message;
    }
    // One more try of a refused password, asked by the user: its event
    // stream follows only if the read succeeds (readSucceeded).
    for (const device of this.devices.values()) {
      device.client.unblock();
    }
    await this.refresh({ describe: true });
    const lines = [...this.devices.values()].map((device) => ({
      device,
      read: this.reads.get(device.host.origin),
      stream: this.streams.get(device.host.origin),
    }));
    const ok = lines.filter(({ read }) => read.ok).length;
    logger.info(`Connection test: ${ok} of ${lines.length} device(s) answered`);
    return localized((language) =>
      lines
        .map(({ device, read, stream }) => {
          const text = REPORT_TEXT[language];
          if (read.ok && device.info) {
            const info = device.info;
            const transport = TRANSPORT_TEXT[language][stream?.open ? stream.transport : 'none'];
            return text.ok(
              device.label,
              `AXIS ${info.model ?? info.serial}`,
              info.hasVideo ? info.channels.length : 0,
              transport,
            );
          }
          return text.failed(
            device.label,
            pick(ERROR_TEXT[read.error?.kind] ?? ERROR_TEXT.http, language),
          );
        })
        .join('\n'),
    );
  }

  /**
   * "Video stream address": the RTSP address of a camera, for the "RTSP
   * camera" integration of Gladys, with the user name and a PASSWORD
   * placeholder: the password is never shown nor logged.
   */
  streamUrl(externalId) {
    const channel = this.requireChannel(externalId);
    if (!channel.hasVideo) {
      throw new Error(pick(ACTION_TEXT.noVideo, this.language));
    }
    const host = new URL(channel.origin).hostname;
    const port = channel.device.info.rtspPort ?? 554;
    const user = encodeURIComponent(channel.device.host.username);
    const rtsp = `rtsp://${user}:PASSWORD@${host}:${port}/axis-media/media.amp?camera=${channel.index + 1}`;
    logger.info(`Configuration action: stream address of ${channelName(channel)} shown`);
    return localized((language) => `${pick(ACTION_TEXT.stream, language)} ${rtsp}`);
  }

  /** "Audio clips": the clips of every device, by number and name. */
  audioClips() {
    if (this.devices.size === 0) {
      return ACTION_TEXT.notConfigured;
    }
    logger.info('Configuration action: audio clips listed');
    const devices = [...this.devices.values()].filter((device) => device.info);
    return localized((language) =>
      devices
        .map((device) => {
          const name = `AXIS ${device.info.model ?? device.info.serial} (${device.label})`;
          const clips = device.info.clips ?? [];
          return clips.length > 0
            ? CLIPS_TEXT[language].list(
                name,
                clips.map((clip) => `${clip.id} = ${clip.name}`).join(', '),
              )
            : CLIPS_TEXT[language].none(name);
        })
        .join('\n'),
    );
  }

  /** mDNS and SSDP through the core; null when this Gladys cannot search. */
  async scan() {
    const results = await Promise.allSettled([
      this.gladys.scanNetwork('mdns', { timeoutSeconds: this.timings.scanSeconds }),
      this.gladys.scanNetwork('ssdp', { timeoutSeconds: this.timings.scanSeconds }),
    ]);
    if (results.every((result) => result.status === 'rejected')) {
      this.problem('scan', `Network search unavailable: ${results[0].reason?.message}`);
      return null;
    }
    this.resolved('scan', 'Network search available again');
    const [mdns, ssdp] = results.map((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
    return mergeCandidates(mdnsCandidates(mdns), ssdpCandidates(ssdp));
  }

  /** "Search the network": the Axis devices that answer, configured or not. */
  async searchNetwork() {
    const found = await this.scan();
    logger.info(`Configuration action: network search, ${found ? found.length : 'no'} answer(s)`);
    if (!found) {
      return localized((language) => SEARCH_TEXT[language].unavailable());
    }
    if (found.length === 0) {
      return localized((language) => SEARCH_TEXT[language].none());
    }
    const bySerial = new Map(
      [...this.devices.values()]
        .filter((device) => device.info)
        .map((device) => [device.info.serial, device]),
    );
    return localized((language) =>
      found
        .map((candidate) => {
          const text = SEARCH_TEXT[language];
          const device = bySerial.get(candidate.serial);
          if (!device) {
            return text.found(candidate.name, candidate.address);
          }
          const configured = new URL(device.host.origin).host;
          return configured === candidate.address || device.label === candidate.address
            ? text.configured(candidate.name, candidate.address)
            : this.reads.get(device.host.origin)?.ok === false
              ? text.moved(candidate.name, candidate.address)
              : text.configured(candidate.name, device.label);
        })
        .join('\n'),
    );
  }

  // --- Widget ------------------------------------------------------------------------

  /** What the widget shows: the channels and the detections. */
  view() {
    return {
      configured: this.devices.size > 0,
      channels: this.channels().map((channel) => ({
        ...channel,
        online: this.isOnline(channel.origin),
        externalId: channelIds(this.gladys, channel).device,
      })),
      detections: this.detections,
      detectionsToday: (key) => this.detectionsToday(key),
      failed: [...this.reads.values()]
        .filter((read) => read.ok === false)
        .map((read) => read.error),
    };
  }

  /** The raw base64 of a detection image of the widget. */
  thumbnail(key) {
    const image = this.thumbnails.get(key);
    if (!image) {
      throw new Error(`Unknown image ${key}`);
    }
    return image;
  }
}
