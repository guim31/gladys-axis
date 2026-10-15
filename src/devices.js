// -----------------------------------------------------------------------------
// The Gladys devices: one per video source of an Axis device (a camera has
// one, a multi-sensor camera several), one for a device without video (a
// network speaker).
//
// Identity: the serial number the device reports, never an address or a
// name: `gladys.externalIds('axis', serial)`, `…('axis', '<serial>-cam<n>')`
// for video source n of a multi-sensor camera. Feature keys are permanent
// once published (test/gladys-rules.test.js checks the couples against the
// core table).
//
// Features, each one only when the device has it (described, or seen in its
// events — "one sensor per event present"):
//   image        camera/image          snapshots (devices with video)
//   online       input/binary          the device answers (shown On/Off)
//   motion       motion-sensor/binary  VMD, guard suite, ONVIF motion region
//   object       motion-sensor/binary  any AXIS Object Analytics scenario
//   person       motion-sensor/binary  an object classified human
//   vehicle      motion-sensor/binary  an object classified vehicle
//   pir          motion-sensor/binary  the PIR sensor of the device
//   audio        input/binary          the sound level trigger
//   tamper       tamper/binary         the camera was moved or covered
//   night_mode   input/binary          day/night: infrared cut filter off
//   ring         doorbell/ring         the call button of a door station
//   ir_light     light/binary          the infrared illuminator (command)
//   input_<id>   input/binary          each digital input (but the call button)
// The device-wide ones (inputs, ring, PIR, audio, infrared) go on the first
// video source. The outputs (relays) are never a feature: on a door station
// they open the door, so they are a scene action only, off by default
// (src/scenes.js). "Online" is input/binary: presence-sensor would read
// "Presence detected" on a camera. Audio and night have no category of their
// own in Gladys: an input reads On/Off.
//
// The devices are published with should_poll: false: the integration follows
// the event streams and reads the devices on its own timer (src/hub.js),
// never waiting for Gladys to poll (GladysAssistant/Gladys#3198).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { INPUT_PREFIX, KEYS, inputKey } from './axis/model.js';

export const DEVICE_TYPE = 'axis';
export { KEYS as FEATURE_KEYS };

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    image: 'Image',
    online: 'Online',
    motion: 'Motion',
    object: 'Object analytics',
    person: 'Person',
    vehicle: 'Vehicle',
    pir: 'PIR sensor',
    audio: 'Sound detection',
    tamper: 'Tampering',
    night_mode: 'Night mode',
    ring: 'Doorbell ring',
    ir_light: 'Infrared light',
    input: 'Input',
  },
  fr: {
    image: 'Image',
    online: 'En ligne',
    motion: 'Mouvement',
    object: "Analyse d'objets",
    person: 'Personne',
    vehicle: 'Véhicule',
    pir: 'Détecteur PIR',
    audio: 'Détection sonore',
    tamper: 'Sabotage',
    night_mode: 'Mode nuit',
    ring: 'Sonnette',
    ir_light: 'Éclairage infrarouge',
    input: 'Entrée',
  },
  de: {
    image: 'Bild',
    online: 'Online',
    motion: 'Bewegung',
    object: 'Objektanalyse',
    person: 'Person',
    vehicle: 'Fahrzeug',
    pir: 'PIR-Sensor',
    audio: 'Geräuscherkennung',
    tamper: 'Sabotage',
    night_mode: 'Nachtmodus',
    ring: 'Türklingel',
    ir_light: 'Infrarotlicht',
    input: 'Eingang',
  },
  es: {
    image: 'Imagen',
    online: 'En línea',
    motion: 'Movimiento',
    object: 'Análisis de objetos',
    person: 'Persona',
    vehicle: 'Vehículo',
    pir: 'Sensor PIR',
    audio: 'Detección de sonido',
    tamper: 'Sabotaje',
    night_mode: 'Modo noche',
    ring: 'Timbre',
    ir_light: 'Luz infrarroja',
    input: 'Entrada',
  },
};

// Names of the devices, when several video sources share a model.
export const SOURCE_NAMES = {
  en: 'camera',
  fr: 'caméra',
  de: 'Kamera',
  es: 'cámara',
};

const sensor = (category, type = DEVICE_FEATURE_TYPES.SENSOR.BINARY) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
});

const DEFINITIONS = {
  [KEYS.IMAGE]: {
    category: DEVICE_FEATURE_CATEGORIES.CAMERA,
    type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
    read_only: true,
    has_feedback: false,
    // Images travel on their own channel, never in the states history.
    keep_history: false,
    min: 0,
    max: 0,
  },
  [KEYS.ONLINE]: sensor(DEVICE_FEATURE_CATEGORIES.INPUT),
  [KEYS.MOTION]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [KEYS.OBJECT]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [KEYS.PERSON]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [KEYS.VEHICLE]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [KEYS.PIR]: sensor(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
  [KEYS.AUDIO]: sensor(DEVICE_FEATURE_CATEGORIES.INPUT),
  [KEYS.TAMPER]: sensor(DEVICE_FEATURE_CATEGORIES.TAMPER),
  [KEYS.NIGHT]: sensor(DEVICE_FEATURE_CATEGORIES.INPUT),
  [KEYS.RING]: sensor(DEVICE_FEATURE_CATEGORIES.DOORBELL, DEVICE_FEATURE_TYPES.DOORBELL.RING),
  [KEYS.IR_LIGHT]: {
    category: DEVICE_FEATURE_CATEGORIES.LIGHT,
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    min: 0,
    max: 1,
  },
};

const definition = (key) =>
  key.startsWith(INPUT_PREFIX) ? sensor(DEVICE_FEATURE_CATEGORIES.INPUT) : DEFINITIONS[key];

/** The platform id of a video source: the serial, plus the source on a multi-sensor camera. */
export function platformId(channel) {
  const serial = String(channel.serial).replace(/[^A-Za-z0-9]/g, '');
  return channel.count > 1 ? `${serial}-cam${channel.index + 1}` : serial;
}

/** External ids of a channel and its features. */
export const channelIds = (gladys, channel) => gladys.externalIds(DEVICE_TYPE, platformId(channel));

/** The name shown for a channel: `AXIS P3268-LVE`, `AXIS P4705-PLVE caméra 2`. */
export function channelName(channel, language = 'en') {
  const base = channel.model ? `AXIS ${channel.model}` : `Axis ${String(channel.serial).slice(-6)}`;
  if (channel.count > 1) {
    return `${base} ${SOURCE_NAMES[language] ?? SOURCE_NAMES.en} ${channel.index + 1}`;
  }
  return base;
}

/** The inputs of a channel (the first video source has them all). */
export function channelInputs(channel) {
  if (channel.index !== 0) {
    return [];
  }
  return (channel.ports ?? []).filter((port) => port.direction === 'input' && !port.doorbell);
}

/**
 * The name of an input feature: its name on the device, or "Input 1".
 * @param {string[]} [taken] names of the other features of the device
 */
export function inputName(port, inputs, language = 'en', taken = []) {
  const names = NAMES[language] ?? NAMES.en;
  const generic = `${names.input} ${Number(port.id) + 1}`;
  const name = port.name?.trim();
  if (!name) {
    return generic;
  }
  // Two inputs with the same name, or an input named like another feature
  // ("PIR sensor" on cameras with a PIR): numbered.
  const twins = inputs.filter((other) => other.name?.trim() === name).length;
  return twins > 1 || taken.includes(name) ? `${generic} (${name})` : name;
}

/**
 * The feature keys of a channel, in display order.
 * @param {object} channel { index, hasVideo, caps, learned: Set, ports }
 */
export function featureKeys(channel) {
  const caps = channel.caps ?? {};
  const learned = channel.learned ?? new Set();
  const has = (key) => Boolean(caps[key]) || learned.has(key);
  const first = channel.index === 0;
  return [
    channel.hasVideo && KEYS.IMAGE,
    KEYS.ONLINE,
    has(KEYS.MOTION) && KEYS.MOTION,
    has(KEYS.OBJECT) && KEYS.OBJECT,
    has(KEYS.PERSON) && KEYS.PERSON,
    has(KEYS.VEHICLE) && KEYS.VEHICLE,
    first && has(KEYS.PIR) && KEYS.PIR,
    first && has(KEYS.AUDIO) && KEYS.AUDIO,
    has(KEYS.TAMPER) && KEYS.TAMPER,
    has(KEYS.NIGHT) && KEYS.NIGHT,
    first && has(KEYS.RING) && KEYS.RING,
    first && caps[KEYS.IR_LIGHT] && KEYS.IR_LIGHT,
    ...channelInputs(channel).map((port) => inputKey(port.id)),
  ].filter(Boolean);
}

/**
 * The discovery payload of a channel.
 * @param {object} gladys SDK client
 * @param {object} channel see src/hub.js
 * @param {object} [options] { language }
 */
export function buildDevice(gladys, channel, { language = 'en' } = {}) {
  const ids = channelIds(gladys, channel);
  const names = NAMES[language] ?? NAMES.en;
  const inputs = channelInputs(channel);
  const keys = featureKeys(channel);
  const taken = keys.filter((key) => !key.startsWith(INPUT_PREFIX)).map((key) => names[key]);
  const nameOf = (key) => {
    if (key.startsWith(INPUT_PREFIX)) {
      const port = inputs.find((entry) => inputKey(entry.id) === key);
      return inputName(port, inputs, language, taken);
    }
    return names[key];
  };
  return {
    name: channelName(channel, language),
    external_id: ids.device,
    ...(channel.model ? { model: `AXIS ${channel.model}` } : {}),
    should_poll: false,
    params: [
      { name: 'host', value: channel.host },
      ...(channel.hasVideo ? [{ name: 'video_source', value: String(channel.index + 1) }] : []),
    ],
    features: keys.map((key) => ({
      ...definition(key),
      name: nameOf(key),
      external_id: ids.feature(key),
    })),
  };
}

const flag = (value) => (value ? 1 : 0);

/**
 * The value of every feature of a channel (null: nothing to publish yet).
 * @param {object} channel see src/hub.js
 * @param {object} live { online, active: Set of latched keys, pulses: Set, settings }
 */
export function featureValues(channel, live) {
  const values = {};
  for (const key of featureKeys(channel)) {
    if (key === KEYS.IMAGE) {
      continue;
    }
    if (key === KEYS.ONLINE) {
      values[key] = flag(live.online);
    } else if (key === KEYS.IR_LIGHT) {
      const on = live.settings?.irLight;
      values[key] = on === undefined || on === null ? null : flag(on);
    } else {
      values[key] = flag(live.active.has(key) || live.pulses.has(key));
    }
  }
  return values;
}
