// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the hub, so index.js stays a few lines and the tests drive the
// very same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { AxisHub, WIDGET_KEY } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { INIT_FAILED } from './texts.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'axis-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, transport, timers, timings,
 *   streamTimings, clientTimings, now
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new AxisHub({
    gladys,
    store: options.store ?? new Store(),
    transport: options.transport,
    timers: options.timers ?? true,
    timings: options.timings,
    streamTimings: options.streamTimings,
    clientTimings: options.clientTimings,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first read is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): send again what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  gladys.onGetImage(whenReady((device) => hub.getImage(device)));

  // The devices are published with should_poll: false (the hub follows the
  // event streams and reads the devices on its own timer, Gladys#3198); this
  // only serves a Gladys that would poll anyway.
  gladys.onPoll(
    whenReady(async () => {
      await hub.refresh();
    }),
  );

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));

  // A device renamed in Gladys: the widget shows the names of Gladys.
  gladys.onDeviceUpdated(whenReady(async () => hub.gladys.requestWidgetRefresh(WIDGET_KEY)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'test_connection',
    whenReady(() => hub.testConnection()),
  );

  gladys.onAction(
    'stream_url',
    whenReady((fields = {}) => hub.streamUrl(fields.camera)),
  );

  gladys.onAction(
    'audio_clips',
    whenReady(() => hub.audioClips()),
  );

  gladys.onAction(
    'search_network',
    whenReady(() => hub.searchNetwork()),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
  }

  gladys.onWidgetGetImage(whenReady((imageKey) => hub.thumbnail(imageKey)));

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
