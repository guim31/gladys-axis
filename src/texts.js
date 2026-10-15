// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the reports of the Configuration actions, scene
// action errors. Four languages, the four of the Gladys interface; German
// says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './axis/client.js';
import { LANGUAGES } from './config.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noHost: {
    en: 'Enter the address of your Axis cameras, door stations or speakers in the configuration.',
    fr: "Saisissez l'adresse de vos caméras, portiers ou haut-parleurs Axis dans la configuration.",
    de: 'Gib die Adresse deiner Axis-Kameras, Türsprechanlagen oder Lautsprecher in der Konfiguration ein.',
    es: 'Introduzca la dirección de sus cámaras, porteros o altavoces Axis en la configuración.',
  },
  invalidHost: {
    en: 'Address not understood, e.g. 192.168.1.90 (no password in the address).',
    fr: "Adresse incomprise, ex. 192.168.1.90 (pas de mot de passe dans l'adresse).",
    de: 'Adresse nicht verstanden, z. B. 192.168.1.90 (kein Passwort in der Adresse).',
    es: 'Dirección no válida, p. ej. 192.168.1.90 (sin contraseña en la dirección).',
  },
  noPassword: {
    en: 'Enter the password of your Axis devices in the configuration.',
    fr: 'Saisissez le mot de passe de vos appareils Axis dans la configuration.',
    de: 'Gib das Passwort deiner Axis-Geräte in der Konfiguration ein.',
    es: 'Introduzca la contraseña de sus dispositivos Axis en la configuración.',
  },
  someDown: {
    en: 'Connected, but some devices do not answer: see the integration logs.',
    fr: "Connectée, mais certains appareils ne répondent pas : voir les logs de l'intégration.",
    de: 'Verbunden, aber einige Geräte antworten nicht: Sieh dir die Protokolle der Integration an.',
    es: 'Conectada, pero algunos dispositivos no responden: consulte los registros de la integración.',
  },
  live: {
    en: 'Connected, but live events are interrupted: inputs and light are read every minute.',
    fr: 'Connectée, mais les événements en direct sont coupés : entrées et éclairage relus chaque minute.',
    de: 'Verbunden, aber die Live-Ereignisse sind unterbrochen: Eingänge und Licht jede Minute gelesen.',
    es: 'Conectada, pero los eventos en directo están cortados: entradas y luz leídas cada minuto.',
  },
};

// One explanation per error kind (src/axis/client.js), shown in the
// connection status and in the reports.
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'The device does not answer: check its address and that Gladys can reach it.',
    fr: "L'appareil ne répond pas : vérifiez son adresse et que Gladys peut l'atteindre.",
    de: 'Das Gerät antwortet nicht: Prüfe seine Adresse und ob Gladys es erreicht.',
    es: 'El dispositivo no responde: compruebe su dirección y que Gladys pueda alcanzarlo.',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'User name or password refused: check them in the configuration.',
    fr: "Nom d'utilisateur ou mot de passe refusé : vérifiez-les dans la configuration.",
    de: 'Benutzername oder Passwort abgelehnt: Prüfe sie in der Konfiguration.',
    es: 'Nombre de usuario o contraseña rechazados: compruébelos en la configuración.',
  },
  [ERROR_KINDS.BLOCKED]: {
    en: 'Password refused: stopped so the device does not block Gladys. Fix it, then test the connection.',
    fr: "Mot de passe refusé : arrêt pour que l'appareil ne bloque pas Gladys. Corrigez-le, puis testez la connexion.",
    de: 'Passwort abgelehnt: angehalten, damit das Gerät Gladys nicht sperrt. Korrigiere es und teste die Verbindung.',
    es: 'Contraseña rechazada: detenido para que el dispositivo no bloquee a Gladys. Corríjala y pruebe la conexión.',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'This account is not allowed to do this: use an operator or administrator account.',
    fr: "Ce compte n'a pas ce droit : utilisez un compte opérateur ou administrateur.",
    de: 'Dieses Konto darf das nicht: Verwende ein Operator- oder Administratorkonto.',
    es: 'Esta cuenta no tiene ese permiso: utilice una cuenta de operador o de administrador.',
  },
  [ERROR_KINDS.NO_API]: {
    en: 'No Axis device (VAPIX) at this address: check the address and the port.',
    fr: "Pas d'appareil Axis (VAPIX) à cette adresse : vérifiez l'adresse et le port.",
    de: 'Kein Axis-Gerät (VAPIX) unter dieser Adresse: Prüfe Adresse und Port.',
    es: 'No hay ningún dispositivo Axis (VAPIX) en esta dirección: compruebe la dirección y el puerto.',
  },
  [ERROR_KINDS.REFUSED]: {
    en: 'The device refused the command: it may not support it.',
    fr: "L'appareil a refusé la commande : il ne la prend peut-être pas en charge.",
    de: 'Das Gerät hat den Befehl abgelehnt: Es unterstützt ihn vielleicht nicht.',
    es: 'El dispositivo rechazó la orden: puede que no la admita.',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'The device refused the request: see the integration logs.',
    fr: "L'appareil a refusé la requête : voir les logs de l'intégration.",
    de: 'Das Gerät hat die Anfrage abgelehnt: Sieh dir die Protokolle der Integration an.',
    es: 'El dispositivo rechazó la solicitud: consulte los registros de la integración.',
  },
};

// The event transport, in the reports.
export const TRANSPORT_TEXT = {
  en: {
    websocket: 'live events by WebSocket',
    rtsp: 'live events by RTSP',
    none: 'no live events yet',
  },
  fr: {
    websocket: 'événements par WebSocket',
    rtsp: 'événements par RTSP',
    none: "pas encore d'événements",
  },
  de: {
    websocket: 'Ereignisse per WebSocket',
    rtsp: 'Ereignisse per RTSP',
    none: 'noch keine Ereignisse',
  },
  es: {
    websocket: 'eventos por WebSocket',
    rtsp: 'eventos por RTSP',
    none: 'aún sin eventos',
  },
};

// Report of the "Test the connection" action, one line per device.
export const REPORT_TEXT = {
  en: {
    ok: (host, model, sources, transport) =>
      `${host}: ${model}, ${sources} video source(s), ${transport}.`,
    failed: (host, reason) => `${host}: ${reason}`,
  },
  fr: {
    ok: (host, model, sources, transport) =>
      `${host} : ${model}, ${sources} source(s) vidéo, ${transport}.`,
    failed: (host, reason) => `${host} : ${reason}`,
  },
  de: {
    ok: (host, model, sources, transport) =>
      `${host}: ${model}, ${sources} Videoquelle(n), ${transport}.`,
    failed: (host, reason) => `${host}: ${reason}`,
  },
  es: {
    ok: (host, model, sources, transport) =>
      `${host}: ${model}, ${sources} fuente(s) de vídeo, ${transport}.`,
    failed: (host, reason) => `${host}: ${reason}`,
  },
};

// Report of the "Audio clips" action.
export const CLIPS_TEXT = {
  en: {
    list: (device, clips) => `${device}: ${clips}.`,
    none: (device) => `${device}: no audio clip.`,
  },
  fr: {
    list: (device, clips) => `${device} : ${clips}.`,
    none: (device) => `${device} : aucun clip audio.`,
  },
  de: {
    list: (device, clips) => `${device}: ${clips}.`,
    none: (device) => `${device}: kein Audioclip.`,
  },
  es: {
    list: (device, clips) => `${device}: ${clips}.`,
    none: (device) => `${device}: ningún clip de audio.`,
  },
};

// Report of the "Search the network" action.
export const SEARCH_TEXT = {
  en: {
    found: (name, address) =>
      `${name} at ${address}: to add, copy its address in the configuration.`,
    configured: (name, address) => `${name} at ${address}: configured.`,
    moved: (name, address) =>
      `${name} now answers at ${address}: update its address in the configuration.`,
    none: () => 'No Axis device answered on the network (Bonjour and UPnP must be on).',
    unavailable: () => 'Network search unavailable: this Gladys does not relay it.',
  },
  fr: {
    found: (name, address) =>
      `${name} à ${address} : pour l'ajouter, copiez son adresse dans la configuration.`,
    configured: (name, address) => `${name} à ${address} : configuré.`,
    moved: (name, address) =>
      `${name} répond désormais à ${address} : mettez à jour son adresse dans la configuration.`,
    none: () =>
      "Aucun appareil Axis n'a répondu sur le réseau (Bonjour et UPnP doivent être actifs).",
    unavailable: () => 'Recherche réseau indisponible : ce Gladys ne la relaie pas.',
  },
  de: {
    found: (name, address) =>
      `${name} unter ${address}: Zum Hinzufügen kopiere die Adresse in die Konfiguration.`,
    configured: (name, address) => `${name} unter ${address}: konfiguriert.`,
    moved: (name, address) =>
      `${name} antwortet jetzt unter ${address}: Aktualisiere die Adresse in der Konfiguration.`,
    none: () => 'Kein Axis-Gerät hat im Netzwerk geantwortet (Bonjour und UPnP müssen an sein).',
    unavailable: () => 'Netzwerksuche nicht verfügbar: Dieses Gladys leitet sie nicht weiter.',
  },
  es: {
    found: (name, address) =>
      `${name} en ${address}: para añadirlo, copie su dirección en la configuración.`,
    configured: (name, address) => `${name} en ${address}: configurado.`,
    moved: (name, address) =>
      `${name} responde ahora en ${address}: actualice su dirección en la configuración.`,
    none: () => 'Ningún dispositivo Axis respondió en la red (Bonjour y UPnP deben estar activos).',
    unavailable: () => 'Búsqueda en la red no disponible: este Gladys no la retransmite.',
  },
};

// Messages of the Configuration actions and errors of the scene actions.
export const ACTION_TEXT = {
  notConfigured: {
    en: 'Configure the address, user name and password of a device first.',
    fr: "Configurez d'abord l'adresse, le nom d'utilisateur et le mot de passe d'un appareil.",
    de: 'Konfiguriere zuerst Adresse, Benutzername und Passwort eines Geräts.',
    es: 'Configure primero la dirección, el nombre de usuario y la contraseña de un dispositivo.',
  },
  pickDevice: {
    en: 'Choose an Axis device added to Gladys.',
    fr: 'Choisissez un appareil Axis ajouté à Gladys.',
    de: 'Wähle ein Axis-Gerät, das zu Gladys hinzugefügt wurde.',
    es: 'Elija un dispositivo Axis añadido a Gladys.',
  },
  unknownDevice: {
    en: 'This device is not (or no longer) one of the configured Axis devices.',
    fr: "Cet appareil n'est pas (ou plus) un des appareils Axis configurés.",
    de: 'Dieses Gerät gehört nicht (mehr) zu den konfigurierten Axis-Geräten.',
    es: 'Este dispositivo no es (o ya no es) uno de los dispositivos Axis configurados.',
  },
  noVideo: {
    en: 'This device has no camera.',
    fr: "Cet appareil n'a pas de caméra.",
    de: 'Dieses Gerät hat keine Kamera.',
    es: 'Este dispositivo no tiene cámara.',
  },
  snapshotFailed: {
    en: 'The device did not send an image of this camera.',
    fr: "L'appareil n'a pas envoyé d'image de cette caméra.",
    de: 'Das Gerät hat kein Bild dieser Kamera gesendet.',
    es: 'El dispositivo no envió ninguna imagen de esta cámara.',
  },
  outputsDisabled: {
    en: 'The outputs are disabled: allow them in the configuration of the integration first.',
    fr: "Les sorties sont désactivées : autorisez-les d'abord dans la configuration de l'intégration.",
    de: 'Die Ausgänge sind deaktiviert: Erlaube sie zuerst in der Konfiguration der Integration.',
    es: 'Las salidas están desactivadas: autorícelas primero en la configuración de la integración.',
  },
  noOutput: {
    en: 'This device has no output with this number.',
    fr: "Cet appareil n'a pas de sortie de ce numéro.",
    de: 'Dieses Gerät hat keinen Ausgang mit dieser Nummer.',
    es: 'Este dispositivo no tiene ninguna salida con este número.',
  },
  noClip: {
    en: 'This device has no audio clip of this name or number: see the "Audio clips" action.',
    fr: "Cet appareil n'a pas de clip audio de ce nom ou numéro : voir l'action « Clips audio ».",
    de: 'Dieses Gerät hat keinen Audioclip mit diesem Namen oder dieser Nummer: Siehe Aktion „Audioclips“.',
    es: 'Este dispositivo no tiene ningún clip de audio con ese nombre o número: vea la acción «Clips de audio».',
  },
  stream: {
    en: 'For the "RTSP camera" integration of Gladys (replace PASSWORD):',
    fr: "Pour l'intégration « Caméra RTSP » de Gladys (remplacez PASSWORD) :",
    de: 'Für die Integration „RTSP-Kamera“ von Gladys (ersetze PASSWORD):',
    es: 'Para la integración «Cámara RTSP» de Gladys (sustituya PASSWORD):',
  },
};

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** A multi-language object built by a function of the language. */
export const localized = (render) =>
  Object.fromEntries(LANGUAGES.map((language) => [language, render(language)]));
