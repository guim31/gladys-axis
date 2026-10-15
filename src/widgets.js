// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `axis`.
//
// The use case: a glance at the wall tablet — "who came by, are the cameras
// up?". So the widget shows:
//   - two tiles: devices online (3/4) and persons and rings over 24 hours;
//   - the last persons and rings, newest first, each with the image taken
//     when it happened (card-list, list display, its date under the title);
//   - the state of the devices (online or not).
// Every device by default, or the one chosen in the widget settings.
//
// Budget (8 components, ≤ 2 texts, one focal component, one status): two
// tiles, one card-list, one status, one caption. The detections are kept in
// memory: the list starts empty after a restart. Images: keys
// `det-<id>`, immutable, served by onWidgetGetImage from the hub.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { channelName } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, pick } from './texts.js';

export const TEXT = {
  configure: {
    en: 'Enter the address and password of your Axis devices in the configuration of the integration.',
    fr: "Saisissez l'adresse et le mot de passe de vos appareils Axis dans la configuration de l'intégration.",
    de: 'Gib Adresse und Passwort deiner Axis-Geräte in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección y la contraseña de sus dispositivos Axis en la configuración de la integración.',
  },
  unknown: {
    en: 'This device is no longer configured: choose another one in the widget settings.',
    fr: "Cet appareil n'est plus configuré : choisissez-en un autre dans les réglages du widget.",
    de: 'Dieses Gerät ist nicht mehr konfiguriert: Wähle ein anderes in den Widget-Einstellungen.',
    es: 'Este dispositivo ya no está configurado: elija otro en la configuración del widget.',
  },
  noDetection: {
    en: 'No person and no ring since the integration started.',
    fr: "Ni personne ni sonnerie depuis le démarrage de l'intégration.",
    de: 'Keine Person und kein Klingeln seit dem Start der Integration.',
    es: 'Ninguna persona ni timbre desde el inicio de la integración.',
  },
  online: {
    en: 'Devices online',
    fr: 'Appareils en ligne',
    de: 'Geräte online',
    es: 'Equipos en línea',
  },
  detections: {
    en: 'Events 24 h',
    fr: 'Événements 24 h',
    de: 'Ereignisse 24 h',
    es: 'Eventos 24 h',
  },
  isOnline: { en: 'Online', fr: 'En ligne', de: 'Online', es: 'En línea' },
  isOffline: { en: 'Offline', fr: 'Hors ligne', de: 'Offline', es: 'Sin conexión' },
  ring: { en: 'Doorbell', fr: 'Sonnette', de: 'Türklingel', es: 'Timbre' },
  person: { en: 'Person', fr: 'Personne', de: 'Person', es: 'Persona' },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** "Person · Front door" — what happened, and where. */
export function detectionTitle(detection, cameraName, language) {
  const what = t(detection.kind === 'ring' ? TEXT.ring : TEXT.person, language);
  return fit(`${what} · ${cameraName}`, 60);
}

async function get(hub, { settings, language = 'en' }) {
  const view = hub.view();
  if (!view.configured) {
    return message(TEXT.configure, language);
  }
  let shown = view.channels;
  if (settings?.device) {
    const channel = view.channels.find((entry) => entry.externalId === settings.device);
    if (!channel) {
      return message(TEXT.unknown, language);
    }
    shown = [channel];
  }
  const components = [];
  if (view.failed.length > 0) {
    const error = view.failed[0];
    components.push({
      type: 'text',
      variant: 'caption',
      text: fit(t(ERROR_TEXT[error?.kind] ?? ERROR_TEXT.http, language), 80),
    });
  }

  const onlineCount = shown.filter((channel) => channel.online).length;
  const key = settings?.device ? shown[0].key : null;
  components.push(
    {
      type: 'value',
      value: `${onlineCount}/${shown.length}`,
      label: t(TEXT.online, language),
      icon: 'video',
      color: onlineCount === shown.length ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
    },
    {
      type: 'value',
      value: view.detectionsToday(key),
      label: t(TEXT.detections, language),
      icon: 'eye',
    },
  );

  const byKey = new Map(view.channels.map((channel) => [channel.key, channel]));
  const detections = view.detections
    .filter((detection) => !key || detection.key === key)
    .filter((detection) => byKey.has(detection.key));
  if (detections.length > 0) {
    components.push({
      type: 'card-list',
      display: 'list',
      items: detections.slice(0, 8).map((detection) => ({
        title: detectionTitle(detection, channelName(byKey.get(detection.key), language), language),
        date: new Date(detection.at).toISOString(),
        ...(detection.imageKey ? { image: detection.imageKey } : {}),
      })),
    });
  } else if (view.failed.length === 0) {
    components.push({ type: 'text', variant: 'caption', text: t(TEXT.noDetection, language) });
  }

  const items = shown.slice(0, 10).map((channel) => ({
    label: fit(channelName(channel, language), 40),
    icon: channel.hasVideo ? (channel.online ? 'video' : 'video-off') : 'speaker',
    value: t(channel.online ? TEXT.isOnline : TEXT.isOffline, language),
    color: channel.online ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
  }));
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  // Persons and rings nudge the widget (requestWidgetRefresh); the TTL is a net.
  return { ttl_seconds: 120, components };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get },
};
