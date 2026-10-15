// -----------------------------------------------------------------------------
// HTTP Digest authentication (RFC 2617 / 7616, qop "auth"), the scheme of
// VAPIX (HTTP) and of RTSP: the device answers 401 with a challenge, the request is sent
// again with a response computed from the user name, the password and the
// challenge. The password itself never travels.
//
// MD5 is what Axis firmwares offer by default; SHA-256 is handled too, for the
// ones that announce it. (From guim31/gladys-dahua and guim31/gladys-fritzbox.)
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

const hashOf = (algorithm) => (/^SHA-256/i.test(algorithm) ? 'sha256' : 'md5');
const digest = (name, text) => createHash(name).update(text, 'utf8').digest('hex');

/**
 * The challenges of `WWW-Authenticate` headers, keys lower-cased: the Digest
 * ones (SHA-256 first, the stronger one) and whether Basic is offered.
 * @param {string|string[]|undefined} headers one header or several
 * @returns {{ digest: object|null, basic: boolean }}
 */
export function parseChallenges(headers) {
  const list = (Array.isArray(headers) ? headers : [headers]).filter(Boolean).map(String);
  const digests = [];
  let basic = false;
  for (const header of list) {
    const text = header.trim();
    if (/^Basic\b/i.test(text)) {
      basic = true;
      continue;
    }
    const challenge = parseChallenge(text);
    if (challenge) {
      digests.push(challenge);
    }
  }
  digests.sort(
    (a, b) =>
      Number(/^SHA-256/i.test(b.algorithm ?? '')) - Number(/^SHA-256/i.test(a.algorithm ?? '')),
  );
  return { digest: digests[0] ?? null, basic };
}

/**
 * The parameters of a `WWW-Authenticate: Digest …` header, keys lower-cased,
 * or null when it is not a Digest challenge.
 */
export function parseChallenge(header) {
  const text = String(header ?? '').trim();
  const match = text.match(/^Digest\s+(.*)$/is);
  if (!match) {
    return null;
  }
  const params = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
  for (const [, key, quoted, bare] of match[1].matchAll(pattern)) {
    params[key.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare;
  }
  return params.nonce && params.realm !== undefined ? params : null;
}

/**
 * The `Authorization` header answering a challenge.
 * @param {object} options
 * @param {object} options.challenge from parseChallenge
 * @param {string} options.username
 * @param {string} options.password
 * @param {string} options.method HTTP method
 * @param {string} options.uri request path (with its query string)
 * @param {number} options.nc request counter for this nonce (1, 2…)
 * @param {string} [options.cnonce] client nonce (random by default)
 */
export function authorization({
  challenge,
  username,
  password,
  method,
  uri,
  nc,
  cnonce = randomBytes(8).toString('hex'),
}) {
  const algorithm = challenge.algorithm ?? 'MD5';
  const name = hashOf(algorithm);
  let ha1 = digest(name, `${username}:${challenge.realm}:${password}`);
  if (/-sess$/i.test(algorithm)) {
    ha1 = digest(name, `${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = digest(name, `${method}:${uri}`);
  const qops = String(challenge.qop ?? '')
    .split(',')
    .map((qop) => qop.trim());
  const count = nc.toString(16).padStart(8, '0');
  const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
  ];
  if (qops.includes('auth')) {
    const response = digest(name, `${ha1}:${challenge.nonce}:${count}:${cnonce}:auth:${ha2}`);
    parts.push(`response=${quote(response)}`, 'qop=auth', `nc=${count}`, `cnonce=${quote(cnonce)}`);
  } else {
    // RFC 2069 compatibility: no qop offered.
    parts.push(`response=${quote(digest(name, `${ha1}:${challenge.nonce}:${ha2}`))}`);
  }
  if (challenge.algorithm) {
    parts.push(`algorithm=${challenge.algorithm}`);
  }
  if (challenge.opaque !== undefined) {
    parts.push(`opaque=${quote(challenge.opaque)}`);
  }
  return `Digest ${parts.join(', ')}`;
}

/** The `Authorization` header of Basic authentication (only when the device offers nothing else). */
export const basicAuthorization = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
