// -----------------------------------------------------------------------------
// What an Axis event means for the Gladys features. Pure functions: the hub
// (src/hub.js) keeps the states, this file only reads the topics.
//
// An event becomes zero or more effects:
//   { channel, key, source, on }        a latched detection: the feature is
//                                       on while one of its sources is on
//   { channel, key, pulse: true }       a momentary one (a ring): 1, then 0
//   { channel, key, setting, value }    a setting reported by the device
//                                       (the infrared light)
// `channel` is the video source (0, 1…), `source` tells apart the profiles or
// scenarios feeding the same feature (two VMD profiles on one camera).
//
// Topics (Kane610/axis and the Home Assistant integration, both MIT /
// Apache-2.0, and the ONVIF topics of AXIS OS):
//   motion  VMD 4 `CameraApplicationPlatform/VMD/Camera<n>Profile<p>`, VMD 3,
//           the old `VideoAnalytics/MotionDetection`, ONVIF
//           `RuleEngine/MotionRegionDetector/Motion`, and the guard suite
//           (Motion, Fence, Loitering Guard)
//   object  AXIS Object Analytics `ObjectAnalytics/Device<n>Scenario<s>`
//   person, vehicle  an AOA scenario or a guard profile whose `classTypes`
//           (or, failing that, the object classes of the scenario) name a
//           human or a vehicle
//   pir     `Device/Sensor/PIR`
//   audio   `AudioSource/TriggerLevel` (the sound level trigger)
//   tamper  `VideoSource/GlobalSceneChange/ImagingService`, `VideoSource/Tampering`
//   night_mode  `VideoSource/DayNightVision` (`day` 0: night, infrared on)
//   input_<id>  `Device/IO/Port`, `Device/IO/SupervisedPort` (inputs)
//   ring    the input of the call button of a door station
//   ir_light    `Device/Light/Status` of an infrared light
// -----------------------------------------------------------------------------

export const KEYS = Object.freeze({
  IMAGE: 'image',
  ONLINE: 'online',
  MOTION: 'motion',
  OBJECT: 'object',
  PERSON: 'person',
  VEHICLE: 'vehicle',
  PIR: 'pir',
  AUDIO: 'audio',
  TAMPER: 'tamper',
  NIGHT: 'night_mode',
  RING: 'ring',
  IR_LIGHT: 'ir_light',
});

export const INPUT_PREFIX = 'input_';
export const inputKey = (portId) => `${INPUT_PREFIX}${portId}`;

const TRUE_VALUES = new Set(['1', 'true', 'active', 'on', 'high', 'yes']);
export const isOn = (value) =>
  TRUE_VALUES.has(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

const PERSON_CLASS = /^(human|person|face)$/i;
const VEHICLE_CLASS = /^(vehicle|car|truck|bus|motorcycle|motorbike|bike|bicycle)$/i;

/** The class types an event names (`classTypes` "human,car" or "human"). */
export function classTypes(data) {
  return String(data?.classTypes ?? data?.classType ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean);
}

/**
 * Which of person / vehicle a scenario or a profile detects.
 * @param {string[]} types class types of the event
 * @param {string[]} [configured] object classes configured on the scenario
 *   (AOA `objectClassifications[].type`): used when the event names none
 */
export function detectedClasses(types, configured = []) {
  const list = types.length > 0 ? types : configured;
  return {
    person: list.some((type) => PERSON_CLASS.test(type)),
    vehicle: list.some((type) => VEHICLE_CLASS.test(type)),
  };
}

const clampChannel = (index, channels) =>
  Number.isInteger(index) && index >= 0 && index < Math.max(channels, 1) ? index : 0;

/** The first data value of an event, preferred names first. */
function dataValue(data, preferred) {
  for (const name of preferred) {
    if (data[name] !== undefined) {
      return data[name];
    }
  }
  const values = Object.values(data);
  return values.length > 0 ? values[0] : '';
}

const tail = (topic) => topic.replace(/^.*\//, '');

/**
 * The effects of one event.
 * @param {{ topic: string, source: object, data: object }} event
 * @param {object} context
 * @param {number} context.channels number of video sources (≥ 1)
 * @param {Map<string, object>} [context.ports] ports by id: { direction, doorbell }
 * @param {Map<string, string[]>} [context.scenarioClasses] AOA scenario id → classes
 * @param {Map<string, object>} [context.lights] lights by id: { type }
 */
export function interpret(event, context) {
  const topic = String(event?.topic ?? '');
  const source = event?.source ?? {};
  const data = event?.data ?? {};
  const channels = context?.channels ?? 1;
  const effects = [];

  // --- Camera applications: VMD 4, guard suite, Object Analytics -------------
  let match = topic.match(
    /CameraApplicationPlatform\/(VMD|MotionGuard|FenceGuard|LoiteringGuard)\/Camera(\d+)Profile(\w+)$/,
  );
  if (match) {
    const [, app, camera, profile] = match;
    const channel = clampChannel(Number(camera) - 1, channels);
    const on = isOn(dataValue(data, ['active', 'State']));
    const id = `${app}:${camera}:${profile}`;
    effects.push({ channel, key: KEYS.MOTION, source: id, on });
    const classes = detectedClasses(classTypes(data));
    effects.push(
      { channel, key: KEYS.PERSON, source: id, on: on && classes.person },
      { channel, key: KEYS.VEHICLE, source: id, on: on && classes.vehicle },
    );
    return { effects, rule: profile === 'ANY' ? null : `${app} ${profile}` };
  }
  match = topic.match(/CameraApplicationPlatform\/ObjectAnalytics\/Device(\d+)Scenario(\w+)$/);
  if (match) {
    const [, device, scenario] = match;
    const channel = clampChannel(Number(device) - 1, channels);
    const on = isOn(dataValue(data, ['active']));
    const id = `aoa:${device}:${scenario}`;
    const classes = detectedClasses(
      classTypes(data),
      context?.scenarioClasses?.get(scenario) ?? [],
    );
    effects.push(
      { channel, key: KEYS.OBJECT, source: id, on },
      { channel, key: KEYS.PERSON, source: id, on: on && classes.person },
      { channel, key: KEYS.VEHICLE, source: id, on: on && classes.vehicle },
    );
    return { effects, rule: scenario === 'ANY' ? null : scenario, scenario };
  }

  // --- Other motion detections ---------------------------------------------------
  match = topic.match(/RuleEngine\/(?:tnsaxis:)?VMD3\/vmd3_video_(\d+)$/);
  if (match) {
    const channel = clampChannel(Number(match[1]) - 1, channels);
    const on = isOn(dataValue(data, ['active']));
    effects.push({ channel, key: KEYS.MOTION, source: `vmd3:${source.areaid ?? ''}`, on });
    return { effects };
  }
  if (/VideoAnalytics\/(?:tnsaxis:)?MotionDetection$/.test(topic)) {
    const on = isOn(dataValue(data, ['motion', 'active', 'state']));
    const window = source.window ?? Object.values(source)[0] ?? '';
    effects.push({ channel: 0, key: KEYS.MOTION, source: `md:${window}`, on });
    return { effects };
  }
  if (/RuleEngine\/MotionRegionDetector\/Motion$/.test(topic)) {
    const channel = clampChannel(Number(source.VideoSource ?? 0), channels);
    const on = isOn(dataValue(data, ['State', 'state']));
    const rule = source.RuleName ?? '';
    effects.push({ channel, key: KEYS.MOTION, source: `region:${rule}`, on });
    return { effects, rule: rule || null };
  }

  // --- Device sensors -----------------------------------------------------------
  if (/Device\/(?:tnsaxis:)?Sensor\/PIR$/.test(topic)) {
    const on = isOn(dataValue(data, ['state']));
    effects.push({ channel: 0, key: KEYS.PIR, source: `pir:${source.sensor ?? ''}`, on });
    return { effects };
  }
  if (/AudioSource\/(?:tnsaxis:)?TriggerLevel$/.test(topic)) {
    const on = isOn(dataValue(data, ['triggered']));
    effects.push({ channel: 0, key: KEYS.AUDIO, source: `audio:${source.channel ?? ''}`, on });
    return { effects };
  }
  if (
    /VideoSource\/GlobalSceneChange\/ImagingService$/.test(topic) ||
    /VideoSource\/(?:tnsaxis:)?Tampering$/.test(topic)
  ) {
    const index = Number(source.Source ?? source.channel ?? 0);
    // `Source` is 0-based on the ONVIF topic, `channel` 1-based on the Axis one.
    const channel = clampChannel(source.Source !== undefined ? index : index - 1, channels);
    const on = isOn(dataValue(data, ['State', 'tampering']));
    effects.push({ channel, key: KEYS.TAMPER, source: 'tamper', on });
    return { effects };
  }
  if (/VideoSource\/(?:tnsaxis:)?DayNightVision$/.test(topic)) {
    const token = Number(source.VideoSourceConfigurationToken ?? 1);
    const channel = clampChannel(token - 1, channels);
    if (data.day !== undefined) {
      effects.push({ channel, key: KEYS.NIGHT, source: 'daynight', on: !isOn(data.day) });
    }
    return { effects };
  }

  // --- I/O ports ------------------------------------------------------------------
  if (/Device\/(?:tnsaxis:)?IO\/(?:Port|SupervisedPort)$/.test(topic)) {
    const id = String(source.port ?? '');
    const port = context?.ports?.get(id);
    // `-1` is "any port", outputs have their own topic.
    if (!id || id === '-1' || port?.direction === 'output') {
      return { effects };
    }
    const on = isOn(dataValue(data, ['state', 'active']));
    if (port?.doorbell) {
      if (on) {
        effects.push({ channel: 0, key: KEYS.RING, pulse: true, on: true });
      }
      return { effects };
    }
    effects.push({ channel: 0, key: inputKey(id), source: `port:${id}`, on });
    return { effects };
  }

  // --- Lights ---------------------------------------------------------------------
  if (/Device\/(?:tnsaxis:)?Light\/Status$/.test(topic)) {
    const id = `led${source.id ?? '0'}`;
    const light = context?.lights?.get(id);
    if (light && /^ir$/i.test(light.type)) {
      effects.push({
        channel: 0,
        key: KEYS.IR_LIGHT,
        setting: 'irLight',
        value: String(data.state ?? '').toUpperCase() === 'ON',
      });
    }
    return { effects };
  }

  return { effects, ignored: tail(topic) };
}
