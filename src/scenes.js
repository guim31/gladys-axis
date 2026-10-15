// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
//   - refresh_snapshot: a fresh image of a camera, sent to Gladys, so the next
//     action ("send the camera image" in a message) sends what it sees now;
//   - play_audio_clip: play a clip stored on an Axis device with a speaker
//     (network speaker, door station, camera): a chime, a recorded warning;
//   - set_output: drive an output (relay) of an Axis device. On a door
//     station an output opens the door or the gate: disabled by default, it
//     only works once allowed in the configuration, it is never a switch of
//     a device (no voice assistant, no dashboard toggle can open a door by
//     mistake), and the command is sent once, never retried.
// Gladys applies the field defaults to scene actions; a failure throws, the
// scene logs it and carries on.
// -----------------------------------------------------------------------------

import { OUTPUT_ACTIONS } from './hub.js';

// The outputs offered, by number among the outputs of the device.
export const OUTPUTS = Object.freeze(['1', '2', '3', '4']);
export const DEFAULT_OUTPUT = '1';
export const OUTPUT_MODES = Object.freeze(Object.keys(OUTPUT_ACTIONS));
export const DEFAULT_OUTPUT_MODE = 'pulse_1';

export const SCENE_ACTIONS = {
  async refresh_snapshot(hub, { fields = {} }) {
    await hub.refreshSnapshot(fields.camera);
  },

  async play_audio_clip(hub, { fields = {} }) {
    return hub.playClip(fields.device, fields.clip);
  },

  async set_output(hub, { fields = {} }) {
    const output = OUTPUTS.includes(String(fields.output)) ? Number(fields.output) : 1;
    const mode = OUTPUT_MODES.includes(fields.mode) ? fields.mode : DEFAULT_OUTPUT_MODE;
    return hub.setOutput(fields.device, output, mode);
  },
};
