// -----------------------------------------------------------------------------
// Finding the Axis devices of the network, through the core (mediated
// discovery, manifest `network_discovery`): the container sits on a bridge
// network that mDNS and SSDP never reach, so Gladys browses for it and hands
// over the raw answers, read here.
//   - mDNS `_axis-video._tcp`: the instance name is "AXIS M1065-LW -
//     00408C123456", the TXT record holds `macaddress=00408C123456`;
//   - SSDP `urn:axis-com:service:BasicService:1`: the USN holds the serial,
//     `uuid:Upnp-BasicDevice-1_0-00408C123456::urn:axis-com:…`.
// (Shapes from the Home Assistant axis tests.) The serial of an Axis device
// is its MAC address: it ties a found device to a configured one.
// -----------------------------------------------------------------------------

import { isIPv4 } from 'node:net';
import { parseMdnsTxt } from '@gladysassistant/integration-sdk';

// Answers kept per scan: a network has a few dozen Axis devices at most.
const MAX_CANDIDATES = 64;

const normalizeSerial = (text) => {
  const hex = String(text ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  return hex.length === 12 ? hex : null;
};

/** One candidate per serial, from `scanNetwork('mdns')`. */
export function mdnsCandidates(results) {
  const found = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const name = String(result?.name ?? '');
    if (!name.includes('_axis-video._tcp')) {
      continue;
    }
    const txt = parseMdnsTxt(Array.isArray(result.txt) ? result.txt : []);
    const instance = name.replace(/\._axis-video\._tcp.*$/, '');
    const serial = normalizeSerial(txt.macaddress) ?? normalizeSerial(instance.split(' - ').at(-1));
    const address = (Array.isArray(result.addresses) ? result.addresses : []).find((entry) =>
      isIPv4(entry),
    );
    if (!serial || !address || found.has(serial) || found.size >= MAX_CANDIDATES) {
      continue;
    }
    const port = Number(result.port);
    found.set(serial, {
      serial,
      name: instance.split(' - ')[0].trim() || `AXIS ${serial}`,
      address: port && port !== 80 ? `${address}:${port}` : address,
    });
  }
  return [...found.values()];
}

/** The headers of a raw SSDP answer, names lower-cased. */
export function parseSsdpHeaders(text) {
  const headers = {};
  for (const line of String(text ?? '')
    .split(/\r?\n/)
    .slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) {
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return headers;
}

/** One candidate per serial, from `scanNetwork('ssdp')`. */
export function ssdpCandidates(results) {
  const found = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const address = result?.source_ip;
    if (typeof address !== 'string' || !isIPv4(address)) {
      continue;
    }
    const headers = parseSsdpHeaders(result.headers);
    if (!/axis-com/i.test(`${headers.usn ?? ''} ${headers.st ?? ''}`)) {
      continue;
    }
    const serial = normalizeSerial(headers.usn?.match(/BasicDevice-1_0-([0-9a-f:-]{12,17})/i)?.[1]);
    if (!serial || found.has(serial) || found.size >= MAX_CANDIDATES) {
      continue;
    }
    found.set(serial, { serial, name: `AXIS ${serial}`, address });
  }
  return [...found.values()];
}

/** The two lists merged: the mDNS name wins, it names the model. */
export function mergeCandidates(...lists) {
  const merged = new Map();
  for (const candidate of lists.flat()) {
    if (!merged.has(candidate.serial)) {
      merged.set(candidate.serial, candidate);
    }
  }
  return [...merged.values()].sort((a, b) => a.address.localeCompare(b.address));
}
