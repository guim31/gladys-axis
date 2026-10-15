// -----------------------------------------------------------------------------
// The VAPIX client of ONE Axis device: authentication, a small queue, and the
// requests the integration needs. VAPIX mixes three styles, all under
// /axis-cgi/ or /local/:
//   - legacy CGIs answering text: param.cgi (`root.X.Y=value` lines),
//     port.cgi, mediaclip.cgi, wssession.cgi, jpg/image.cgi (a JPEG);
//   - JSON APIs over POST (`{ apiVersion, context, method, params }` →
//     `{ data }` or `{ error: { code, message } }`): apidiscovery,
//     basicdeviceinfo, portmanagement, lightcontrol, and the control.cgi of
//     the camera applications (AXIS Object Analytics, AXIS Video Motion
//     Detection);
//   - XML: applications/list.cgi.
//
// Authentication: HTTP Digest (Basic only when the device offers nothing
// else). Recent AXIS OS versions delay or block an address after repeated
// failed logins ("brute-force delay protection"), so a refused password is
// never retried on its own: one 401 on a challenge the device just gave stops
// every request to the device (`blocked`) until the configuration changes or
// the user tests the connection. The same credentials, and the same stop,
// serve the RTSP event stream (src/axis/rtsp.js).
// The password never appears in a log, an error or a URL.
// -----------------------------------------------------------------------------

import { authorization, basicAuthorization, parseChallenges } from './digest.js';
import { parseApplications, parseParams } from './parse.js';
import { defaultTransport } from './transport.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable',
  AUTH: 'auth',
  BLOCKED: 'blocked',
  FORBIDDEN: 'forbidden',
  NO_API: 'no_api',
  REFUSED: 'refused',
  HTTP: 'http',
});

export class AxisError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'AxisError';
    this.kind = kind;
    this.status = status;
  }
}

export const CLIENT_TIMINGS = {
  requestTimeoutMs: 15_000,
  queueTimeoutMs: 60_000,
};

// The web server of a camera is shared with its own web interface and
// recording clients: a few requests at a time is plenty.
const MAX_IN_FLIGHT = 3;

// Identifies the integration in the request bodies of the JSON APIs.
export const CONTEXT = 'gladys';

/** The credentials of a device, and whether they were refused. */
export class Credentials {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.blocked = false;
  }

  /** Talk to the device again after a refused password (user action). */
  unblock() {
    this.blocked = false;
  }

  check() {
    if (this.blocked) {
      throw new AxisError(
        ERROR_KINDS.BLOCKED,
        'Stopped after refused credentials: change them or test the connection',
      );
    }
  }

  refuse() {
    this.blocked = true;
    return new AxisError(ERROR_KINDS.AUTH, 'User name or password refused', 401);
  }
}

/**
 * The authentication state of one protocol (HTTP or RTSP) towards a device:
 * its last challenge and nonce counter. Both protocols share the
 * Credentials, hence the stop after a refusal.
 */
export class AuthSession {
  constructor(credentials) {
    this.credentials = credentials;
    this.challenge = null;
    this.nc = 0;
    this.basic = false;
  }

  /**
   * Send a request until it is answered with something else than 401.
   * Signed with a challenge the device just gave in this very call, a 401 is
   * the password; signed with a cached one, the device may simply have moved
   * to a new nonce: one more try with the fresh one.
   * @param {string} method
   * @param {string} uri what the digest signs: the path (HTTP) or the URL (RTSP)
   * @param {(headers: object) => Promise<{ status: number, headers: object, close?: Function }>} send
   */
  async exchange(method, uri, send) {
    let fresh = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.credentials.check();
      const headers = {};
      const { username, password } = this.credentials;
      if (this.basic) {
        headers.Authorization = basicAuthorization(username, password);
      } else if (this.challenge) {
        this.nc += 1;
        headers.Authorization = authorization({
          challenge: this.challenge,
          username,
          password,
          method,
          uri,
          nc: this.nc,
        });
      }
      const response = await send(headers);
      if (response.status !== 401) {
        return response;
      }
      response.close?.();
      if (headers.Authorization && (fresh || this.basic)) {
        this.challenge = null;
        throw this.credentials.refuse();
      }
      const { digest, basic } = parseChallenges(response.headers?.['www-authenticate']);
      if (digest) {
        this.challenge = digest;
        this.nc = 0;
        this.basic = false;
      } else if (basic && !this.basic) {
        this.basic = true;
      } else {
        // A challenge we cannot answer: not a wrong password, never counted.
        throw new AxisError(ERROR_KINDS.HTTP, 'The device asks for an unknown authentication', 401);
      }
      fresh = true;
    }
    this.challenge = null;
    throw this.credentials.refuse();
  }
}

/** The error of a non-2xx answer. */
export function httpError(status) {
  if (status === 401) {
    return new AxisError(ERROR_KINDS.AUTH, 'User name or password refused', 401);
  }
  if (status === 403) {
    return new AxisError(
      ERROR_KINDS.FORBIDDEN,
      'The account is not allowed to do this (an operator or administrator account is needed)',
      403,
    );
  }
  if (status === 404 || status === 501) {
    return new AxisError(ERROR_KINDS.NO_API, `No such API on this device (HTTP ${status})`, status);
  }
  return new AxisError(ERROR_KINDS.HTTP, `The device answered HTTP ${status}`, status);
}

function describeNetworkError(err) {
  const code = err?.code ? ` (${err.code})` : '';
  return `No answer from the device${code}`;
}

export class AxisClient {
  /**
   * @param {object} options
   * @param {string} options.origin `http://192.0.2.10` or `https://…:port`
   * @param {string} options.username
   * @param {string} options.password
   * @param {object} [options.transport] network seams (src/axis/transport.js)
   * @param {object} [options.timings] CLIENT_TIMINGS overrides
   */
  constructor({ origin, username, password, transport, timings }) {
    this.origin = origin;
    this.credentials = new Credentials(username, password);
    this.http = new AuthSession(this.credentials);
    this.transport = { ...defaultTransport, ...transport };
    this.timings = { ...CLIENT_TIMINGS, ...timings };
    this.inFlight = 0;
    this.waiting = [];
    /** API ids → versions, from apidiscovery (empty on old firmwares). */
    this.apis = new Map();
  }

  get username() {
    return this.credentials.username;
  }

  get blocked() {
    return this.credentials.blocked;
  }

  unblock() {
    this.credentials.unblock();
  }

  // --- Queue ---------------------------------------------------------------------

  async slot() {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(new AxisError(ERROR_KINDS.UNREACHABLE, 'The device is busy'));
      }, this.timings.queueTimeoutMs);
      timer.unref?.();
      entry.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiting.push(entry);
    });
    this.inFlight += 1;
  }

  release() {
    this.inFlight -= 1;
    this.waiting.shift()?.resolve();
  }

  // --- Requests ------------------------------------------------------------------

  /**
   * One authenticated request.
   * @param {string} method
   * @param {string} path `/axis-cgi/…?…`, already encoded
   * @param {object} [options] { body, contentType, timeoutMs }
   * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
   */
  async call(method, path, { body, contentType, timeoutMs } = {}) {
    this.credentials.check();
    await this.slot();
    try {
      return await this.http.exchange(method, path, async (auth) => {
        try {
          return await this.transport.request(`${this.origin}${path}`, {
            method,
            headers: { ...(contentType ? { 'Content-Type': contentType } : {}), ...auth },
            body,
            timeoutMs: timeoutMs ?? this.timings.requestTimeoutMs,
          });
        } catch (err) {
          throw new AxisError(ERROR_KINDS.UNREACHABLE, describeNetworkError(err));
        }
      });
    } finally {
      this.release();
    }
  }

  /** A GET whose answer must be a 2xx: the body as text. */
  async text(path, options) {
    const response = await this.call('GET', path, options);
    if (response.status >= 200 && response.status < 300) {
      return response.body?.toString('utf8') ?? '';
    }
    throw httpError(response.status);
  }

  /**
   * One call of a JSON API.
   * @returns {Promise<object>} its `data`
   */
  async api(path, method, { params, apiVersion = '1.0' } = {}) {
    const body = JSON.stringify({
      apiVersion,
      context: CONTEXT,
      method,
      ...(params ? { params } : {}),
    });
    const response = await this.call('POST', path, { body, contentType: 'application/json' });
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status);
    }
    let json;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new AxisError(ERROR_KINDS.HTTP, `Unreadable answer of ${method}`);
    }
    if (json?.error) {
      const code = json.error.code ?? '?';
      throw new AxisError(ERROR_KINDS.REFUSED, `${method} refused (error ${code})`);
    }
    return json?.data ?? {};
  }

  /** The version of a listed API, or null when the device does not list it. */
  apiVersion(id) {
    return this.apis.get(id) ?? null;
  }

  // --- Reads ---------------------------------------------------------------------

  /**
   * The APIs the device lists (AXIS OS 7.x and later). An old firmware
   * without API discovery answers 404: an empty list, the legacy CGIs serve.
   */
  async discoverApis() {
    try {
      const data = await this.api('/axis-cgi/apidiscovery.cgi', 'getApiList');
      this.apis = new Map(
        (Array.isArray(data.apiList) ? data.apiList : [])
          .filter((api) => api && typeof api.id === 'string')
          .map((api) => [api.id, String(api.version ?? '1.0')]),
      );
    } catch (err) {
      if (err.kind !== ERROR_KINDS.NO_API && err.kind !== ERROR_KINDS.REFUSED) {
        throw err;
      }
      this.apis = new Map();
    }
    return this.apis;
  }

  /**
   * One group of parameters, keys without `root.`. A group the device does
   * not have answers an error line: `{}`.
   */
  async params(group) {
    try {
      return parseParams(
        await this.text(`/axis-cgi/param.cgi?action=list&group=${encodeURIComponent(group)}`),
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.NO_API || (err.kind === ERROR_KINDS.HTTP && err.status >= 400)) {
        return {};
      }
      throw err;
    }
  }

  /** Identity: serial, model, name, product type, firmware. */
  async identity() {
    if (this.apiVersion('basic-device-info')) {
      try {
        const data = await this.api('/axis-cgi/basicdeviceinfo.cgi', 'getAllProperties', {
          apiVersion: this.apiVersion('basic-device-info'),
        });
        const list = data.propertyList ?? {};
        if (list.SerialNumber) {
          return {
            serial: list.SerialNumber,
            model: list.ProdNbr || null,
            name: list.ProdFullName || list.ProdShortName || null,
            productType: list.ProdType || null,
            firmware: list.Version || null,
          };
        }
      } catch (err) {
        if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
          throw err;
        }
      }
    }
    const brand = await this.params('root.Brand');
    const properties = await this.params('root.Properties.System');
    const firmware = await this.params('root.Properties.Firmware');
    return {
      serial: properties['Properties.System.SerialNumber'] || null,
      model: brand['Brand.ProdNbr'] || null,
      name: brand['Brand.ProdFullName'] || brand['Brand.ProdShortName'] || null,
      productType: brand['Brand.ProdType'] || null,
      firmware: firmware['Properties.Firmware.Version'] || null,
    };
  }

  /**
   * The I/O ports: `{ id, direction, name, state, normalState, configurable }`,
   * `id` as the port management API and the events number them ("0", "1"…).
   * Through the port management API when listed, param.cgi otherwise.
   */
  async ports() {
    if (this.apiVersion('io-port-management')) {
      const data = await this.api('/axis-cgi/io/portmanagement.cgi', 'getPorts', {
        apiVersion: '1.0',
      });
      return (Array.isArray(data.items) ? data.items : []).map((item) => ({
        id: String(item.port),
        direction: item.direction === 'output' ? 'output' : 'input',
        name: typeof item.name === 'string' ? item.name.trim() : '',
        state: item.state ?? null,
        normalState: item.normalState ?? null,
        configurable: Boolean(item.configurable),
      }));
    }
    const params = await this.params('root.IOPort');
    const ids = new Set();
    for (const key of Object.keys(params)) {
      const match = key.match(/^IOPort\.I(\d+)\./);
      if (match) {
        ids.add(match[1]);
      }
    }
    return [...ids]
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => {
        const at = (name) => params[`IOPort.I${id}.${name}`];
        const direction = at('Direction') === 'output' ? 'output' : 'input';
        const prefix = direction === 'output' ? 'Output' : 'Input';
        // Trig / Active: the physical state that means "active".
        const active = at(direction === 'output' ? 'Output.Active' : 'Input.Trig');
        return {
          id,
          direction,
          name: (at(`${prefix}.Name`) ?? '').trim(),
          state: null,
          normalState: active === 'closed' ? 'open' : active === 'open' ? 'closed' : null,
          configurable: at('Configurable') === 'yes',
        };
      });
  }

  /**
   * Which ports are active now, through port.cgi (old firmwares):
   * `port1=active` lines, ports numbered from 1 there.
   * @param {string[]} ids port ids ("0", "1"…)
   * @returns {Promise<Map<string, boolean>>}
   */
  async activePorts(ids) {
    if (ids.length === 0) {
      return new Map();
    }
    const list = ids.map((id) => Number(id) + 1).join(',');
    const text = await this.text(`/axis-cgi/io/port.cgi?checkactive=${list}`);
    const states = new Map();
    for (const [, number, state] of text.matchAll(/port(\d+)\s*=\s*(active|inactive)/gi)) {
      states.set(String(Number(number) - 1), state.toLowerCase() === 'active');
    }
    return states;
  }

  /**
   * Activate an output for `pulseMs` (then back to normal), or set it
   * active / inactive (`pulseMs` null). Sent once: never retried.
   */
  async setOutput(port, { active, pulseMs = null }) {
    if (this.apiVersion('io-port-management')) {
      const physical = (on) => (on === (port.normalState !== 'closed') ? 'closed' : 'open'); // active = not normal
      const sequence =
        pulseMs !== null
          ? [
              { state: physical(true), time: pulseMs },
              { state: physical(false), time: 0 },
            ]
          : [{ state: physical(active), time: 0 }];
      await this.api('/axis-cgi/io/portmanagement.cgi', 'setStateSequence', {
        params: { port: port.id, sequence },
      });
      return;
    }
    // port.cgi: `<n>:/` active, `<n>:\` inactive, `<n>:/<ms>\` a pulse.
    const number = Number(port.id) + 1;
    const action =
      pulseMs !== null ? `${number}:/${pulseMs}\\` : `${number}:${active ? '/' : '\\'}`;
    await this.text(`/axis-cgi/io/port.cgi?action=${encodeURIComponent(action)}`);
  }

  /** The lights of the Light Control API: `{ id, type, enabled, state }`. */
  async lights() {
    if (!this.apiVersion('light-control')) {
      return [];
    }
    const data = await this.api('/axis-cgi/lightcontrol.cgi', 'getLightInformation');
    return (Array.isArray(data.items) ? data.items : [])
      .filter((item) => typeof item?.lightID === 'string')
      .map((item) => ({
        id: item.lightID,
        type: String(item.lightType ?? ''),
        enabled: item.enabled !== false,
        state: Boolean(item.lightState),
      }));
  }

  async lightStatus(id) {
    const data = await this.api('/axis-cgi/lightcontrol.cgi', 'getLightStatus', {
      params: { lightID: id },
    });
    return Boolean(data.status);
  }

  async setLight(id, on) {
    await this.api('/axis-cgi/lightcontrol.cgi', on ? 'activateLight' : 'deactivateLight', {
      params: { lightID: id },
    });
  }

  /** The camera applications installed: `{ name, niceName, status }`. */
  async applications() {
    try {
      return parseApplications(await this.text('/axis-cgi/applications/list.cgi'));
    } catch (err) {
      if (err.kind === ERROR_KINDS.NO_API || err.kind === ERROR_KINDS.FORBIDDEN) {
        return [];
      }
      throw err;
    }
  }

  /** The configuration of a camera application (`objectanalytics`, `vmd`), null if absent. */
  async applicationConfiguration(name, apiVersion) {
    try {
      return await this.api(`/local/${name}/control.cgi`, 'getConfiguration', { apiVersion });
    } catch (err) {
      if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.BLOCKED) {
        throw err;
      }
      return null;
    }
  }

  /**
   * A JPEG of a video source (`camera` from 1), at a resolution the device
   * scales itself: Gladys takes 150 KB images.
   * @returns {Promise<Buffer>}
   */
  async snapshot(camera, { resolution = null, compression = 30, timeoutMs } = {}) {
    const query = new URLSearchParams({ camera: String(camera) });
    if (resolution) {
      query.set('resolution', resolution);
    }
    query.set('compression', String(compression));
    const response = await this.call('GET', `/axis-cgi/jpg/image.cgi?${query}`, { timeoutMs });
    if (response.status !== 200) {
      throw httpError(response.status);
    }
    return response.body ?? Buffer.alloc(0);
  }

  /** Play an audio clip stored on the device (its id, "0"…). */
  async playClip(id) {
    const text = await this.text(
      `/axis-cgi/mediaclip.cgi?action=play&clip=${encodeURIComponent(String(id))}`,
    );
    if (/error/i.test(text)) {
      throw new AxisError(ERROR_KINDS.REFUSED, 'The device refused to play the clip');
    }
  }

  /** A short-lived token opening the WebSocket event stream (15 s). */
  async wsSession() {
    return (await this.text('/axis-cgi/wssession.cgi')).trim();
  }
}
