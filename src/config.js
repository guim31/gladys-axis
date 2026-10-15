// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// The devices are typed by address, in two groups that each have their own
// user name and password (a door station often has its own). A password
// lives in a `secret` field only: an address carrying credentials
// (`user:pass@host`) is refused rather than kept in a plain text field.
// (From guim31/gladys-dahua.)
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Minutes between two images of every camera added to Gladys (`0`: only on a
// person, a ring or a scene action). In Gladys 5.2.1 the camera box of the
// dashboard shows the last image the integration published and never asks
// for a new one, so this is how fresh the dashboard is.
export const SNAPSHOT_INTERVALS = ['0', '1', '5', '15', '60'];

// `root` is the first account of an Axis device; a dedicated operator
// account is better (docs).
export const DEFAULT_USERNAME = 'root';

export const DEFAULT_CONFIG = {
  hosts: '',
  username: DEFAULT_USERNAME,
  password: '',
  hosts_2: '',
  username_2: DEFAULT_USERNAME,
  password_2: '',
  snapshot_interval: '5',
  allow_outputs: false,
  language: 'fr',
};

// A host name or an IPv4 address; an IPv6 address goes between brackets.
const HOST_PATTERN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * One address as typed: `192.0.2.10`, `192.0.2.10:8080`, `https://camera.lan`,
 * `[2001:db8::10]:80`.
 * @returns {{ origin: string, label: string } | null} null when unusable
 */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.includes('@')) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  const host = url.hostname;
  const ipv6 = host.startsWith('[') && host.endsWith(']');
  if (!ipv6 && !HOST_PATTERN.test(host)) {
    return null;
  }
  return { origin: url.origin, label: url.port ? `${host}:${url.port}` : host };
}

/**
 * The addresses of a field: separated by commas, semicolons, spaces or new
 * lines, duplicates dropped.
 * @returns {{ hosts: Array<{ origin, label }>, invalid: string[] }}
 */
export function parseHosts(raw) {
  const hosts = [];
  const invalid = [];
  const seen = new Set();
  const text = typeof raw === 'string' ? raw : '';
  for (const entry of text.split(/[\s,;]+/).filter(Boolean)) {
    const host = parseHost(entry);
    if (!host) {
      // Never the entry itself in a message: it may hold a password.
      invalid.push(entry.includes('@') ? '…@…' : entry);
    } else if (!seen.has(host.origin)) {
      seen.add(host.origin);
      hosts.push(host);
    }
  }
  return { hosts, invalid };
}

const pickOption = (value, options, fallback) =>
  options.includes(String(value ?? '')) ? String(value) : fallback;

// A boolean field may arrive as a string from older form engines.
const flag = (value, fallback) =>
  value === undefined || value === null || value === ''
    ? fallback
    : value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  // A password may legitimately start or end with a space: kept as typed.
  const secret = (key) => (typeof source[key] === 'string' ? source[key] : '');
  const devices = [];
  const invalid = [];
  // Addresses typed without a password: never contacted (a request with an
  // empty password is a refused one, counted by the brute-force protection).
  const noPassword = [];
  const seen = new Set();
  for (const [group, suffix] of [
    [1, ''],
    [2, '_2'],
  ]) {
    const parsed = parseHosts(source[`hosts${suffix}`]);
    invalid.push(...parsed.invalid);
    for (const host of parsed.hosts) {
      if (seen.has(host.origin)) {
        continue; // the first group wins
      }
      seen.add(host.origin);
      if (!secret(`password${suffix}`)) {
        noPassword.push(host.label);
        continue;
      }
      devices.push({
        ...host,
        group,
        username: text(`username${suffix}`) || DEFAULT_USERNAME,
        password: secret(`password${suffix}`),
      });
    }
  }
  const language = text('language');
  return {
    devices,
    invalidHosts: invalid,
    noPassword,
    snapshotIntervalMs:
      Number(
        pickOption(source.snapshot_interval, SNAPSHOT_INTERVALS, DEFAULT_CONFIG.snapshot_interval),
      ) * 60_000,
    allowOutputs: flag(source.allow_outputs, DEFAULT_CONFIG.allow_outputs),
    language: LANGUAGES.includes(language) ? language : DEFAULT_CONFIG.language,
  };
}
